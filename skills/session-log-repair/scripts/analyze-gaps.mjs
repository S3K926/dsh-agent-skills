// 分析单个日志的 seq 空洞: 打印全部空洞及其 ±10 行上下文
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

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
    return { first: parsed.seq0, last: parsed.seq0 + n - 1, count: n };
  }
  if (t === "tool-call-chunks") {
    const n = Array.isArray(parsed.data?.args) ? parsed.data.args.length : 0;
    return { first: parsed.seq0, last: parsed.seq0 + n - 1, count: n };
  }
  if (typeof parsed.seq === "number") return { first: parsed.seq, last: parsed.seq, count: 1 };
  return null;
}

const file = process.argv[2];
const buf = readFileSync(file);
const { frames } = scanZstdFrames(buf);
const plains = frames.map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)));
const lines = Buffer.concat(plains).toString("utf8").split("\n");

const rows = [];
let expected = 0;
const gaps = [];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (line.length === 0) break;
  let p;
  try { p = JSON.parse(line); } catch { rows.push({ line: i + 1, kind: "parse-fail" }); continue; }
  const s = seqsOfLine(p);
  if (!s) { rows.push({ line: i + 1, kind: "no-seq:" + p.type }); continue; }
  rows.push({ line: i + 1, kind: s.count > 1 ? "packed" : p.type, first: s.first, last: s.last, count: s.count });
  if (s.first !== expected) gaps.push({ line: i + 1, expected, got: s.first });
  expected = s.last + 1;
}
console.log(`文件: ${file}`);
console.log(`行数(含header): ${lines.length}, 事件总数: ${expected}`);
console.log(`空洞数: ${gaps.length}`);
for (const g of gaps.slice(0, 10)) {
  console.log(`\n>>> 空洞 @line ${g.line}: expected ${g.expected}, got ${g.got} (落后 ${g.expected - g.got})`);
  const from = Math.max(0, g.line - 11);
  const to = Math.min(rows.length - 1, g.line + 9);
  for (let j = from; j <= to; j++) {
    const r = rows[j];
    const seqStr = r.first === undefined ? "" : r.count > 1 ? `seq=${r.first}..${r.last}(${r.count})` : `seq=${r.first}`;
    console.log(`L${r.line} [${r.kind}] ${seqStr}`);
  }
}
// 尾部最后几行
console.log("\n=== 尾部最后 5 行 ===");
for (const r of rows.slice(-5)) {
  const seqStr = r.first === undefined ? "" : r.count > 1 ? `seq=${r.first}..${r.last}(${r.count})` : `seq=${r.first}`;
  console.log(`L${r.line} [${r.kind}] ${seqStr}`);
}
