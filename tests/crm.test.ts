import { describe, expect, it } from 'vitest';
import { nextStage } from '../src/crm/stage.js';
import { getLeadByPhone, listLeadEvents } from '../src/crm/repository.js';
import { safeCrm } from '../src/crm/record.js';
import { MockGateway } from '../src/payments/gateway.js';
import { createHarness, postWebhook, redPng, textsOf } from './helpers.js';

describe('etapas do funil', () => {
  it('não volta no funil e marca onde a pessoa parou', () => {
    expect(nextStage(null, 'first_contact')).toBe('chamou');
    expect(nextStage('chamou', 'asked_help')).toBe('chamou');
    expect(nextStage('chamou', 'saw_plans')).toBe('viu_planos');
    expect(nextStage('viu_planos', 'chose_plan')).toBe('escolheu_plano');
    expect(nextStage('escolheu_plano', 'pix_generated')).toBe('pix_gerado');
    expect(nextStage('pix_gerado', 'saw_plans')).toBe('pix_gerado');
    expect(nextStage('pix_gerado', 'pix_expired')).toBe('pix_expirou');
    expect(nextStage('pagou', 'pix_expired')).toBe('pagou');
    expect(nextStage('pix_expirou', 'pix_generated')).toBe('pix_gerado');
    expect(nextStage('pix_gerado', 'paid')).toBe('pagou');
    expect(nextStage('pagou', 'sticker_made')).toBe('usando');
    expect(nextStage('usando', 'saw_plans')).toBe('usando');
    expect(nextStage('usando', 'credits_ran_out')).toBe('creditos_acabaram');
    expect(nextStage('creditos_acabaram', 'paid')).toBe('pagou');
    expect(nextStage('usando', 'plan_expired')).toBe('plano_venceu');
    expect(nextStage('pagou', 'vip_granted')).toBe('pagou');
    expect(nextStage('chamou', 'admin_released')).toBe('chamou');
  });
});

describe('registro de contatos', () => {
  it('anota menu, planos, pix, pagamento e figurinha sem derrubar o bot', async () => {
    const h = await createHarness();
    try {
      await h.send(h.user, '/menu');
      await h.send(h.user, '/planos');
      await h.send(h.user, '/comprar 15');
      const jid = `${h.user}@s.whatsapp.net`;
      let lead = await getLeadByPhone(h.runtime.db.client, h.user);
      expect(lead?.stage).toBe('pix_gerado');
      expect(lead?.pushName).toBe('Lia');
      const open = await h.runtime.db.listOpenPayments(jid);
      const gateway = h.runtime.gateway;
      if (!(gateway instanceof MockGateway) || !open[0]?.mpId) throw new Error('pix');
      gateway.approve(open[0].mpId);
      const paid = await postWebhook(h.runtime, open[0].mpId);
      expect(paid.statusCode).toBe(200);
      lead = await getLeadByPhone(h.runtime.db.client, h.user);
      expect(lead?.stage).toBe('pagou');
      expect(lead?.purchaseCount).toBe(1);
      expect(lead?.totalSpentCents).toBe(350);
      expect(lead?.lastPlanName).toBe('15 figurinhas');
      await h.send(h.user, '/formato recortar');
      const png = await redPng();
      const sent = await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      expect(sent.some((item) => item.type === 'sticker')).toBe(true);
      lead = await getLeadByPhone(h.runtime.db.client, h.user);
      expect(lead?.stage).toBe('usando');
      expect(lead?.stickersMade).toBe(1);
      expect(lead?.creditsLeft).toBe(14);
      const events = await listLeadEvents(h.runtime.db.client, jid);
      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain('first_contact');
      expect(kinds).toContain('asked_help');
      expect(kinds).toContain('saw_plans');
      expect(kinds).toContain('chose_plan');
      expect(kinds).toContain('pix_generated');
      expect(kinds).toContain('paid');
      expect(kinds).toContain('first_sticker');
      expect(kinds).not.toContain('sticker_made');
      expect(kinds.filter((kind) => kind === 'first_contact')).toHaveLength(1);
      expect(textsOf(await h.send(h.user, '/ajuda')).join('\n')).toContain('Seu número é usado só pra entregar suas figurinhas e créditos.');
    } finally {
      await h.cleanup();
    }
  });

  it('marca pix expirado e créditos acabados', async () => {
    const h = await createHarness();
    try {
      await h.send(h.user, '/comprar 15');
      const jid = `${h.user}@s.whatsapp.net`;
      const open = await h.runtime.db.listOpenPayments(jid);
      const gateway = h.runtime.gateway;
      if (!(gateway instanceof MockGateway) || !open[0]?.mpId) throw new Error('pix');
      gateway.setStatus(open[0].mpId, 'cancelled');
      const expired = await postWebhook(h.runtime, open[0].mpId);
      expect(expired.statusCode).toBe(200);
      expect((await getLeadByPhone(h.runtime.db.client, h.user))?.stage).toBe('pix_expirou');

      await h.runtime.db.grantPlan(h.user, (await h.runtime.db.getPlan('pack15'))!, h.nowBox.value);
      await h.runtime.client.execute({
        sql: 'UPDATE users SET balance = 1 WHERE jid = ?',
        args: [jid],
      });
      await h.runtime.client.execute({
        sql: 'UPDATE credit_lots SET remaining = 1 WHERE jid = ?',
        args: [jid],
      });
      await h.send(h.user, '/formato recortar');
      const png = await redPng();
      await h.send(h.user, '', { media: { kind: 'image', mimetype: 'image/png', buffer: png } });
      const lead = await getLeadByPhone(h.runtime.db.client, h.user);
      expect(lead?.creditsLeft).toBe(0);
      expect(lead?.stage).toBe('creditos_acabaram');
    } finally {
      await h.cleanup();
    }
  });

  it('ignora falha do crm', async () => {
    const lines: string[] = [];
    await safeCrm({ info() {}, warn(message) { lines.push(message); }, error() {} }, async () => {
      throw new Error('banco caiu');
    });
    expect(lines).toEqual(['crm ignorado']);
  });
});

describe('painel /admin', () => {
  it('fica escondido sem senha', async () => {
    const h = await createHarness();
    try {
      const response = await h.runtime.app.inject({ method: 'GET', url: '/admin' });
      expect(response.statusCode).toBe(404);
    } finally {
      await h.cleanup();
    }
  });

  it('recusa senha errada, aceita o cookie e filtra o csv', async () => {
    const h = await createHarness(({ env }) => {
      env.ADMIN_PASSWORD = 'segredo-do-painel';
      env.ADMIN_SESSION_SECRET = 'segredo-da-sessao';
    });
    try {
      const hidden = await h.runtime.app.inject({ method: 'GET', url: '/admin' });
      expect(hidden.statusCode).toBe(302);
      const wrong = await h.runtime.app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'password=nao-e-essa',
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.body).toContain('Senha incorreta.');
      expect(cookieOf(wrong)).toBe('');
      expect(wrong.headers['x-robots-tag']).toContain('noindex');

      const right = await h.runtime.app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'password=segredo-do-painel',
      });
      expect(right.statusCode).toBe(302);
      const cookie = cookieOf(right);
      expect(cookie).not.toBe('');

      await h.send(h.user, '/menu');
      await h.send('5511900000003', 'oi');
      const jid = `${h.user}@s.whatsapp.net`;
      await h.runtime.db.grantPlan(h.user, (await h.runtime.db.getPlan('pack15'))!, h.nowBox.value);
      await h.runtime.client.execute({
        sql: `UPDATE leads SET purchase_count = 1, total_spent_cents = 350, last_plan_id = 'pack15', last_plan_name = '15 figurinhas', current_stage = 'pagou' WHERE jid = ?`,
        args: [jid],
      });

      const dash = await h.runtime.app.inject({ method: 'GET', url: '/admin', headers: { cookie: `zapfig_admin=${cookie}` } });
      expect(dash.statusCode).toBe(200);
      expect(dash.body).toContain('Contatos');
      expect(dash.body).toContain('Conversão');

      const buyers = await h.runtime.app.inject({
        method: 'GET',
        url: '/admin/leads?bought=yes&q=Lia',
        headers: { cookie: `zapfig_admin=${cookie}` },
      });
      expect(buyers.statusCode).toBe(200);
      expect(buyers.body).toContain('Lia');
      expect(buyers.body).not.toContain('5511900000003');

      const csv = await h.runtime.app.inject({
        method: 'GET',
        url: '/admin/leads.csv?bought=yes',
        headers: { cookie: `zapfig_admin=${cookie}` },
      });
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.body).toContain('Lia');
      expect(csv.body).toContain('Pagou');
      expect(csv.body).not.toContain('5511900000003');

      const forged = await h.runtime.app.inject({
        method: 'GET',
        url: '/admin',
        headers: { cookie: 'zapfig_admin=nao.assinado' },
      });
      expect(forged.statusCode).toBe(302);

      const saved = await h.runtime.app.inject({
        method: 'POST',
        url: `/admin/leads/${h.user}`,
        headers: { cookie: `zapfig_admin=${cookie}`, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'notes=pediu+desconto&tags=quente',
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.body).toContain('pediu desconto');
      const lead = await getLeadByPhone(h.runtime.db.client, h.user);
      expect(lead?.notes).toBe('pediu desconto');
      expect(lead?.tags).toBe('quente');
    } finally {
      await h.cleanup();
    }
  });
});

function cookieOf(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const line = Array.isArray(raw) ? raw.join(';') : (raw ?? '');
  return /zapfig_admin=([^;]+)/.exec(line)?.[1] ?? '';
}
