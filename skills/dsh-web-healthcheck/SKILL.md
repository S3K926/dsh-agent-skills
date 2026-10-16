---
name: dsh-web-healthcheck
description: |-
  DSH Web GUI 健康检查与"界面无反应"类问题诊断（桌面版随机端口 / dsh web 默认 3080）。当用户反馈 无法新建会话、新建会话按钮点了没反应、页面白屏/卡住、会话列表不更新、重启 harness 后界面异常，或任何 Web 界面疑似故障时使用。含一键全链路自检脚本（页面与前端资源 / 后端 RPC / 事件通道 / 会话创建回滚验证）与"服务端全绿 → 浏览器陈旧标签页 → Ctrl+F5"的判定流程。
whenToUse: |-
  用户说"新建会话失败/没反应""界面打不开""页面卡住""按钮点了没动静"等 GUI 症状时自动执行。
---

# DSH Web GUI 健康检查（dsh-web-healthcheck）

## 触发特征
- 用户反馈：无法建立新的会话、点"新建会话"完全没反应、页面白屏或一直转圈、会话列表不更新
- 常见时间点：harness（`dsh web` / 桌面应用 `DeepSeek Harness.exe`）重启之后

## 背景（先懂架构，再动手）
- 前端是浏览器内运行的 SPA + 插件包，入口形如 `http://127.0.0.1:<port>`
  - `dsh web`（CLI）：默认 **3080**
  - 桌面版 `DeepSeek Harness.exe`：端口**随机分配**（例：19387），`Get-NetTCPConnection -State Listen` 或问用户拿实际 URL
- **认证（新版 GUI 必看）**：静态资源公开，`/api` 与事件通道必须带浏览器会话 Cookie
  - `GET /?token=<启动token>` 会 303 到 `./` 并下发 `dsh-auth-<hash(host:port)>=v1.<payload>.<hmac>`（HttpOnly，SameSite=Strict，默认 30 天）
  - 因此**裸 `curl`/脚本拿到的 401 是"没带凭据"，不是服务端故障**；别据此判定后端挂掉
  - 自检脚本三条取凭据的路：`--from-credentials`（本机读 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 密钥现签 1 小时 Cookie）、`--cookie`（DevTools 复制）、`--token`（带 token 的启动 URL）
- **两代构建的协议差异**（脚本会自动识别，人工排查时别记错）：
  | | 新版（桌面版 / 新 dsh web，typert 网关） | 旧版 `dsh web` |
  |---|---|---|
  | 页面标记 | `__ModuleLoader__` | `window.__DSH_BOOT__` |
  | RPC 路径 | `POST /api/<namespace>/<method>`，如 `session/list`、`session/create`、`workspace/archiveSession` | `POST /api/<method>`，如 `session.list`、`session.create`、`workspace.archiveSession` |
  | RPC 信封 | `{"type":"client-request","rpcId","method","payload":{"args":{<wire名>:…}}}`（`session/list` 用 `_request`，`session/create`/`workspace/archiveSession` 用 `request`） | 同信封，但 `payload` 直接是业务字段 |
  | 事件通道 | `ws://…/api/remote.mux`（唯一 WS 路由，101 后推帧） | `/api/events.mux`、`/api/events.host`（普通 GET 返回 426 = 已注册，正常） |
  content-type 必须是 `application/json`（两种构建一致）
- **关键认知**：侧边栏"新建会话"按钮失败时，前端只在 console 打 `new session failed`，
  界面上没有任何提示——"点了没反应"通常是**前端本地失败**，不代表后端拒绝了请求

## 诊断流程（按顺序执行）
1. **一键自检**：`node scripts\healthcheck.mjs [baseUrl] [--port N] [--from-credentials|--cookie C|--token T]`
   （baseUrl 省略时默认 `http://127.0.0.1:3080`；桌面版必须显式给端口 + 凭据，例：
   `node scripts\healthcheck.mjs http://127.0.0.1:19387 --from-credentials`）
   逐项输出 PASS/FAIL。**退出码：0 = 全绿；1 = 有 FAIL（服务端故障）；2 = 需要认证/凭据无效**。覆盖：
   - `GET /` 页面与壳标记（`__ModuleLoader__` 新版 / `__DSH_BOOT__` 旧版）
   - 页面声明的全部前端资源（`assets/*`、`plugins/??…`、`manifest`、`favicon`）HTTP 200
   - RPC：自动识别两代构建后验 `session/list` + `session/create` + 归档清理（旧版为 `session.list` 系列）
   - 事件通道：新版 `/api/remote.mux`（101+帧），旧版 `/api/events.mux`（101+帧）与 `/api/events.host`（101）
   - 脚本会创建一个空白测试会话验证创建链路，随后自动归档清理，不留垃圾
   - 拿不到凭据时（HTTP 401）不会误报故障：打印 `[AUTH]` 指引并以退出码 2 结束
2. **全绿时**：服务端可认定健康。第一嫌疑 = **浏览器陈旧标签页**：harness 重启后，重启前打开的
   标签页内存里仍是旧版前端 JS，与当前服务端不匹配，点"新建会话"静默失败
   - 让用户 `Ctrl+F5` 强制刷新（或关掉标签重开 URL）再试——这一步多数直接恢复
   - 仍失败：让用户按 F12 打开 Console，再点一次"新建会话"，把红色报错原文拿回来继续排查
     （此时才是真正的前端运行时错误，需要具体报错定位，不要瞎猜）
3. **有 FAIL 项时**：按失败层定位，不要跳步：
   - 页面/资源失败 → 查服务进程与端口：`Get-NetTCPConnection -State Listen`（桌面版端口随机，
     别再假定 3080）；多个 harness/node 实例并存 = 隐患（见安全规则）
   - 会话相关失败 → 用 `session-log-repair` 技能的 `scan-all.mjs` 扫描
     `%USERPROFILE%\.dsh\sessions`（覆盖 `session.jsonl.zstd` / `session.v4.jsonl.zstd`）是否有日志损坏
   - WS 失败但 HTTP 正常 → 查事件通道路径是否与构建匹配（新版只有 `/api/remote.mux`）
   - 自检全绿但仍异常 → 回到第 2 条，浏览器侧排查
4. **结论规则**：先证据后断言。每一层都要有实测输出支撑（HTTP 状态码、RPC 响应、升级帧），
   不要凭"看起来正常"跳过任何一层

## 安全规则
- 不要未征得用户同意就重启 harness / kill 进程
- 重启前必须确认旧实例真的退出（本机有过 taskkill 拒绝访问、新旧实例并存导致会话日志损坏的前科）
- 诊断产生的测试会话必须清理（脚本已自动 archive）
- `--from-credentials` 会读本机 `.credentials.yaml` 的签名密钥并只在内存里签一枚 1 小时 Cookie：
  仅限本机 127.0.0.1 诊断，不要打印 Cookie、不要写入磁盘、不要用于远程主机
- 浏览器侧问题不要通过改服务端代码去"绕过"
- 给用户的结论和链接都要实测验证过

## 已修复案例
- 2026-08-17：点"新建会话"完全没反应。全链路自检全绿（单进程/日志无损坏/RPC/WS/资源全部实测通过）；
  根因 = 02:30 重启残留 + 02:52 新实例接管，浏览器标签页仍跑重启前的旧前端，按钮静默失败。
  处理：用户 Ctrl+F5 强刷即恢复，服务端零改动。
- 2026-10-01：桌面版把 GUI 挪到随机端口 19387 并要求 Cookie 认证，旧脚本（固定 3080、无认证、
  旧协议 `/api/session.list` + `/api/events.mux`、undici WebSocket 会在退出时触发 libuv 断言崩溃）
  全部误报 FAIL。重写后支持两代协议自动识别 + 三种取凭据方式，实测全绿（退出码 0，无崩溃）。
