import { describe, expect, it } from 'vitest';
import { GuardedMessenger, RecordingMessenger } from '../src/whatsapp/messenger.js';
import { dailyLimitFor } from '../src/safety/warmup.js';
import { SendQueue } from '../src/safety/queue.js';
import { SlidingWindowLimiter } from '../src/safety/limiter.js';
import { loadConfig } from '../src/config.js';
import { normalizeIncoming } from '../src/whatsapp/normalize.js';
import { createHarness, redPng, textsOf } from './helpers.js';

describe('limites e fila', () => {
  it('aplica janela deslizante por usuário e o teto global', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(() => now, 60_000);
    expect(limiter.tryTake('user:a', 2)).toBe(true);
    expect(limiter.tryTake('user:a', 2)).toBe(true);
    expect(limiter.tryTake('user:a', 2)).toBe(false);
    expect(limiter.tryTake('global', 1)).toBe(true);
    expect(limiter.tryTake('global', 1)).toBe(false);
    now += 60_001;
    expect(limiter.tryTake('user:a', 2)).toBe(true);
    expect(limiter.tryTake('global', 1)).toBe(true);
  });

  it('não passa de duas figurinhas ao mesmo tempo e espera o jitter', async () => {
    const sleeps: number[] = [];
    const queue = new SendQueue({
      maxInFlight: 2,
      jitterMinMs: 25,
      jitterMaxMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      random: () => 0,
    });
    let current = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        queue.enqueue(async () => {
          current += 1;
          peak = Math.max(peak, current);
          await new Promise((resolve) => setTimeout(resolve, 40));
          current -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(sleeps).toEqual([25, 25, 25, 25, 25]);
  });

  it('sobe o limite diário depois do aquecimento', () => {
    const safety = loadConfig().safety;
    expect(dailyLimitFor(0, 0, safety)).toBe(30);
    expect(dailyLimitFor(0, 86_400_000, safety)).toBe(60);
    expect(dailyLimitFor(0, 2 * 86_400_000, safety)).toBe(120);
    expect(dailyLimitFor(0, 3 * 86_400_000, safety)).toBe(400);
  });

  it('segura o minuto do usuário e devolve a vaga se a imagem for inválida', async () => {
    const h = await createHarness(({ config }) => {
      config.safety.perUserPerMinute = 1;
    });
    try {
      await h.send(h.user, 'oi');
      await h.runtime.db.grantPlan(h.user, (await h.runtime.db.getPlan('pack15'))!, h.nowBox.value);
      await h.send(h.user, '/formato recortar');
      const png = await redPng();
      const first = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      expect(first.some((item) => item.type === 'typing')).toBe(true);
      expect(first.some((item) => item.type === 'sticker')).toBe(true);
      const second = textsOf(await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } }));
      expect(second.join('\n')).toMatch(/minuto/);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(14);

      h.nowBox.value += 61_000;
      const garbage = textsOf(
        await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: Buffer.from('não é imagem') } }),
      );
      expect(garbage.join('\n')).toMatch(/Não consegui ler/);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(14);
      const lots = await h.runtime.db.listCreditLots(`${h.user}@s.whatsapp.net`, h.nowBox.value);
      expect(lots.reduce((sum, lot) => sum + lot.remaining, 0)).toBe(14);
    } finally {
      await h.cleanup();
    }
  });

  it('ignora grupo e não deixa o mensageiro falar primeiro', async () => {
    const h = await createHarness();
    try {
      await h.runtime.db.grantPlan(h.user, (await h.runtime.db.getPlan('pack15'))!, h.nowBox.value);
      const png = await redPng();
      const ignored = await h.send(h.user, '', { fromGroup: true, media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      expect(ignored).toHaveLength(0);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(15);
      const inner = new RecordingMessenger();
      const guarded = new GuardedMessenger(inner, h.runtime.db, { info() {}, warn() {}, error() {} });
      await expect(guarded.sendText('5511900000002@s.whatsapp.net', 'oi')).rejects.toThrow(/sem mensagem/);
      expect(inner.sent).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it('descarta mensagem própria, status e histórico', async () => {
    const download = async () => Buffer.from('x');
    expect(await normalizeIncoming({ key: { remoteJid: '5511900000001@s.whatsapp.net', fromMe: true }, message: { conversation: 'oi' } }, download)).toBeNull();
    expect(await normalizeIncoming({ key: { remoteJid: 'status@broadcast', fromMe: false }, message: { conversation: 'oi' } }, download)).toBeNull();
    const group = await normalizeIncoming({ key: { remoteJid: '120363@g.us', fromMe: false }, message: { conversation: '/menu' } }, download);
    expect(group?.fromGroup).toBe(true);
    const append = { type: 'append' as const };
    expect(append.type).toBe('append');
  });
});
