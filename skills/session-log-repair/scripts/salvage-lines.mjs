// 把一条日志里的某段行范围另存为一个"新会话"（用于修复时的抢救：
// 同一文件里被并发写入者拼进了两条真实时间线，其中一条必须让位）。
// 规则：只改 header 里的 id（必须等于新目录名），事件行原样保留、绝不重编号 seq。
// 用法: node salvage-lines.mjs <源日志> <保留行范围 "s-e,..." 1-based 含端点> [新会话id] [--out <会话根目录>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";

const ZSTD_MAGIC = 4247762216;
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, tornStart: undefined };
}

function seqsOfLine(parsed) {
  const t = parsed.type;
  if (t === "text-chunks" || t === "reasoning-chunks") {
    const n = Array.isArray(parsed.data?.texts) ? parsed.data.texts.length : 0;
    return { first: parsed.seq0, last: parsed.seq0 + n - 1 };
  }
  if (t === "tool-call-chunks") {
    const n = Array.isArray(parsed.data?.args) ? parsed.data.args.length : 0;
    return { first: parsed.seq0, last: parsed.seq0 + n - 1 };
  }
  if (typeof parsed.seq === "number") return { first: parsed.seq, last: parsed.seq };
  return null;
}

const [src, rangeSpec, ...rest] = process.argv.slice(2);
if (!src || !rangeSpec) {
  console.error('用法: node salvage-lines.mjs <源日志> <保留行范围 "s-e,..."> [新会话id] [--out <会话根目录>]');
  process.exit(1);
}
let newId = null;
let outRoot = null;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--out") outRoot = rest[++i];
  else if (newId === null) newId = rest[i];
}
newId ??= `session-${randomUUID()}`;
if (!/^session-[0-9a-f-]{36}$/.test(newId)) throw new Error(`新会话 id 形如 session-<uuid>，收到 ${newId}`);

const keep = new Set();
for (const r of rangeSpec.split(",")) {
  const [a, b] = r.split("-").map(Number);
  const end = b ?? a;
  if (!Number.isFinite(a) || !Number.isFinite(end) || a < 2 || end < a) throw new Error(`行范围非法: ${r}（行号 1-based，且 ≥2，header 行自动保留）`);
  for (let i = a; i <= end; i++) keep.add(i);
}

const file = resolve(src);
const buf = readFileSync(file);
const { frames, tornStart } = scanZstdFrames(buf);
if (tornStart !== undefined) throw new Error("源文件存在未完成尾帧，请先按 SKILL.md 分析");
const lines = Buffer.concat(frames.map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)))).toString("utf8").split("\n");
console.log(`源: ${file}\n原行数: ${lines.length}, 帧数: ${frames.length}, 另存行: ${keep.size} 行`);

// 组装新文件：header（改 id）+ 选中行
const header = JSON.parse(lines[0]);
if (header.type !== "session") throw new Error("首行不是 session header");
header.id = newId;
const out = [JSON.stringify(header)];
for (let i = 2; i <= lines.length; i++) {
  if (!keep.has(i)) continue;
  if (lines[i - 1].length === 0) continue;
  out.push(lines[i - 1]);
}

// 校验：另存出来的必须是 0..N-1 连续的一条独立时间线（否则说明选错了行范围）
let expected = 0;
for (let i = 1; i < out.length; i++) {
  const p = JSON.parse(out[i]);
  const s = seqsOfLine(p);
  if (!s) throw new Error(`另存行 ${i + 1} 无 seq (type=${p.type})`);
  if (s.first !== expected) throw new Error(`另存结果 seq 不连续: 期望 ${expected} 实际 ${s.first} — 行范围不是一条独立时间线`);
  expected = s.last + 1;
}
console.log(`另存时间线校验通过: 0..${expected - 1} 连续, 共 ${expected} 个事件`);

// 目标：默认放回同一项目目录（源日志所在会话目录的父目录）下的新会话目录
const projectDir = outRoot !== null ? resolve(outRoot) : dirname(dirname(file));
const targetDir = join(projectDir, newId);
if (existsSync(targetDir)) throw new Error(`目标目录已存在: ${targetDir}`);
mkdirSync(targetDir, { recursive: true });
const targetFile = join(targetDir, basename(file));

const checksumKey = constants.ZSTD_c_checksumFlag;
const opts = { params: { [checksumKey]: 1 } };
const parts = [zstdCompressSync(Buffer.from(out[0] + "\n", "utf8"), opts)];
const BATCH = 150;
for (let i = 1; i < out.length; i += BATCH) {
  parts.push(zstdCompressSync(Buffer.from(out.slice(i, i + BATCH).join("\n") + "\n", "utf8"), opts));
}
writeFileSync(targetFile, Buffer.concat(parts));
console.log(`已写出: ${targetFile} (${out.length - 1} 行事件, ${parts.length} 帧)`);
console.log(`校验: node final-verify.mjs "${targetFile}"`);
