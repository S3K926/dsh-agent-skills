#!/usr/bin/env node
/**
 * DSH Web GUI 一键全链路健康检查（Node >= 22：内置 fetch / net / crypto）。
 *
 * 用法:
 *   node healthcheck.mjs [baseUrl] [--port <n>] [--token <t>] [--cookie <c>]
 *                        [--from-credentials] [--timeout <ms>]
 *
 *   baseUrl 省略时按序取 $DSH_WEB_URL、http://127.0.0.1:3080（`dsh web` 默认端口）。
 *   桌面版（DeepSeek Harness.exe）端口是随机分配的（例：19387），用 --port 或直接给 baseUrl。
 *
 * 认证（新版 GUI 的 /api 与事件通道都要；静态资源公开）:
 *   --token <t>          启动 URL 里的 ?token=…（`dsh web` 会打印带 token 的 URL）
 *   --cookie <c>         浏览器 DevTools 里复制的 Cookie 头（形如 dsh-auth-xxxx=v1.…）
 *   --from-credentials   本机自用：读 $DSH_HOME/.credentials.yaml 里
 *                        client-connection/browser-session 的签名密钥，现场签发一枚 1 小时
 *                        有效的本机 Cookie（不落盘、不打印）。仅限本机 127.0.0.1 诊断。
 *   优先级 --cookie > --token > --from-credentials；都没给且服务端要认证时输出 [AUTH] 指引
 *   并以退出码 2 结束（401 是"没带凭据"，不等于服务端故障）。
 *
 * 检查项:
 *   1. GET / 页面（200 且含 __ModuleLoader__（新版）或 __DSH_BOOT__（旧版））
 *   2. 页面声明的全部前端资源（assets / plugins / manifest / favicon）HTTP 200
 *   3. 后端 RPC（自动识别两种构建，先探针后断言）:
 *        新版桌面/typert 网关: POST /api/<namespace>/<method>，信封 payload={"args":{…}}
 *                              session/list(args._request) · session/create(args.request)
 *                              · workspace/archiveSession(args.request)
 *        旧版 `dsh web`:       POST /api/<method>，payload 直接是业务字段
 *                              session.list · session.create · workspace.archiveSession
 *      create 用空白会话做端到端验证，随后自动归档清理
 *   4. 事件通道（原始 TCP 做 WebSocket 握手，可带 Cookie）:
 *        新版 /api/remote.mux（101 升级 + 收到帧）
 *        旧版 /api/events.mux（101+帧）、/api/events.host（101）
 *
 * 退出码: 0 = 全绿；1 = 存在 FAIL；2 = 需要认证/无法认证。
 * 说明: 全部请求都带 connection: close，结束时用 process.exitCode 自然退出，
 *       避免 Windows 上 undici 长连接 + process.exit 触发的 libuv 断言崩溃。
 */
import net from 'node:net'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2)
let baseArg = null
let portArg = null
let token = null
let cookie = null
let fromCredentials = false
let TIMEOUT = 10000

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--token') token = argv[++i]
  else if (a === '--cookie') cookie = argv[++i]
  else if (a === '--port') portArg = argv[++i]
  else if (a === '--from-credentials') fromCredentials = true
  else if (a === '--timeout') TIMEOUT = Number(argv[++i])
  else if (a === '--help' || a === '-h') {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 36).map((l) => l.replace(/^ \*/, '')).join('\n'))
    process.exit(0)
  } else if (a.startsWith('-')) {
    console.error(`未知参数: ${a}（--help 看用法）`)
    process.exit(64)
  } else baseArg = a
}

const base = (baseArg ?? (portArg ? `http://127.0.0.1:${portArg}` : null) ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')

const passed = []
const failed = []
const notes = []

const ok = (label) => { passed.push(label); console.log(`[PASS] ${label}`) }
const bad = (label, detail) => {
  failed.push(label)
  console.log(`[FAIL] ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const note = (label) => { notes.push(label); console.log(`[note] ${label}`) }

// ------------------------------------------------------- 认证凭据解析

const base64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/** 从 $DSH_HOME/.credentials.yaml 读出 browser-session 的签名密钥（只做本文件所需的最小解析）。 */
function readBrowserSessionSecret() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, '.credentials.yaml')
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { throw new Error(`读不到 ${file}: ${e.message}`) }
  const lines = text.split(/\r?\n/)
  const keyAt = lines.findIndex((l) => l.includes('client-connection/browser-session'))
  if (keyAt === -1) throw new Error(`${file} 里没有 client-connection/browser-session 记录`)
  const indent = lines[keyAt].search(/\S/)
  for (let i = keyAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (line.search(/\S/) <= indent) break
    const m = line.match(/^\s*secret:\s*["']?([A-Za-z0-9_-]{20,})["']?\s*$/)
    if (m) return m[1]
  }
  throw new Error(`${file} 的 browser-session 记录里没有 secret 字段`)
}

/** 按 DSH 的 Cookie 规则（v1.<base64url(payload)>.<hmac>）现场签一枚短期本机 Cookie。 */
function mintCookie(authority, secretB64url) {
  const secret = Buffer.from(secretB64url.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (secret.byteLength !== 32) throw new Error(`签名密钥长度异常: ${secret.byteLength} 字节（期望 32）`)
  const issuedAt = Date.now() - 1000
  const expiresAt = issuedAt + 60 * 60 * 1000 // 1 小时，短于任何合理的 cookieMaxAgeDays（默认 30 天）
  const body = base64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const signature = base64url(createHmac('sha256', secret).update(body).digest())
  const name = `dsh-auth-${base64url(createHash('sha256').update(authority).digest())}`
  return `${name}=v1.${body}.${signature}`
}

let authCookie = cookie
let authSource = cookie ? '--cookie' : null

if (!authCookie && token) {
  try {
    const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', headers: { connection: 'close' }, signal: AbortSignal.timeout(TIMEOUT) })
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean)
    const value = raw.map((s) => s.split(';')[0]).join('; ')
    if (res.status === 303 && value !== '') { authCookie = value; authSource = '--token 换取的 Cookie' }
    else note(`--token 换取 Cookie 失败（HTTP ${res.status}），改为匿名检查`)
  } catch (e) {
    note(`--token 换取 Cookie 出错: ${e.message}`)
  }
}

if (!authCookie && fromCredentials) {
  try {
    authCookie = mintCookie(new URL(base).host, readBrowserSessionSecret())
    authSource = '--from-credentials 现场签发的 Cookie（1 小时有效）'
  } catch (e) {
    note(`--from-credentials 失败: ${e.message}`)
  }
}

const authHeaders = () => (authCookie ? { cookie: authCookie } : {})
const get = (path) => fetch(`${base}${path}`, { headers: { ...authHeaders(), connection: 'close' }, signal: AbortSignal.timeout(TIMEOUT) })

console.log(`# DSH Web GUI healthcheck @ ${base}  (${new Date().toISOString()})`)
console.log(authCookie ? `# 认证: ${authSource}\n` : '# 认证: 无（静态资源公开，/api 与事件通道需要 Cookie）\n')

// ---------------------------------------------------------------- 1. 页面

let html = ''
let needsAuth = false
try {
  const res = await get('/')
  html = await res.text()
  if (res.status === 401) needsAuth = true
  else if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  else if (html.includes('__ModuleLoader__')) ok('GET / → 200（新版壳：含 __ModuleLoader__）')
  else if (html.includes('__DSH_BOOT__')) ok('GET / → 200（旧版壳：含 __DSH_BOOT__）')
  else throw new Error('页面既没有 __DSH_BOOT__ 也没有 __ModuleLoader__')
} catch (e) {
  bad('GET /', `${e.message}${base.includes(':3080') ? '（3080 是 CLI 默认端口；桌面版端口随机，用 --port 指定）' : ''}`)
}

if (needsAuth) {
  note('GET / → HTTP 401（需要认证，属正常防护，不计为失败）')
  console.log(`
[AUTH] ${base} 要求浏览器会话认证（HTTP 401），本次只能做匿名检查。
       静态资源公开，但 /api 与事件通道必须带 Cookie。三条路任选一条：
         1) node healthcheck.mjs ${base} --from-credentials              # 本机自用：读本机密钥现签 1 小时 Cookie
         2) node healthcheck.mjs ${base} --cookie "dsh-auth-xxxx=v1.…"   # F12 → Application → Cookies 里复制
         3) node healthcheck.mjs ${base} --token "<启动 URL 里的 token>"  # dsh web 打印的带 token URL
       注意：401 是"没带凭据"，不等于服务端故障；不要据此判定后端挂掉。`)
  console.log(`\n=== ${passed.length} 项通过, ${failed.length} 项失败, 其余因认证缺失跳过 ===`)
  process.exitCode = 2
} else {

// ------------------------------------------------------------ 2. 前端资源

if (html !== '') {
  const urls = new Set()
  const bootMatch = html.match(/window\.__DSH_BOOT__\s*=\s*(\{.*?\})<\/script>/s)
  if (bootMatch) {
    try {
      for (const entry of JSON.parse(bootMatch[1]).entries ?? []) {
        if (typeof entry.url === 'string' && entry.url.startsWith('/')) urls.add(entry.url)
      }
    } catch (e) {
      note(`__DSH_BOOT__ 解析失败: ${String(e)}`)
    }
  }
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const raw = m[1].replaceAll('&amp;', '&').replace(/^\.\//, '')
    if (/^(assets|plugins|manifest|favicon)/.test(raw) || raw.includes('.webmanifest')) urls.add(raw)
  }
  let assetFails = 0
  for (const u of urls) {
    try {
      const res = await get(`/${u.replace(/^\.?\//, '')}`)
      if (res.status !== 200) { assetFails += 1; console.log(`[FAIL] asset ${u.slice(0, 80)} → HTTP ${res.status}`) }
    } catch (e) {
      assetFails += 1
      console.log(`[FAIL] asset ${u.slice(0, 80)} → ${String(e)}`)
    }
  }
  if (assetFails === 0) ok(`前端资源 ${urls.size} 项全部 200`)
  else bad('前端资源', `${assetFails}/${urls.size} 项失败`)
} else {
  note('页面未取到，跳过前端资源清单核对')
}

// ---------------------------------------------------------------- 3. RPC

/**
 * 两种构建的 RPC 形态。新版 = 桌面/typert 网关（POST /api/<namespace>/<method>，
 * payload={"args":{…}}）；旧版 = `dsh web`（POST /api/<method>，payload 直接是业务字段）。
 */
const STYLES = [
  {
    name: '新版 typert 网关（桌面版 / 新 dsh web）',
    list: { endpoint: 'session/list', payload: { args: { _request: {} } } },
    create: { endpoint: 'session/create', payload: { args: { request: {} } } },
    archive: (sid) => ({ endpoint: 'workspace/archiveSession', payload: { args: { request: { sessionId: sid } } } }),
    mux: [{ path: '/api/remote.mux', expectFrame: true }],
  },
  {
    name: '旧版 dsh web',
    list: { endpoint: 'session.list', payload: {} },
    create: { endpoint: 'session.create', payload: {} },
    archive: (sid) => ({ endpoint: 'workspace.archiveSession', payload: { sessionId: sid } }),
    mux: [{ path: '/api/events.mux', expectFrame: true }, { path: '/api/events.host', expectFrame: false }],
  },
]

async function rpc(endpoint, payload) {
  const rpcId = randomUUID()
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(), connection: 'close' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (body.rpcId !== undefined && body.rpcId !== rpcId) throw new Error(`rpcId 不匹配（发出 ${rpcId}，收到 ${body.rpcId}）`)
  return body.result
}

let style = null
const detectErrors = []
for (const candidate of STYLES) {
  try {
    const result = await rpc(candidate.list.endpoint, candidate.list.payload)
    if (result?.ok) { style = candidate; ok(`RPC ${candidate.list.endpoint}（识别为${candidate.name}）`); break }
    detectErrors.push(`${candidate.list.endpoint}: ${JSON.stringify(result?.error ?? result).slice(0, 160)}`)
  } catch (e) {
    detectErrors.push(`${candidate.list.endpoint}: ${String(e)}`)
  }
}
if (style === null) bad('RPC 会话列表（两种构建都没通过）', detectErrors.join(' ; '))

if (style !== null) {
  try {
    const created = await rpc(style.create.endpoint, style.create.payload)
    if (!created?.ok) {
      bad(`RPC ${style.create.endpoint}`, JSON.stringify(created?.error ?? created).slice(0, 200))
    } else {
      const sid = created.value?.sessionId ?? created.value?.id
      if (typeof sid !== 'string') {
        bad(`RPC ${style.create.endpoint}`, `返回里没有 sessionId: ${JSON.stringify(created.value).slice(0, 160)}`)
      } else {
        note(`端到端验证创建了测试会话 ${sid}`)
        const target = style.archive(sid)
        const archived = await rpc(target.endpoint, target.payload)
        if (archived?.ok) ok(`RPC ${style.create.endpoint}（测试会话 ${sid.slice(0, 13)}… 已自动归档清理）`)
        else {
          ok(`RPC ${style.create.endpoint}`)
          bad(`清理测试会话 ${target.endpoint}`, JSON.stringify(archived?.error ?? archived).slice(0, 200))
        }
      }
    }
  } catch (e) {
    bad(`RPC ${style.create.endpoint}`, String(e))
  }
}

// ------------------------------------------------------------ 4. 事件通道

/** 原始 TCP 做 WebSocket 握手（可带 Cookie）：101 = 通道已注册并升级成功。 */
function wsProbe(path, { expectFrame = false, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const url = new URL(base)
    const key = randomBytes(16).toString('base64')
    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...(authCookie ? [`Cookie: ${authCookie}`] : []),
      '', '',
    ].join('\r\n')

    const socket = net.connect({ host: url.hostname, port: Number(url.port !== '' ? url.port : 80) })
    let buffer = Buffer.alloc(0)
    let status = null
    let settled = false

    const finish = (pass, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolve({ pass, detail })
    }
    const timer = setTimeout(() => {
      if (status === null) return finish(false, `timeout ${timeoutMs}ms：TCP 已连但未返回升级响应`)
      if (!expectFrame) return finish(true)
      finish(false, `101 已升级但 ${timeoutMs}ms 内没有收到事件帧`)
    }, timeoutMs)

    socket.on('connect', () => socket.write(request))
    socket.on('error', (e) => finish(false, `socket error: ${e.message}`))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const at = buffer.indexOf('\r\n\r\n')
      if (at === -1) return
      const head = buffer.subarray(0, at).toString('latin1')
      const rest = buffer.subarray(at + 4)
      const statusLine = head.split('\r\n')[0] ?? ''
      if (status === null) {
        status = statusLine
        if (!/\s101\s/.test(statusLine)) {
          const hint = / 401 /.test(statusLine)
            ? '（401：事件通道要 Cookie，加 --cookie / --from-credentials）'
            : / 426 /.test(statusLine)
              ? '（426：服务端没把该路径当 WebSocket 通道注册）'
              : / 404 /.test(statusLine)
                ? '（404：该路径不存在，可能不是这种构建）'
                : ''
          return finish(false, `${statusLine}${hint}`)
        }
        if (!expectFrame) return finish(true)
      }
      if (rest.length > 0) return finish(true)
    })
    socket.on('close', () => finish(false, status === null ? 'upgrade 前连接被关闭' : '升级后连接被对端关闭且未收到帧'))
  })
}

if (style !== null) {
  for (const probe of style.mux) {
    const r = await wsProbe(probe.path, probe)
    r.pass ? ok(`事件通道 ${probe.path}：101 升级成功${probe.expectFrame ? '且收到帧' : ''}`) : bad(`事件通道 ${probe.path}`, r.detail)
  }
} else {
  note('RPC 构建未识别，跳过事件通道检查')
}

// ---------------------------------------------------------------- 汇总

console.log(`\n=== ${passed.length} 项通过, ${failed.length} 项失败 ===`)
for (const n of notes) console.log(`[note] ${n}`)
if (failed.length > 0) {
  console.log('服务端存在故障，按 SKILL.md 第 3 条逐层定位。')
  process.exitCode = 1
} else {
  console.log('服务端全链路健康。若用户仍报"新建会话无反应"，按 SKILL.md 第 2 条：先让用户 Ctrl+F5 强刷。')
  process.exitCode = 0
}
}
