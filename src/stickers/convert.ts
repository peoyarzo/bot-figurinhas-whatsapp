import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { StickerFit } from '../bot/format.js';
import type { AppConfig } from '../config.js';
import { attachStickerExif, type StickerMeta } from './exif.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type StickerOptions = StickerMeta & {
  maxStaticBytes: number;
  maxAnimatedBytes: number;
  maxAnimatedSeconds: number;
  ffmpegPath?: string;
  /**
   * cover recorta no centro. fill estica. contain é o encaixe antigo
   * (cabe inteiro, com borda) e só entra se ninguém passou o formato.
   */
  fit?: StickerFit;
};

export type ConvertResult = { ok: true; buffer: Buffer; animated: boolean } | { ok: false; reason: string };

const STATIC_QUALITIES = [82, 70, 58, 46, 34, 24, 16, 10];
const ANIMATED_ATTEMPTS = [
  { quality: 55, fps: 12 },
  { quality: 40, fps: 10 },
  { quality: 28, fps: 8 },
  { quality: 18, fps: 6 },
];

let ffmpegPromise: Promise<string> | null = null;

export function resetFfmpegCache(): void {
  ffmpegPromise = null;
}

export function resolveFfmpegPath(explicit?: string): Promise<string> {
  if (!ffmpegPromise) ffmpegPromise = pickFfmpeg(explicit);
  return ffmpegPromise;
}

async function pickFfmpeg(explicit?: string): Promise<string> {
  const bundled = bundledFfmpeg();
  const candidates = [explicit, process.env.FFMPEG_PATH, path.join(process.cwd(), 'bin', 'ffmpeg'), bundled, 'ffmpeg'].filter(
    (item): item is string => Boolean(item),
  );
  const seen = new Set<string>();
  let fallback: string | null = null;
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate !== 'ffmpeg' && !existsSync(candidate)) continue;
    try {
      const { stdout } = await execFileAsync(candidate, ['-hide_banner', '-encoders'], { timeout: 8_000, maxBuffer: 2_000_000 });
      if (!fallback) fallback = candidate;
      if (stdout.includes('libwebp')) return candidate;
    } catch {
      // tenta o próximo
    }
  }
  if (fallback) return fallback;
  throw new Error('ffmpeg não encontrado');
}

function bundledFfmpeg(): string | undefined {
  try {
    const value = require('ffmpeg-static') as string | null;
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

export function stickerOptionsFromConfig(config: AppConfig, ffmpegPath?: string, fit: StickerFit = 'contain'): StickerOptions {
  return { ...config.sticker, ffmpegPath, fit };
}

export function animationVideoFilter(fit: StickerFit, fps: number): string {
  const lead = `format=rgba,fps=${fps}`;
  const tail = 'format=yuva420p';
  if (fit === 'fill') return `${lead},scale=512:512:flags=lanczos,${tail}`;
  if (fit === 'cover') return `${lead},scale=512:512:force_original_aspect_ratio=increase:flags=lanczos,crop=512:512,${tail}`;
  return `${lead},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,${tail}`;
}

export async function mediaToSticker(input: Buffer, mimetype: string, opts: StickerOptions): Promise<ConvertResult> {
  const animated = mimetype === 'image/gif' || mimetype.startsWith('video/') || (await isAnimatedWebp(input, mimetype));
  return animated ? videoToSticker(input, opts) : imageToSticker(input, opts);
}

async function isAnimatedWebp(input: Buffer, mimetype: string): Promise<boolean> {
  if (mimetype !== 'image/webp') return false;
  try {
    const meta = await sharp(input, { animated: true }).metadata();
    return (meta.pages ?? 1) > 1;
  } catch {
    return false;
  }
}

export async function imageToSticker(input: Buffer, opts: StickerOptions): Promise<ConvertResult> {
  for (const quality of STATIC_QUALITIES) {
    try {
      const encoded = await sharp(input, { animated: false, limitInputPixels: 20_000_000, failOn: 'none' })
        // JPEG não tem alfa. Sem este canal, o sharp ignora o alpha do background e a sobra sai opaca.
        .ensureAlpha()
        .rotate()
        .resize(512, 512, resizeOptions(opts.fit ?? 'contain'))
        .webp({ quality, alphaQuality: 100, effort: 5 })
        .toBuffer();
      const withExif = attachStickerExif(encoded, opts);
      if (withExif.length <= opts.maxStaticBytes) return { ok: true, buffer: withExif, animated: false };
    } catch {
      return { ok: false, reason: 'Não consegui ler essa imagem. Manda PNG, JPG ou WebP.' };
    }
  }
  return { ok: false, reason: `Não coube no limite de ${Math.round(opts.maxStaticBytes / 1024)} KB nem na qualidade mínima.` };
}

export async function videoToSticker(input: Buffer, opts: StickerOptions): Promise<ConvertResult> {
  let ffmpeg: string;
  try {
    ffmpeg = await resolveFfmpegPath(opts.ffmpegPath);
  } catch {
    return { ok: false, reason: 'Este servidor está sem ffmpeg, então não converto vídeo nem GIF agora.' };
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-'));
  const source = path.join(dir, 'in.bin');
  const target = path.join(dir, 'out.webp');
  try {
    await writeFile(source, input);
    let codec: 'libwebp_anim' | 'libwebp' = 'libwebp_anim';
    for (const attempt of ANIMATED_ATTEMPTS) {
      try {
        await encodeAnimation(ffmpeg, source, target, attempt, opts.maxAnimatedSeconds, codec, opts.fit ?? 'contain');
      } catch {
        if (codec === 'libwebp_anim') {
          codec = 'libwebp';
          try {
            await encodeAnimation(ffmpeg, source, target, attempt, opts.maxAnimatedSeconds, codec, opts.fit ?? 'contain');
          } catch {
            return { ok: false, reason: 'Não consegui converter esse vídeo. Tente um clipe mais curto.' };
          }
        } else {
          return { ok: false, reason: 'Não consegui converter esse vídeo. Tente um clipe mais curto.' };
        }
      }
      const encoded = await readFile(target);
      const withExif = attachStickerExif(encoded, opts);
      if (withExif.length <= opts.maxAnimatedBytes) return { ok: true, buffer: withExif, animated: true };
    }
    return { ok: false, reason: `Não coube no limite de ${Math.round(opts.maxAnimatedBytes / 1024)} KB nem encurtando e baixando a qualidade.` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function resizeOptions(fit: StickerFit): sharp.ResizeOptions {
  if (fit === 'fill') return { fit: 'fill' };
  if (fit === 'cover') return { fit: 'cover', position: 'centre' };
  return { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } };
}

async function encodeAnimation(
  ffmpeg: string,
  source: string,
  target: string,
  attempt: { quality: number; fps: number },
  seconds: number,
  codec: 'libwebp_anim' | 'libwebp',
  fit: StickerFit,
): Promise<void> {
  const filter = animationVideoFilter(fit, attempt.fps);
  await execFileAsync(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-t', String(seconds), '-i', source, '-an', '-vf', filter, '-c:v', codec, '-pix_fmt', 'yuva420p', '-quality', String(attempt.quality), '-loop', '0', target],
    { timeout: 25_000, maxBuffer: 2_000_000 },
  );
}
