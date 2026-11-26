import { describe, expect, it } from 'vitest';
import { resolveEntitlement } from '../src/bot/entitlement.js';
import { formatBrl, parseBrl } from '../src/money.js';
import { buildStatusModel } from '../src/stickers/status-card.js';
import { formatDate, zonedStartOfDay, zonedStartOfMonth, zonedStartOfWeek } from '../src/time.js';
import type { UserRow } from '../src/types.js';
import { createHarness, redPng, textsOf } from './helpers.js';

const now = Date.parse('2026-11-18T15:00:00.000Z');

function user(partial: Partial<UserRow> = {}): UserRow {
  return {
    jid: '5511900000001@s.whatsapp.net',
    phone: '5511900000001',
    pushName: 'Lia',
    balance: 0,
    trialRemaining: 0,
    stickersUsed: 0,
    planId: null,
    planExpiresAt: null,
    isVip: false,
    hasInbound: true,
    soundStickers: true,
    stickerFormat: 'perguntar',
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe('planos, saldo e datas', () => {
  it('formata real e escolhe a ordem do saldo', () => {
    expect(formatBrl(350)).toBe('R$ 3,50');
    expect(formatBrl(550)).toBe('R$ 5,50');
    expect(formatBrl(790)).toBe('R$ 7,90');
    expect(formatBrl(1490)).toBe('R$ 14,90');
    expect(formatBrl(1990)).toBe('R$ 19,90');
    expect(formatBrl(100000)).toBe('R$ 1.000,00');
    expect(parseBrl('7,90')).toBe(790);
    expect(parseBrl('R$ 1.234,56')).toBe(123456);
    expect(resolveEntitlement(user(), { isAdmin: true, now }).source).toBe('admin');
    expect(resolveEntitlement(user({ isVip: true }), { isAdmin: false, now }).source).toBe('vip');
    expect(resolveEntitlement(user({ planExpiresAt: now + 86_400_000, balance: 4 }), { isAdmin: false, now }).source).toBe('unlimited');
    expect(resolveEntitlement(user({ planExpiresAt: now - 1, balance: 4, trialRemaining: 2 }), { isAdmin: false, now }).source).toBe('credits');
    expect(resolveEntitlement(user({ trialRemaining: 2 }), { isAdmin: false, now }).ok).toBe(false);
    expect(resolveEntitlement(user(), { isAdmin: false, now }).ok).toBe(false);
  });

  it('calcula meia-noite, semana e mês em Brasília', () => {
    expect(zonedStartOfDay(now, 'America/Sao_Paulo')).toBe(Date.parse('2026-11-18T03:00:00.000Z'));
    expect(zonedStartOfWeek(now, 'America/Sao_Paulo')).toBe(Date.parse('2026-11-16T03:00:00.000Z'));
    expect(zonedStartOfMonth(now, 'America/Sao_Paulo')).toBe(Date.parse('2026-11-01T03:00:00.000Z'));
    expect(formatDate(Date.parse('2026-11-24T15:00:00.000Z'), 'America/Sao_Paulo')).toBe('24/11/2026');
  });

  it('não dá figurinha grátis e gasta primeiro o pacote que vence', async () => {
    const h = await createHarness();
    try {
      const menu = textsOf(await h.send(h.user, '/menu')).join('\n');
      expect(menu).toMatch(/Sem saldo/);
      expect(menu).not.toMatch(/figurinha de teste|teste grátis/);
      const created = await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`);
      expect(created?.trialRemaining).toBe(0);
      expect(created?.balance).toBe(0);

      const png = await redPng();
      const denied = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      expect(denied.some((item) => item.type === 'sticker')).toBe(false);
      const plans = textsOf(denied).join('\n');
      expect(plans).toContain('R$ 3,50');
      expect(plans).toContain('/comprar 15');
      expect(plans).toContain('valem 30 dias');

      await h.send(h.admin, `/vip ${h.user}`);
      await h.send(h.user, '/formato recortar');
      const vip = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      expect(vip.some((item) => item.type === 'sticker')).toBe(true);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(0);
      await h.send(h.admin, `/unvip ${h.user}`);

      const pack25 = (await h.runtime.db.getPlan('pack25'))!;
      const pack15 = (await h.runtime.db.getPlan('pack15'))!;
      expect(pack25.creditsExpireDays).toBeNull();
      expect(pack15.creditsExpireDays).toBe(30);
      await h.runtime.db.grantPlan(h.user, pack25, h.nowBox.value);
      await h.runtime.db.grantPlan(h.user, pack15, h.nowBox.value);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(40);

      const spent = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      expect(spent.some((item) => item.type === 'sticker')).toBe(true);
      const jid = `${h.user}@s.whatsapp.net`;
      const lots = await h.runtime.db.listCreditLots(jid, h.nowBox.value);
      expect(lots.map((lot) => lot.remaining)).toEqual([14, 25]);
      expect(lots[0]?.expiresAt).toBe(h.nowBox.value + 30 * 86_400_000);
      expect(lots[1]?.expiresAt).toBeNull();

      const row = (await h.runtime.db.getUser(jid))!;
      const model = buildStatusModel({
        user: row,
        isAdmin: false,
        now: h.nowBox.value,
        planName: null,
        timeZone: 'America/Sao_Paulo',
        brand: 'Zapfig',
        lots,
      });
      expect(model.headline).toBe('39');
      expect(model.detail).toContain('14 até 18/12/2026');
      expect(model.detail).toContain('25 não vencem');
      const status = await h.send(h.user, '/status');
      const card = status.find((item) => item.type === 'image');
      expect(card && card.type === 'image' ? card.caption : '').toContain('18/12/2026');

      h.nowBox.value += 30 * 86_400_000;
      const afterExpiry = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      expect(afterExpiry.some((item) => item.type === 'sticker')).toBe(true);
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(24);
      const left = await h.runtime.db.listCreditLots(jid, h.nowBox.value);
      expect(left).toEqual([expect.objectContaining({ remaining: 24, expiresAt: null })]);

      h.nowBox.value += 400 * 86_400_000;
      await h.send(h.user, '/status');
      expect((await h.runtime.db.getUser(jid))?.balance).toBe(24);
    } finally {
      await h.cleanup();
    }
  });

  it('cobra os preços definidos pelo dono', async () => {
    const h = await createHarness();
    try {
      const plans = await h.runtime.db.listPlans();
      const price = (id: string) => plans.find((plan) => plan.id === id)?.priceCents;
      expect(price('pack15')).toBe(350);
      expect(price('pack25')).toBe(550);
      expect(price('weekly')).toBe(790);
      expect(price('days30')).toBe(1490);
      expect(price('months3')).toBe(1990);
      const weekly = await h.runtime.db.getPlan('weekly');
      expect(weekly?.priceIsPlaceholder).toBe(false);
      const listed = textsOf(await h.send(h.user, '/planos')).join('\n');
      expect(listed).toContain('R$ 3,50');
      expect(listed).toContain('R$ 5,50');
      expect(listed).toContain('R$ 7,90');
      expect(listed).toContain('R$ 14,90');
      expect(listed).toContain('R$ 19,90');
      expect(listed).toContain('valem 30 dias');
      expect(listed).toContain('não vencem');
      const replies = textsOf(await h.send(h.user, '/comprar semanal'));
      expect(replies.join('\n')).toContain('R$ 7,90');
      expect(replies.join('\n')).not.toMatch(/PLACEHOLDER/);
      const open = await h.runtime.db.listOpenPayments(`${h.user}@s.whatsapp.net`);
      expect(open).toHaveLength(1);
      expect(open[0]?.amountCents).toBe(790);
    } finally {
      await h.cleanup();
    }
  });

  it('estende plano ilimitado a partir do vencimento mais tarde', async () => {
    const h = await createHarness();
    try {
      const plan = (await h.runtime.db.getPlan('days30'))!;
      await h.runtime.db.grantPlan(h.user, plan, h.nowBox.value);
      const first = (await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))!;
      await h.runtime.db.grantPlan(h.user, plan, h.nowBox.value + 5 * 86_400_000);
      const second = (await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))!;
      expect(second.planExpiresAt).toBe((first.planExpiresAt ?? 0) + 30 * 86_400_000);
    } finally {
      await h.cleanup();
    }
  });
});
