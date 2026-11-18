import { describe, expect, it } from 'vitest';
import { MockGateway } from '../src/payments/gateway.js';
import { createHarness, postWebhook, redPng, textsOf } from './helpers.js';

describe('comandos de admin', () => {
  it('bloqueia vendas, liberar, vip e pausa para quem não é admin', async () => {
    const h = await createHarness();
    try {
      for (const text of ['/vendas', '/liberar 5511900000002 15', '/vip 5511900000002', '/pausar']) {
        const replies = textsOf(await h.send(h.user, text));
        expect(replies.join('\n')).toMatch(/administra/);
      }
      expect(await h.runtime.db.isPaused()).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it('pausa o bot, libera plano sem chamar desconhecido e edita preço', async () => {
    const h = await createHarness();
    try {
      await h.send(h.admin, '/pausar');
      expect(await h.runtime.db.isPaused()).toBe(true);
      const silenced = await h.send(h.user, '/menu');
      expect(silenced).toHaveLength(0);
      await h.send(h.admin, '/retomar');
      const back = textsOf(await h.send(h.user, '/menu'));
      expect(back.join('\n')).toMatch(/\/planos/);

      const stranger = '5511900000002';
      const granted = textsOf(await h.send(h.admin, `/liberar ${stranger} 15`));
      expect(granted.join('\n')).toMatch(/ainda não falou/);
      const created = await h.runtime.db.getUser(`${stranger}@s.whatsapp.net`);
      expect(created?.balance).toBe(15);
      expect(created?.hasInbound).toBe(false);
      expect(h.runtime.outbox().some((item) => item.jid === `${stranger}@s.whatsapp.net`)).toBe(false);

      await h.send(stranger, 'oi');
      const again = textsOf(await h.send(h.admin, `/liberar ${stranger} pack15`));
      expect(again.join('\n')).toMatch(/Avisei/);
      expect((await h.runtime.db.getUser(`${stranger}@s.whatsapp.net`))?.balance).toBe(30);

      await h.send(h.admin, '/planos set pack15 preco 4,20');
      const listed = textsOf(await h.send(h.user, '/planos'));
      expect(listed.join('\n')).toContain('R$ 4,20');
      await h.send(h.admin, '/planos reset pack15');
      const reset = textsOf(await h.send(h.user, '/planos'));
      expect(reset.join('\n')).toContain('R$ 3,50');
    } finally {
      await h.cleanup();
    }
  });

  it('liga e desliga VIP e resume vendas do dia', async () => {
    const h = await createHarness();
    try {
      const empty = textsOf(await h.send(h.admin, '/vip'));
      expect(empty.join('\n')).toMatch(/Nenhum VIP/);
      await h.send(h.admin, `/vip ${h.user}`);
      await h.send(h.user, 'oi');
      const row = await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`);
      expect(row?.isVip).toBe(true);
      const png = await redPng();
      const sent = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      expect(sent.some((item) => item.type === 'sticker')).toBe(true);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(0);
      await h.send(h.admin, `/unvip ${h.user}`);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.isVip).toBe(false);

      await h.send(h.user, '/comprar 15');
      const open = await h.runtime.db.listOpenPayments(`${h.user}@s.whatsapp.net`);
      const gateway = h.runtime.gateway;
      if (!(gateway instanceof MockGateway) || !open[0]?.mpId) throw new Error('gateway mock');
      gateway.approve(open[0].mpId);
      const response = await postWebhook(h.runtime, open[0].mpId);
      expect(response.statusCode).toBe(200);
      const sales = textsOf(await h.send(h.admin, '/vendas')).join('\n');
      expect(sales).toContain('Hoje: 1 · R$ 3,50');
      expect(sales).toContain('Esta semana: 1 · R$ 3,50');
      expect(sales).toContain('Este mês: 1 · R$ 3,50');
    } finally {
      await h.cleanup();
    }
  });

  it('admin faz figurinha sem descontar e sem furar o aquecimento quando o bypass está ligado', async () => {
    const h = await createHarness(({ config }) => {
      config.safety.warmup = [{ day: 1, dailyLimit: 0 }];
      config.safety.adminBypassesWarmup = true;
    });
    try {
      const png = await redPng();
      await h.send(h.user, 'oi');
      await h.runtime.db.grantPlan(h.user, (await h.runtime.db.getPlan('pack15'))!, h.nowBox.value);
      const blocked = textsOf(await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } }));
      expect(blocked.join('\n')).toMatch(/limite de hoje/);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(15);
      await h.runtime.db.grantPlan(h.admin, (await h.runtime.db.getPlan('pack15'))!, h.nowBox.value);
      const before = (await h.runtime.db.getUser(`${h.admin}@s.whatsapp.net`))?.balance;
      await h.send(h.admin, 'oi');
      const sent = await h.send(h.admin, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      expect(sent.some((item) => item.type === 'sticker')).toBe(true);
      expect((await h.runtime.db.getUser(`${h.admin}@s.whatsapp.net`))?.balance).toBe(before);
    } finally {
      await h.cleanup();
    }
  });
});
