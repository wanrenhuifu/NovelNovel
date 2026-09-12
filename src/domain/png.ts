/**
 * 极简 PNG 工具：chunk 读取/重组（含 CRC32）、tEXt 编解码、生成纯色占位 PNG。
 * 用于角色卡导入时的 chunk 过滤与导出时的 chara/ccv3 双写。
 */

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

/** 按顺序拆出全部 chunk（不含签名），损坏数据会抛错 */
export function readPngChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new Error("不是有效的 PNG 文件");
  const chunks: PngChunk[] = [];
  let offset = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const data = bytes.slice(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  if (chunks.length === 0 || chunks[chunks.length - 1].type !== "IEND") {
    throw new Error("PNG 缺少 IEND chunk，文件不完整");
  }
  return chunks;
}

export function writePng(chunks: PngChunk[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [SIGNATURE];
  for (const chunk of chunks) {
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    view.setUint32(0, chunk.data.length);
    for (let i = 0; i < 4; i++) header[4 + i] = chunk.type.charCodeAt(i);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(concat(header, chunk.data)));
    parts.push(header, chunk.data, crc);
  }
  return concat(...parts);
}

function concat(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** 构造 tEXt chunk：keyword\0text（Latin-1 段） */
export function makeTextChunk(keyword: string, text: string): PngChunk {
  const keyBytes = new TextEncoder().encode(keyword);
  const textBytes = new TextEncoder().encode(text);
  const data = concat(keyBytes, new Uint8Array([0]), textBytes);
  return { type: "tEXt", data };
}

/** 解析 tEXt chunk 为 {keyword, text}，非 tEXt 返回 null */
export function parseTextChunk(chunk: PngChunk): { keyword: string; text: string } | null {
  if (chunk.type !== "tEXt") return null;
  const sep = chunk.data.indexOf(0);
  if (sep < 0) return null;
  const decoder = new TextDecoder("utf-8");
  return {
    keyword: decoder.decode(chunk.data.slice(0, sep)),
    text: decoder.decode(chunk.data.slice(sep + 1)),
  };
}

/** 原生 deflate-raw 压缩（Node 18+ 的 CompressionStream） */
async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 生成纯色 PNG 作为无头像角色卡的占位图 */
export async function makeSolidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Promise<Uint8Array<ArrayBuffer>> {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const row = new Uint8Array(1 + width * 4);
  for (let x = 0; x < width; x++) {
    row[1 + x * 4] = rgba[0];
    row[2 + x * 4] = rgba[1];
    row[3 + x * 4] = rgba[2];
    row[4 + x * 4] = rgba[3];
  }
  const raw = new Uint8Array(height * row.length);
  for (let y = 0; y < height; y++) raw.set(row, y * row.length);
  const idat = await deflateRaw(raw);
  return writePng([
    { type: "IHDR", data: ihdr },
    { type: "IDAT", data: idat },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
}
