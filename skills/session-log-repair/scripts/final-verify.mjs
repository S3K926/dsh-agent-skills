// 最终校验: header id 必须与所在目录名一致 (后端身份绑定), seq 连续
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
    return { first: parsed.seq0, last: parsed.seq0 + n - 1 };
  }
  if (t === "tool-call-chunks") {
    const n = Array.isArray(parsed.data?.args) ? parsed.data.args.length : 0;
    return { first: parsed.seq0, last: parsed.seq0 + n - 1 };
  }
  if (typeof parsed.seq === "number") return { first: parsed.seq, last: parsed.seq };
  return null;
}

for (const file of process.argv.slice(2)) {
  const dirName = basename(dirname(file));
  const buf = readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(buf);
  if (tornStart !== undefined) throw new Error(`${file}: 未完成尾帧`);
  const plains = frames.map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)));
  const hf = plains[0];
  if (hf.indexOf(10) !== hf.length - 1) throw new Error(`${file}: header 帧异常`);
  const header = JSON.parse(hf.subarray(0, -1).toString("utf8"));
  if (header.type !== "session" || header.id !== dirName)
    throw new Error(`${file}: id 绑定失败 header.id=${header.id} dir=${dirName}`);
  const lines = Buffer.concat(plains).toString("utf8").split("\n");
  let expected = 0;
  let turns = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      if (i !== lines.length - 1) throw new Error(`${file}: 中间空行`);
      break;
    }
    const p = JSON.parse(line);
    const s = seqsOfLine(p);
    if (!s) throw new Error(`${file}: 行 ${i + 1} 无 seq`);
    if (s.first !== expected) throw new Error(`${file}: seq 空洞 @行${i + 1} expected ${expected} got ${s.first}`);
    expected = s.last + 1;
    if (p.type === "turn/end") turns += 1;
  }
  console.log(`${dirName}: 通过 (${frames.length} 帧, ${expected} 事件 0..${expected - 1}, ${turns} 个 turn/end)`);
}
console.log("=== 全部通过 ===");
