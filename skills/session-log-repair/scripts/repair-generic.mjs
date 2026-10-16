// 通用修复：删除过期写入者的重叠事件行，重建 zstd 帧。
// 用法: node repair-generic.mjs <文件> <删除范围: "s-e" 或 "s-e,s-e,..." 1-based 含端点> <期望最后seq>
// 自动备份原文件到本技能目录 backup\，删除后重扫断言 seq 连续，最后原子替换。
import { readFileSync, writeFileSync, renameSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bakDir = join(scriptDir, "..", "backup");

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
const rangeSpec = process.argv[3];
const expectLastSeq = Number(process.argv[4]);
if (!file || !rangeSpec || !Number.isFinite(expectLastSeq)) {
  console.error("用法: node repair-generic.mjs <文件> <删除范围s-e,...> <期望最后seq>");
  process.exit(1);
}

// 解析删除范围 (1-based 行号, 含端点)
const ranges = rangeSpec.split(",").map((r) => {
  const [a, b] = r.split("-").map(Number);
  return { s: a, e: b ?? a };
});
const toDelete = new Set();
for (const r of ranges) for (let i = r.s; i <= r.e; i++) toDelete.add(i);
console.log(`删除行号: ${[...toDelete].join(",")} (共 ${toDelete.size} 行)`);

// 备份
mkdirSync(bakDir, { recursive: true });
const name = file.split(/[\\/]/).filter(Boolean).slice(-1)[0];
const bakPath = join(bakDir, `${name}.${Date.now()}.bak`);
copyFileSync(file, bakPath);
console.log(`已备份: ${bakPath}`);

const buf = readFileSync(file);
const { frames, tornStart } = scanZstdFrames(buf);
if (tornStart !== undefined) throw new Error("存在未完成尾帧，请先按 SKILL.md 分析");
const plains = frames.map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)));
const lines = Buffer.concat(plains).toString("utf8").split("\n");
console.log(`原行数: ${lines.length}, 帧数: ${frames.length}`);

// 构造新行集合
const keep = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].length === 0 && i === lines.length - 1) break; // 末尾空串
  if (!toDelete.has(i + 1)) keep.push(lines[i]);
}
console.log(`保留行数: ${keep.length}`);

// 校验: header 完整 + 全量重扫 seq 连续
let h;
try { h = JSON.parse(keep[0]); } catch { throw new Error("header 解析失败"); }
if (h.type !== "session") throw new Error("header 异常");
let expected = 0;
for (let i = 1; i < keep.length; i++) {
  const p = JSON.parse(keep[i]);
  const s = seqsOfLine(p);
  if (!s) throw new Error(`保留行 ${i + 1} 无 seq (type=${p.type})`);
  if (s.first !== expected) throw new Error(`seq 空洞: 期望 ${expected} 实际 ${s.first} (type=${p.type})`);
  expected = s.last + 1;
}
console.log(`重扫通过: 0..${expected - 1} 连续, 共 ${expected} 个事件`);
if (expected - 1 !== expectLastSeq) throw new Error(`最后 seq ${expected - 1} != 期望 ${expectLastSeq}`);

// 重建帧
const checksumKey = constants.ZSTD_c_checksumFlag;
const opts = { params: { [checksumKey]: 1 } };
const parts = [zstdCompressSync(Buffer.from(keep[0] + "\n", "utf8"), opts)];
const BATCH = 150;
for (let i = 1; i < keep.length; i += BATCH) {
  parts.push(zstdCompressSync(Buffer.from(keep.slice(i, i + BATCH).join("\n") + "\n", "utf8"), opts));
}
const out = Buffer.concat(parts);
const tmp = file + ".repair.tmp";
writeFileSync(tmp, out);
renameSync(tmp, file);
console.log(`写入完成: ${out.length} 字节 (${parts.length} 帧), 原 ${buf.length} 字节`);
