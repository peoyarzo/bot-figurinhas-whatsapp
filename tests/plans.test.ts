import { describe, expect, it } from 'vitest';
import { resolveEntitlement } from '../src/bot/entitlement.js';
import { formatBrl, parseBrl } from '../src/money.js';
import { buildStatusModel } from '../src/stickers/status-card.js';
import { formatDate, zonedStartOfDay, zonedStartOfMonth, zonedStartOfWeek } from '../src/time.js';
import type { UserRow } from '../src/types.js';
import { createHarness, textsOf } from './helpers.js';

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
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe('planos, saldo e datas', () => {
  it('formata real e escolhe a ordem do saldo', () => {
    expect(formatBrl(350)).toBe('R$ 3,50');
    expect(formatBrl(1790)).toBe('R$ 17,90');
    expect(formatBrl(100000)).toBe('R$ 1.000,00');
    expect(parseBrl('6,90')).toBe(690);
    expect(parseBrl('R$ 1.234,56')).toBe(123456);
    expect(resolveEntitlement(user(), { isAdmin: true, now }).source).toBe('admin');
    expect(resolveEntitlement(user({ isVip: true }), { isAdmin: false, now }).source).toBe('vip');
    expect(resolveEntitlement(user({ planExpiresAt: now + 86_400_000, balance: 4 }), { isAdmin: false, now }).source).toBe('unlimited');
    expect(resolveEntitlement(user({ planExpiresAt: now - 1, balance: 4, trialRemaining: 2 }), { isAdmin: false, now }).source).toBe('credits');
    expect(resolveEntitlement(user({ trialRemaining: 2 }), { isAdmin: false, now }).source).toBe('trial');
    expect(resolveEntitlement(user(), { isAdmin: false, now }).ok).toBe(false);
  });

  it('calcula meia-noite, semana e mês em Brasília', () => {
    expect(zonedStartOfDay(now, 'America/Sao_Paulo')).toBe(Date.parse('2026-11-18T03:00:00.000Z'));
    expect(zonedStartOfWeek(now, 'America/Sao_Paulo')).toBe(Date.parse('2026-11-16T03:00:00.000Z'));
    expect(zonedStartOfMonth(now, 'America/Sao_Paulo')).toBe(Date.parse('2026-11-01T03:00:00.000Z'));
    expect(formatDate(Date.parse('2026-11-24T15:00:00.000Z'), 'America/Sao_Paulo')).toBe('24/11/2026');
  });

  it('dá o teste só na primeira conversa e gasta o pacote antes do teste', async () => {
    const h = await createHarness(({ config }) => {
      config.trial.freeStickers = 1;
    });
    try {
      await h.send(h.user, '/menu');
      let row = await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`);
      expect(row?.trialRemaining).toBe(1);
      await h.send(h.user, '/menu');
      row = await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`);
      expect(row?.trialRemaining).toBe(1);
      await h.runtime.db.grantPlan(h.user, (await h.runtime.db.getPlan('pack15'))!, h.nowBox.value);
      row = await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`);
      expect(resolveEntitlement(row!, { isAdmin: false, now: h.nowBox.value }).source).toBe('credits');
      const model = buildStatusModel({
        user: row!,
        isAdmin: false,
        now: h.nowBox.value,
        planName: null,
        timeZone: 'America/Sao_Paulo',
        brand: 'Figurinhas',
      });
      expect(model.headline).toBe('15');
      expect(model.detail).toContain('teste grátis: 1');
    } finally {
      await h.cleanup();
    }
  });

  it('vende o semanal a R$ 4,90', async () => {
    const h = await createHarness();
    try {
      const plan = await h.runtime.db.getPlan('weekly');
      expect(plan?.priceCents).toBe(490);
      expect(plan?.priceIsPlaceholder).toBe(false);
      const replies = textsOf(await h.send(h.user, '/comprar semanal'));
      expect(replies.join('\n')).toContain('R$ 4,90');
      expect(replies.join('\n')).not.toMatch(/PLACEHOLDER/);
      const open = await h.runtime.db.listOpenPayments(`${h.user}@s.whatsapp.net`);
      expect(open).toHaveLength(1);
      expect(open[0]?.amountCents).toBe(490);
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
