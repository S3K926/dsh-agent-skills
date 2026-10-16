// 批量扫描所有会话日志，检测同类 seq 空洞损坏
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 4247762216;
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start, bad: `magic@${offset}` };
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) return { frames, tornStart: start, bad: `reserved-bit@${offset - 1}` };
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
      if (blockType === 3) return { frames, tornStart: start, bad: `reserved-block@${offset - 3}` };
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
    return { first: parsed.seq0, last: parsed.seq0 + n - 1, count: n };
  }
  if (t === "tool-call-chunks") {
    const n = Array.isArray(parsed.data?.args) ? parsed.data.args.length : 0;
    return { first: parsed.seq0, last: parsed.seq0 + n - 1, count: n };
  }
  if (typeof parsed.seq === "number") return { first: parsed.seq, last: parsed.seq, count: 1 };
  return null;
}

const root = process.argv[2];
// 会话日志文件名带格式代次：旧版 session.jsonl.zstd、v4 起 session.v4.jsonl.zstd …
// 必须匹配全部代次，否则新版日志会被整体漏掉。
const LOG_FILE = /^session(\.[0-9A-Za-z._-]+)?\.jsonl\.zstd$/;
const logs = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (LOG_FILE.test(e.name)) logs.push(p);
  }
}
walk(root);
const generations = new Map();
for (const log of logs) {
  const name = log.split(/[\\/]/).slice(-1)[0];
  generations.set(name, (generations.get(name) ?? 0) + 1);
}
console.log(`共发现 ${logs.length} 个会话日志（${[...generations].map(([n, c]) => `${n}: ${c}`).join(", ")}）`);

let badCount = 0;
for (const log of logs) {
  let buf;
  try { buf = readFileSync(log); } catch (err) { console.log(`[跳过] ${log}: ${err.message}`); continue; }
  if (buf.length === 0) continue;
  let res;
  try {
    const { frames, tornStart, bad } = scanZstdFrames(buf);
    if (bad) { console.log(`[异常] ${log}: 帧结构 ${bad}`); badCount++; continue; }
    if (tornStart !== undefined) { /* 尾帧未完成是正常的崩溃残留，后端会自动修复 */ }
    const plains = [];
    let decodeErr = null;
    for (const f of frames) {
      try { plains.push(zstdDecompressSync(buf.subarray(f.start, f.end))); }
      catch (err) { decodeErr = err; break; }
    }
    if (decodeErr) { console.log(`[异常] ${log}: 帧解压失败 ${decodeErr.message}`); badCount++; continue; }
    const lines = Buffer.concat(plains).toString("utf8").split("\n");
    let expected = 0;
    let gap = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) break;
      let p;
      try { p = JSON.parse(line); } catch { gap = `line ${i + 1} 无法解析`; break; }
      const s = seqsOfLine(p);
      if (!s) { gap = `line ${i + 1} 无 seq`; break; }
      if (s.first !== expected) { gap = `line ${i + 1} seq 空洞 (expected ${expected}, got ${s.first})`; break; }
      expected = s.last + 1;
    }
    if (gap) {
      console.log(`[损坏] ${log}: ${gap}`);
      badCount++;
    }
  } catch (err) {
    console.log(`[异常] ${log}: ${err.message}`);
    badCount++;
  }
}
console.log(badCount === 0 ? "=== 无其他损坏 ===" : `=== ${badCount} 个日志存在异常 ===`);
