import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { beforeEach, describe, expect, it } from 'vitest';
import { deliverSticker } from '../src/bot/media.js';
import { resolveFfmpegPath } from '../src/stickers/convert.js';
import {
  MAX_SOUND_BYTES,
  OPUS_BITRATES,
  OPUS_MIME,
  extractStickerOpus,
  opusExtractArgs,
  type FfmpegRunner,
} from '../src/stickers/audio.js';
import type { Messenger } from '../src/whatsapp/messenger.js';
import {
  installSoundStickerEncodePatch,
  registerSoundSticker,
  resetSoundStickerState,
} from '../src/whatsapp/sound-sticker.js';
import { createHarness, redPng, textsOf } from './helpers.js';

const execFileAsync = promisify(execFile);

type Wire = { field: number; wire: 0; value: number } | { field: number; wire: 2; value: Buffer };

describe('áudio da figurinha com som', () => {
  it('monta o ffmpeg com opus mono, sem vídeo nem capa', () => {
    const six = opusExtractArgs({ source: '/tmp/in.bin', target: '/tmp/out.ogg', seconds: 6, bitrate: '64k' });
    expect(six).toEqual([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-t',
      '6',
      '-i',
      '/tmp/in.bin',
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
      '64k',
      '-f',
      'ogg',
      '/tmp/out.ogg',
    ]);
    const capped = opusExtractArgs({ source: 'in', target: 'out.ogg', seconds: 30, bitrate: '32k' });
    expect(capped[capped.indexOf('-t') + 1]).toBe('10');
    expect(capped).not.toContain('libtheora');
    expect(capped).not.toContain('mjpeg');
    expect(capped).not.toContain('copy');
  });

  it('chama o ffmpeg com esses argumentos e reduz o bitrate se passar de ~1 MB', async () => {
    const calls: string[][] = [];
    const run: FfmpegRunner = async (_file, args) => {
      calls.push(args);
      const target = args[args.length - 1] ?? '';
      const huge = calls.length === 1;
      await writeFile(target, Buffer.alloc(huge ? MAX_SOUND_BYTES + 1 : 32));
    };
    const result = await extractStickerOpus(Buffer.from('video'), { seconds: 6, run });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(opusExtractArgs({ source: calls[0]?.[calls[0].indexOf('-i') + 1] ?? '', target: calls[0]?.at(-1) ?? '', seconds: 6, bitrate: OPUS_BITRATES[0] }));
    expect(calls[0]).toContain('-vn');
    expect(calls[0]?.[calls[0].indexOf('-map') + 1]).toBe('0:a:0');
    expect(calls[0]?.[calls[0].indexOf('-c:a') + 1]).toBe('libopus');
    expect(calls[0]?.[calls[0].indexOf('-ac') + 1]).toBe('1');
    expect(calls[1]?.[calls[1].indexOf('-b:a') + 1]).toBe(OPUS_BITRATES[1]);
  });

  it('trata vídeo sem faixa de áudio como ausência de som', async () => {
    const run: FfmpegRunner = async () => {
      const error = new Error('ffmpeg failed') as Error & { stderr: string };
      error.stderr = "Stream map '0:a:0' matches no streams.";
      throw error;
    };
    const result = await extractStickerOpus(Buffer.from('mudo'), { seconds: 6, run });
    expect(result).toEqual({ ok: false, reason: 'no-audio' });
  });
});

describe('encode da figurinha com som', () => {
  const sha = Buffer.from('0123456789abcdef0123456789abcdef');
  const sticker = {
    mimetype: 'image/webp',
    fileSha256: sha,
    fileLength: 128,
    isAnimated: true,
  };
  const audio = {
    mimetype: 'audio/ogg',
    ptt: true,
    seconds: 3,
    fileLength: 64,
  };

  beforeEach(() => {
    resetSoundStickerState();
    installSoundStickerEncodePatch();
  });

  it('coloca o áudio no campo 134/26 com o mimetype opus e sem sticker no topo', () => {
    registerSoundSticker(sha, audio);
    const encoded = proto.Message.encode({ stickerMessage: sticker }).finish();
    const sound = readSound(Buffer.from(encoded));
    expect(sound.mime).toBe(OPUS_MIME);
    expect(sound.field24).toBe(0);
    expect(sound.ptt).toBe(false);
    expect(decode(Buffer.from(encoded)).some((field) => field.field === 26)).toBe(false);
  });

  it('o fromObject do envio e o deviceSentMessage passam pelo mesmo encode', () => {
    registerSoundSticker(sha, audio);
    const created = generateWAMessageFromContent('5511900000001@s.whatsapp.net', { stickerMessage: sticker }, {
      userJid: '5511900000099@s.whatsapp.net',
    });
    if (!created.message) throw new Error('mensagem vazia');
    const prepared = readSound(Buffer.from(proto.Message.encode(created.message).finish()));
    expect(prepared.mime).toBe(OPUS_MIME);
    resetSoundStickerState();
    registerSoundSticker(sha, audio);
    const encoded = proto.Message.encode({
      deviceSentMessage: {
        destinationJid: '5511900000001@s.whatsapp.net',
        message: { stickerMessage: sticker },
      },
    }).finish();
    const device = bytesField(decode(Buffer.from(encoded)), 31);
    const inner = bytesField(decode(device), 2);
    const sound = readSound(inner);
    expect(sound.mime).toBe(OPUS_MIME);
    expect(decode(inner).some((field) => field.field === 26)).toBe(false);
  });

  it('não mexe em sticker sem áudio nem em texto', () => {
    const plain = Buffer.from(proto.Message.encode({ stickerMessage: sticker }).finish());
    expect(decode(plain).some((field) => field.field === 26)).toBe(true);
    expect(decode(plain).some((field) => field.field === 134)).toBe(false);
    const text = Buffer.from(proto.Message.encode({ conversation: 'oi' }).finish());
    expect(decode(text).some((field) => field.field === 134)).toBe(false);
    expect(decode(text).find((field) => field.field === 1 && field.wire === 2)?.value.toString('utf8')).toBe('oi');
  });
});

describe('preferência /som e um crédito', () => {
  it('liga e desliga por pessoa, padrão ligado', async () => {
    const h = await createHarness();
    try {
      const jid = `${h.user}@s.whatsapp.net`;
      const menu = textsOf(await h.send(h.user, '/menu')).join('\n');
      expect(menu).toContain('Zapfig');
      expect(menu).toContain('/som off');
      expect((await h.runtime.db.getUser(jid))?.soundStickers).toBe(true);
      const off = textsOf(await h.send(h.user, '/som off')).join('\n');
      expect(off).toMatch(/desligado/i);
      expect((await h.runtime.db.getUser(jid))?.soundStickers).toBe(false);
      const usage = textsOf(await h.send(h.user, '/som')).join('\n');
      expect(usage).toContain('/som on');
      const on = textsOf(await h.send(h.user, '/SOM ON')).join('\n');
      expect(on).toMatch(/ligado/i);
      expect((await h.runtime.db.getUser(jid))?.soundStickers).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('vídeo com áudio vira uma figurinha com som e desconta um crédito', async () => {
    const h = await createHarness();
    try {
      const plan = await h.runtime.db.getPlan('pack15');
      if (!plan) throw new Error('plano');
      await h.runtime.db.grantPlan(h.user, plan, h.nowBox.value);
      const video = await clip(true);
      const sent = await h.send(h.user, '', { media: { kind: 'video', mimetype: 'video/mp4', buffer: video } });
      const stickers = sent.filter((item) => item.type === 'sticker');
      expect(stickers).toHaveLength(1);
      const sticker = stickers[0];
      if (!sticker || sticker.type !== 'sticker') throw new Error('sem figurinha');
      expect(sticker.audio?.subarray(0, 4).toString('utf8')).toBe('OggS');
      expect(sticker.audio?.length).toBeLessThanOrEqual(MAX_SOUND_BYTES);
      const user = await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`);
      expect(user?.balance).toBe(14);
      expect(user?.stickersUsed).toBe(1);
    } finally {
      await h.cleanup();
    }
  }, 60_000);

  it('/som off e vídeo sem áudio mandam a figurinha muda, ainda um crédito', async () => {
    const h = await createHarness();
    try {
      const plan = await h.runtime.db.getPlan('pack15');
      if (!plan) throw new Error('plano');
      await h.runtime.db.grantPlan(h.user, plan, h.nowBox.value);
      await h.send(h.user, '/som off');
      const withAudio = await clip(true);
      const muted = await h.send(h.user, '', { media: { kind: 'video', mimetype: 'video/mp4', buffer: withAudio } });
      const first = muted.find((item) => item.type === 'sticker');
      expect(first && first.type === 'sticker' ? first.audio : undefined).toBeUndefined();
      const silent = await clip(false);
      const plain = await h.send(h.user, '/som on').then(() =>
        h.send(h.user, '', { media: { kind: 'video', mimetype: 'video/mp4', buffer: silent } }),
      );
      const second = plain.find((item) => item.type === 'sticker');
      expect(second && second.type === 'sticker' ? second.audio : undefined).toBeUndefined();
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(13);
    } finally {
      await h.cleanup();
    }
  }, 60_000);

  it('SOUND_STICKERS=0 não anexa áudio', async () => {
    const h = await createHarness(({ env }) => {
      env.SOUND_STICKERS = false;
    });
    try {
      const plan = await h.runtime.db.getPlan('pack15');
      if (!plan) throw new Error('plano');
      await h.runtime.db.grantPlan(h.user, plan, h.nowBox.value);
      const saved = textsOf(await h.send(h.user, '/som on')).join('\n');
      expect(saved).toContain('SOUND_STICKERS');
      const sent = await h.send(h.user, '', { media: { kind: 'video', mimetype: 'video/mp4', buffer: await clip(true) } });
      const sticker = sent.find((item) => item.type === 'sticker');
      expect(sticker && sticker.type === 'sticker' ? sticker.audio : undefined).toBeUndefined();
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(14);
    } finally {
      await h.cleanup();
    }
  }, 60_000);

  it('se o envio com som falha, manda a figurinha muda', async () => {
    const calls: Array<Buffer | undefined> = [];
    const messenger = {
      async sendSticker(_jid: string, _buffer: Buffer, audio?: Buffer) {
        calls.push(audio);
        if (audio) throw new Error('upload falhou');
      },
    };
    const result = await deliverSticker(messenger as Messenger, 'jid', Buffer.from('webp'), Buffer.from('opus'));
    expect(result.mode).toBe('plain');
    expect(result.soundError).toBeInstanceOf(Error);
    expect(calls.map((audio) => audio?.toString())).toEqual(['opus', undefined]);
  });

  it('imagem não leva áudio', async () => {
    const h = await createHarness();
    try {
      await h.send(h.admin, `/vip ${h.user}`);
      const sent = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: await redPng() } });
      const sticker = sent.find((item) => item.type === 'sticker');
      expect(sticker && sticker.type === 'sticker' ? sticker.audio : undefined).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });
});

function readSound(message: Buffer): { mime: string; field24: number; ptt: boolean } {
  const wrapped = bytesField(decode(message), 134);
  const inner = bytesField(decode(wrapped), 1);
  const sticker = bytesField(decode(inner), 26);
  const stickerFields = decode(sticker);
  const field24 = stickerFields.find((field) => field.field === 24 && field.wire === 0);
  const audio = bytesField(stickerFields, 26);
  const audioFields = decode(audio);
  const mime = audioFields.find((field) => field.field === 2 && field.wire === 2);
  if (!mime || mime.wire !== 2) throw new Error('mimetype ausente');
  return {
    mime: mime.value.toString('utf8'),
    field24: field24 && field24.wire === 0 ? field24.value : -1,
    ptt: audioFields.some((field) => field.field === 6),
  };
}

function bytesField(fields: Wire[], field: number): Buffer {
  const found = fields.find((item) => item.field === field && item.wire === 2);
  if (!found || found.wire !== 2) throw new Error(`campo ${field} ausente`);
  return found.value;
}

function decode(buffer: Buffer): Wire[] {
  const fields: Wire[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      fields.push({ field, wire: 0, value: value.value });
      continue;
    }
    if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + length.value;
      fields.push({ field, wire: 2, value: Buffer.from(buffer.subarray(offset, end)) });
      offset = end;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      continue;
    }
    throw new Error(`wire ${wire}`);
  }
  return fields;
}

function readVarint(buffer: Buffer, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  while (offset < buffer.length && shift <= 28) {
    const byte = buffer[offset] ?? 0;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error('varint inválido');
}

async function clip(withAudio: boolean): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-clip-'));
  const out = path.join(dir, 'clip.mp4');
  try {
    const ffmpeg = await resolveFfmpegPath();
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.4'];
    if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-shortest', '-c:a', 'aac');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
    await execFileAsync(ffmpeg, args);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
