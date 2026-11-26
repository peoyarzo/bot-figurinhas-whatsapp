import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveFfmpegPath } from './convert.js';

const execFileAsync = promisify(execFile);

/** Mimetype que o WhatsApp exige para o som tocar. `audio/ogg` sem o codec fica mudo. */
export const OPUS_MIME = 'audio/ogg; codecs=opus';

/** O relato da comunidade viu o áudio tocar até ~952 KB e falhar perto de 983 KB. */
export const MAX_SOUND_BYTES = 950_000;

export const MAX_SOUND_SECONDS = 10;

export const OPUS_BITRATES = ['64k', '48k', '32k', '24k', '16k'] as const;

export type AudioExtractResult = { ok: true; buffer: Buffer } | { ok: false; reason: 'no-audio' | 'failed' };

export type FfmpegRunner = (file: string, args: string[], timeoutMs: number) => Promise<void>;

export function soundClipSeconds(animatedSeconds: number): number {
  const finite = Number.isFinite(animatedSeconds) ? animatedSeconds : MAX_SOUND_SECONDS;
  const positive = finite > 0 ? finite : 1;
  return Math.min(positive, MAX_SOUND_SECONDS);
}

/**
 * Áudio Opus sem faixa de vídeo, capa ou Theora.
 * `-vn -map 0:a:0 -c:a libopus` é o que evita o ogg que o ffmpeg monta com capa.
 */
export function opusExtractArgs(input: { source: string; target: string; seconds: number; bitrate: string }): string[] {
  const seconds = soundClipSeconds(input.seconds);
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-t',
    String(seconds),
    '-i',
    input.source,
    '-vn',
    '-map',
    '0:a:0',
    '-c:a',
    'libopus',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-b:a',
    input.bitrate,
    '-f',
    'ogg',
    input.target,
  ];
}

export async function extractStickerOpus(
  input: Buffer,
  options: { seconds: number; ffmpegPath?: string; run?: FfmpegRunner },
): Promise<AudioExtractResult> {
  let ffmpeg: string;
  try {
    ffmpeg = options.run ? (options.ffmpegPath ?? 'ffmpeg') : await resolveFfmpegPath(options.ffmpegPath);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  const run = options.run ?? defaultRun;
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-opus-'));
  const source = path.join(dir, 'in.bin');
  const target = path.join(dir, 'out.ogg');
  try {
    await writeFile(source, input);
    for (const bitrate of OPUS_BITRATES) {
      const args = opusExtractArgs({ source, target, seconds: options.seconds, bitrate });
      try {
        await run(ffmpeg, args, 20_000);
      } catch (error) {
        if (isNoAudio(error)) return { ok: false, reason: 'no-audio' };
        return { ok: false, reason: 'failed' };
      }
      let encoded: Buffer;
      try {
        encoded = await readFile(target);
      } catch {
        continue;
      }
      if (encoded.length > 0 && encoded.length <= MAX_SOUND_BYTES) return { ok: true, buffer: encoded };
    }
    return { ok: false, reason: 'failed' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function defaultRun(file: string, args: string[], timeoutMs: number): Promise<void> {
  await execFileAsync(file, args, { timeout: timeoutMs, maxBuffer: 2_000_000 });
}

function isNoAudio(error: unknown): boolean {
  const text = errorText(error);
  return /matches no streams|does not contain any stream/i.test(text);
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const stderr = 'stderr' in error ? error.stderr : undefined;
  const fromStd = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : typeof stderr === 'string' ? stderr : '';
  const message = error instanceof Error ? error.message : '';
  return `${fromStd}\n${message}`;
}
