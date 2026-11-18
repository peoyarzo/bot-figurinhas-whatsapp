import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { imageToSticker, mediaToSticker, resolveFfmpegPath, stickerOptionsFromConfig } from '../src/stickers/convert.js';
import { readStickerExif } from '../src/stickers/exif.js';

const execFileAsync = promisify(execFile);

describe('conversão de figurinha', () => {
  it('encaixa imagem em 512 com fundo transparente e EXIF', async () => {
    const input = await sharp({
      create: { width: 800, height: 200, channels: 4, background: { r: 220, g: 30, b: 40, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const opts = stickerOptionsFromConfig(loadConfig());
    const result = await imageToSticker(input, opts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.buffer.length).toBeLessThanOrEqual(opts.maxStaticBytes);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
    const { data, info } = await sharp(result.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    const center = (256 * info.width + 256) * info.channels;
    expect(data[center + 3]).toBe(255);
    expect(readStickerExif(result.buffer)?.packName).toBe(opts.packName);
    expect(readStickerExif(result.buffer)?.author).toBe(opts.author);
  });

  it('recusa estática que não cabe no limite', async () => {
    const input = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 10, g: 180, b: 90, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const result = await imageToSticker(input, { ...stickerOptionsFromConfig(loadConfig()), maxStaticBytes: 80 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/100|limite|KB/i);
  });

  it('converte vídeo curto em webp animado e recusa se não couber', async () => {
    const video = await tinyVideo();
    const opts = stickerOptionsFromConfig(loadConfig());
    const result = await mediaToSticker(video, 'video/mp4', opts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.animated).toBe(true);
    expect(result.buffer.length).toBeLessThanOrEqual(opts.maxAnimatedBytes);
    const meta = await sharp(result.buffer, { animated: true }).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(512);
    expect(meta.pageHeight ?? meta.height).toBe(512);
    expect((meta.pages ?? 1) > 1).toBe(true);
    expect(readStickerExif(result.buffer)?.packName).toBe('Figurinhas');
    const refused = await mediaToSticker(video, 'video/mp4', { ...opts, maxAnimatedBytes: 80 });
    expect(refused.ok).toBe(false);
  }, 60_000);
});

async function tinyVideo(): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-src-'));
  try {
    const a = path.join(dir, 'a.png');
    const b = path.join(dir, 'b.png');
    const out = path.join(dir, 'clip.mp4');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: 'red' } }).png().toFile(a);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toFile(b);
    const ffmpeg = await resolveFfmpegPath();
    await execFileAsync(ffmpeg, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-t',
      '0.4',
      '-i',
      a,
      '-loop',
      '1',
      '-t',
      '0.4',
      '-i',
      b,
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p',
      '-movflags',
      '+faststart',
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
