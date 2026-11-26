import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { animationVideoFilter, imageToSticker, mediaToSticker, resolveFfmpegPath, stickerOptionsFromConfig } from '../src/stickers/convert.js';
import { attachStickerExif, readStickerExif } from '../src/stickers/exif.js';

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

  it('não pinta borda branca e guarda a transparência do PNG', async () => {
    const opts = stickerOptionsFromConfig(loadConfig());
    const hole = await transparentPng();
    for (const fit of ['contain', 'cover', 'fill'] as const) {
      const result = await imageToSticker(hole, { ...opts, fit });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const corner = await pixel(result.buffer, 0, 0);
      expect(corner.a).toBe(0);
      expect(opaqueWhite(corner)).toBe(false);
      expect(await countOpaqueWhite(result.buffer)).toBe(0);
      const center = await pixel(result.buffer, 256, 256);
      expect(center.a).toBe(255);
      expect(center.r).toBeGreaterThan(center.g);
    }

    const jpeg = await sharp({
      create: { width: 800, height: 200, channels: 3, background: { r: 220, g: 30, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    const padded = await imageToSticker(jpeg, { ...opts, fit: 'contain' });
    expect(padded.ok).toBe(true);
    if (!padded.ok) return;
    const jpegCorner = await pixel(padded.buffer, 0, 0);
    expect(jpegCorner.a).toBe(0);
    expect(opaqueWhite(jpegCorner)).toBe(false);
    expect(await countOpaqueWhite(padded.buffer)).toBe(0);

    const beforeExif = await sharp(hole).ensureAlpha().resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ alphaQuality: 100 }).toBuffer();
    const afterExif = attachStickerExif(beforeExif, opts);
    expect(await rawPixels(beforeExif)).toEqual(await rawPixels(afterExif));
    expect((await pixel(afterExif, 0, 0)).a).toBe(0);
  });

  it('vídeo e GIF não ganham borda branca em nenhum encaixe', async () => {
    const opts = stickerOptionsFromConfig(loadConfig());
    const video = await wideVideo();
    for (const fit of ['contain', 'cover', 'fill'] as const) {
      const result = await mediaToSticker(video, 'video/mp4', { ...opts, fit });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.animated).toBe(true);
      expect(await countOpaqueWhite(result.buffer)).toBe(0);
      const corner = await pixel(result.buffer, 0, 0);
      if (fit === 'contain') expect(corner.a).toBe(0);
      else expect(opaqueWhite(corner)).toBe(false);
    }
    const gif = await transparentGif();
    const fromGif = await mediaToSticker(gif, 'image/gif', { ...opts, fit: 'contain' });
    expect(fromGif.ok).toBe(true);
    if (!fromGif.ok) return;
    const gifCorner = await pixel(fromGif.buffer, 0, 0);
    expect(gifCorner.a).toBe(0);
    expect(await countOpaqueWhite(fromGif.buffer)).toBe(0);
  }, 60_000);

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
    expect(animationVideoFilter('contain', 12)).toContain('pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000');
    expect(animationVideoFilter('contain', 12)).not.toMatch(/white|black@/i);
    expect(animationVideoFilter('cover', 12)).toContain('crop=512:512');
    expect(animationVideoFilter('cover', 12)).toContain('force_original_aspect_ratio=increase');
    expect(animationVideoFilter('fill', 12)).toBe('format=rgba,fps=12,scale=512:512:flags=lanczos,format=yuva420p');
    for (const fit of ['contain', 'cover', 'fill'] as const) {
      expect(animationVideoFilter(fit, 8).startsWith('format=rgba')).toBe(true);
      expect(animationVideoFilter(fit, 8).endsWith('format=yuva420p')).toBe(true);
    }
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

function opaqueWhite(pixelValue: { r: number; g: number; b: number; a: number }): boolean {
  return pixelValue.a > 200 && pixelValue.r > 240 && pixelValue.g > 240 && pixelValue.b > 240;
}

async function countOpaqueWhite(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    const sample = { r: data[index] ?? 0, g: data[index + 1] ?? 0, b: data[index + 2] ?? 0, a: data[index + 3] ?? 0 };
    if (opaqueWhite(sample)) count += 1;
  }
  return count;
}

async function rawPixels(buffer: Buffer): Promise<Buffer> {
  const { data } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return Buffer.from(data);
}

async function transparentPng(): Promise<Buffer> {
  const dot = await sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 220, g: 30, b: 40, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: dot, left: 80, top: 80 }])
    .png()
    .toBuffer();
}

async function wideVideo(): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-wide-'));
  try {
    const out = path.join(dir, 'wide.mp4');
    const ffmpeg = await resolveFfmpegPath();
    await execFileAsync(ffmpeg, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=96x32:d=0.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transparentGif(): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-gif-'));
  try {
    const png = path.join(dir, 'frame.png');
    const gif = path.join(dir, 'clip.gif');
    await sharp(await transparentPng()).resize(64, 64).png().toFile(png);
    const ffmpeg = await resolveFfmpegPath();
    await execFileAsync(ffmpeg, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-t',
      '0.5',
      '-i',
      png,
      '-filter_complex',
      '[0:v]fps=8,format=rgba,split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse=alpha_threshold=128',
      '-gifflags',
      '-offsetting',
      gif,
    ]);
    return await readFile(gif);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
