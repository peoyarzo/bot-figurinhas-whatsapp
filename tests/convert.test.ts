import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { animationVideoFilter, imageToSticker, mediaToSticker, resolveFfmpegPath, stickerOptionsFromConfig } from '../src/stickers/convert.js';
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

  it('recorta no centro e estica sem faixa transparente', async () => {
    const input = await widePng();
    const opts = stickerOptionsFromConfig(loadConfig());
    const cropped = await imageToSticker(input, { ...opts, fit: 'cover' });
    const stretched = await imageToSticker(input, { ...opts, fit: 'fill' });
    expect(cropped.ok && stretched.ok).toBe(true);
    if (!cropped.ok || !stretched.ok) return;
    const cropCorner = await pixel(cropped.buffer, 0, 0);
    const cropCenter = await pixel(cropped.buffer, 256, 256);
    const fillCorner = await pixel(stretched.buffer, 0, 0);
    const fillCenter = await pixel(stretched.buffer, 256, 256);
    expect(cropCorner.a).toBe(255);
    expect(cropCorner.b).toBeGreaterThan(cropCorner.g);
    expect(cropCenter.b).toBeGreaterThan(cropCenter.g);
    expect(fillCorner.a).toBe(255);
    expect(fillCorner.g).toBeGreaterThan(fillCorner.b);
    expect(fillCenter.b).toBeGreaterThan(fillCenter.g);
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
    expect(readStickerExif(result.buffer)?.packName).toBe('Zapfig');
    expect(animationVideoFilter('contain', 12)).toContain('pad=512:512');
    expect(animationVideoFilter('cover', 12)).toContain('crop=512:512');
    expect(animationVideoFilter('cover', 12)).toContain('force_original_aspect_ratio=increase');
    expect(animationVideoFilter('fill', 12)).toBe('fps=12,scale=512:512:flags=lanczos,format=rgba');
    const refused = await mediaToSticker(video, 'video/mp4', { ...opts, maxAnimatedBytes: 80 });
    expect(refused.ok).toBe(false);
  }, 60_000);
});

async function widePng(): Promise<Buffer> {
  const width = 800;
  const height = 200;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const blue = x >= 300 && x < 500;
      const index = (y * width + x) * 3;
      raw[index] = 0;
      raw[index + 1] = blue ? 0 : 180;
      raw[index + 2] = blue ? 220 : 40;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function pixel(buffer: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number; a: number }> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const index = (y * info.width + x) * info.channels;
  return { r: data[index] ?? 0, g: data[index + 1] ?? 0, b: data[index + 2] ?? 0, a: data[index + 3] ?? 0 };
}

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
