import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { parseFormatChoice, parseFormatCommand, PENDING_MEDIA_MS } from '../src/bot/format.js';
import { resolveFfmpegPath } from '../src/stickers/convert.js';
import { createHarness, textsOf } from './helpers.js';

const execFileAsync = promisify(execFile);

describe('escolha de formato', () => {
  it('entende 1, 2, recortar e esticar sem caso nem acento', () => {
    expect(parseFormatChoice('1')).toBe('cover');
    expect(parseFormatChoice('2')).toBe('fill');
    expect(parseFormatChoice(' RECORTAR ')).toBe('cover');
    expect(parseFormatChoice('récortar')).toBe('cover');
    expect(parseFormatChoice('EsTiCaR')).toBe('fill');
    expect(parseFormatChoice('estícar')).toBe('fill');
    expect(parseFormatChoice('3')).toBeNull();
    expect(parseFormatChoice('oi')).toBeNull();
    expect(parseFormatCommand('perguntar')).toBe('perguntar');
    expect(parseFormatCommand('RECORTAR')).toBe('recortar');
    expect(parseFormatCommand('esticar')).toBe('esticar');
    expect(parseFormatCommand('quadrado')).toBeNull();
  });

  it('pergunta, não cobra, e só gera depois da escolha', async () => {
    const h = await createHarness();
    try {
      const plan = (await h.runtime.db.getPlan('pack15'))!;
      await h.runtime.db.grantPlan(h.user, plan, h.nowBox.value);
      const jid = `${h.user}@s.whatsapp.net`;
      const asked = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: await widePng() } });
      const question = textsOf(asked).join('\n');
      expect(question).toContain('1 - Recortar (quadrado, sem distorcer)');
      expect(question).toContain('2 - Esticar (ocupa tudo)');
      expect(question).toContain('/formato recortar');
      expect(asked.some((item) => item.type === 'sticker')).toBe(false);
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(15);
      expect((await h.runtime.db.getUser(jid))?.stickerFormat).toBe('perguntar');

      const help = textsOf(await h.send(h.user, '/ajuda')).join('\n');
      expect(help).toContain('/formato perguntar');
      expect(help).toContain('Zapfig');
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(15);

      const cropped = await h.send(h.user, '1');
      const sticker = cropped.find((item) => item.type === 'sticker');
      expect(sticker && sticker.type === 'sticker').toBe(true);
      if (!sticker || sticker.type !== 'sticker') return;
      const corner = await pixel(sticker.buffer, 0, 0);
      expect(corner.a).toBe(255);
      expect(corner.b).toBeGreaterThan(corner.g);
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(14);
      expect((await h.runtime.db.peekPendingMedia(jid, h.nowBox.value))).toBe('missing');
    } finally {
      await h.cleanup();
    }
  });

  it('guarda recortar ou esticar e pula a pergunta', async () => {
    const h = await createHarness();
    try {
      const plan = (await h.runtime.db.getPlan('pack15'))!;
      await h.runtime.db.grantPlan(h.user, plan, h.nowBox.value);
      const jid = `${h.user}@s.whatsapp.net`;
      const saved = textsOf(await h.send(h.user, '/formato ESTICAR')).join('\n');
      expect(saved).toMatch(/esticar/i);
      expect((await h.runtime.db.getUser(jid))?.stickerFormat).toBe('esticar');
      const stretched = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: await widePng() } });
      expect(textsOf(stretched).join('\n')).not.toContain('Como encaixar');
      const sticker = stretched.find((item) => item.type === 'sticker');
      if (!sticker || sticker.type !== 'sticker') throw new Error('sem figurinha');
      const corner = await pixel(sticker.buffer, 0, 0);
      const center = await pixel(sticker.buffer, 256, 256);
      expect(corner.g).toBeGreaterThan(corner.b);
      expect(center.b).toBeGreaterThan(center.g);
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(14);

      await h.send(h.user, '/formato perguntar');
      const again = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: await widePng() } });
      expect(textsOf(again).join('\n')).toContain('1 - Recortar');
      expect(again.some((item) => item.type === 'sticker')).toBe(false);
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(14);
      const byName = await h.send(h.user, 'esticar');
      expect(byName.some((item) => item.type === 'sticker')).toBe(true);
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(13);
    } finally {
      await h.cleanup();
    }
  });

  it('troca a mídia pendente e esquece depois de 5 minutos', async () => {
    const h = await createHarness();
    try {
      const plan = (await h.runtime.db.getPlan('pack15'))!;
      await h.runtime.db.grantPlan(h.user, plan, h.nowBox.value);
      const jid = `${h.user}@s.whatsapp.net`;
      await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: await solidPng(220, 20, 20) } });
      await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: await widePng() } });
      const replaced = await h.send(h.user, '2');
      const sticker = replaced.find((item) => item.type === 'sticker');
      if (!sticker || sticker.type !== 'sticker') throw new Error('sem figurinha');
      const corner = await pixel(sticker.buffer, 0, 0);
      expect(corner.g).toBeGreaterThan(corner.r);
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(14);

      await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: await widePng() } });
      h.nowBox.value += PENDING_MEDIA_MS + 1;
      const late = textsOf(await h.send(h.user, '1'));
      expect(late.join('\n')).toMatch(/5 minutos/);
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(14);
      expect((await h.runtime.db.peekPendingMedia(jid, h.nowBox.value))).toBe('missing');
    } finally {
      await h.cleanup();
    }
  });

  it('esticar um vídeo com áudio continua figurinha com som e um crédito', async () => {
    const h = await createHarness();
    try {
      const plan = (await h.runtime.db.getPlan('pack15'))!;
      await h.runtime.db.grantPlan(h.user, plan, h.nowBox.value);
      const asked = await h.send(h.user, '', { media: { kind: 'video', mimetype: 'video/mp4', buffer: await clipWithAudio() } });
      expect(textsOf(asked).join('\n')).toContain('2 - Esticar');
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(15);
      const sent = await h.send(h.user, '2');
      const sticker = sent.find((item) => item.type === 'sticker');
      if (!sticker || sticker.type !== 'sticker') throw new Error('sem figurinha');
      expect(sticker.audio?.subarray(0, 4).toString('utf8')).toBe('OggS');
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(14);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.stickersUsed).toBe(1);
    } finally {
      await h.cleanup();
    }
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
      raw[index] = blue ? 0 : 20;
      raw[index + 1] = blue ? 0 : 180;
      raw[index + 2] = blue ? 220 : 40;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function solidPng(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 800, height: 200, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

async function pixel(buffer: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number; a: number }> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const index = (y * info.width + x) * info.channels;
  return { r: data[index] ?? 0, g: data[index + 1] ?? 0, b: data[index + 2] ?? 0, a: data[index + 3] ?? 0 };
}

async function clipWithAudio(): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-fit-'));
  const out = path.join(dir, 'clip.mp4');
  try {
    const ffmpeg = await resolveFfmpegPath();
    await execFileAsync(ffmpeg, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=96x32:d=0.4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.4',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
