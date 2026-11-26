export type StickerMeta = {
  packId: string;
  packName: string;
  author: string;
  emojis?: string[];
};

type Chunk = { type: string; data: Buffer };

export function parseWebpChunks(buf: Buffer): Chunk[] {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('arquivo não é WebP');
  }
  const chunks: Chunk[] = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const type = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) break;
    chunks.push({ type, data: Buffer.from(buf.subarray(dataStart, dataEnd)) });
    offset = dataEnd + (size % 2);
  }
  return chunks;
}

export function buildWebp(chunks: Chunk[]): Buffer {
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const header = Buffer.alloc(8);
    header.write(chunk.type, 0, 'ascii');
    header.writeUInt32LE(chunk.data.length, 4);
    parts.push(header, chunk.data);
    if (chunk.data.length % 2) parts.push(Buffer.from([0]));
  }
  const body = Buffer.concat(parts);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, body]);
}

function readVp8Canvas(data: Buffer): { width: number; height: number } {
  const start = data.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
  if (start < 0 || start + 7 > data.length) throw new Error('VP8 sem dimensão');
  return { width: data.readUInt16LE(start + 3) & 0x3fff, height: data.readUInt16LE(start + 5) & 0x3fff };
}

function readVp8lCanvas(data: Buffer): { width: number; height: number } {
  if (data[0] !== 0x2f || data.length < 5) throw new Error('VP8L inválido');
  const width = 1 + (((data[2] & 0x3f) << 8) | data[1]);
  const height = 1 + (((data[4] & 0x0f) << 10) | (data[3] << 2) | ((data[2] & 0xc0) >> 6));
  return { width, height };
}

function writeUint24LE(buf: Buffer, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
}

function exifPayload(meta: StickerMeta): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      'sticker-pack-id': meta.packId,
      'sticker-pack-name': meta.packName,
      'sticker-pack-publisher': meta.author,
      emojis: meta.emojis?.length ? meta.emojis : ['✨'],
    }),
    'utf8',
  );
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0x4949, 0);
  header[0] = 0x49;
  header[1] = 0x49;
  header[2] = 0x2a;
  header[3] = 0x00;
  header.writeUInt32LE(8, 4);
  header.writeUInt16LE(1, 8);
  header[10] = 0x41;
  header[11] = 0x57;
  header[12] = 0x07;
  header[13] = 0x00;
  header.writeUInt32LE(json.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, json]);
}

export function attachStickerExif(webp: Buffer, meta: StickerMeta): Buffer {
  const chunks = parseWebpChunks(webp).filter((chunk) => chunk.type !== 'EXIF');
  const vp8x = chunks.find((chunk) => chunk.type === 'VP8X');
  if (vp8x) {
    const data = Buffer.alloc(Math.max(10, vp8x.data.length));
    vp8x.data.copy(data);
    data[0] |= 0x08;
    vp8x.data = data.subarray(0, Math.max(10, vp8x.data.length));
  } else {
    const image = chunks.find((chunk) => chunk.type === 'VP8 ' || chunk.type === 'VP8L');
    if (!image) throw new Error('WebP sem quadro');
    const dim = image.type === 'VP8L' ? readVp8lCanvas(image.data) : readVp8Canvas(image.data);
    const flags = 0x08 | (chunks.some((chunk) => chunk.type === 'ALPH') ? 0x10 : 0) | (chunks.some((chunk) => chunk.type === 'ANIM') ? 0x02 : 0);
    const data = Buffer.alloc(10);
    data[0] = flags;
    writeUint24LE(data, 4, Math.max(0, dim.width - 1));
    writeUint24LE(data, 7, Math.max(0, dim.height - 1));
    chunks.unshift({ type: 'VP8X', data });
  }
  const exif = { type: 'EXIF', data: exifPayload(meta) };
  const xmpAt = chunks.findIndex((chunk) => chunk.type === 'XMP ');
  if (xmpAt >= 0) chunks.splice(xmpAt, 0, exif);
  else chunks.push(exif);
  return buildWebp(chunks);
}

export function readStickerExif(webp: Buffer): { packId?: string; packName?: string; author?: string } | null {
  const exif = parseWebpChunks(webp).find((chunk) => chunk.type === 'EXIF');
  if (!exif) return null;
  const text = exif.data.toString('utf8');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  const json = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  return {
    packId: typeof json['sticker-pack-id'] === 'string' ? json['sticker-pack-id'] : undefined,
    packName: typeof json['sticker-pack-name'] === 'string' ? json['sticker-pack-name'] : undefined,
    author: typeof json['sticker-pack-publisher'] === 'string' ? json['sticker-pack-publisher'] : undefined,
  };
}
