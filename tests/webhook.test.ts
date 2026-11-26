import { describe, expect, it } from 'vitest';
import { buildManifest, signWebhook, verifyMpSignature } from '../src/payments/signature.js';
import { MockGateway } from '../src/payments/gateway.js';
import { createHarness, postWebhook } from './helpers.js';

describe('webhook do Mercado Pago', () => {
  it('monta o manifesto e rejeita assinatura velha ou errada', () => {
    expect(buildManifest('ABC', 'req', '1000')).toBe('id:abc;request-id:req;ts:1000;');
    expect(buildManifest('12', '', '1000')).toBe('id:12;ts:1000;');
    const now = Date.now();
    const signature = signWebhook({ dataId: 'ABC', requestId: 'req', ts: String(now), secret: 'segredo' });
    expect(verifyMpSignature({ signatureHeader: signature, requestId: 'req', dataId: 'ABC', secret: 'segredo', nowMs: now, maxSkewMs: 60_000 })).toBe(true);
    const seconds = signWebhook({ dataId: '99', requestId: 'req', ts: String(Math.floor(now / 1000)), secret: 'segredo' });
    expect(verifyMpSignature({ signatureHeader: seconds, requestId: 'req', dataId: '99', secret: 'segredo', nowMs: now, maxSkewMs: 60_000 })).toBe(true);
    expect(verifyMpSignature({ signatureHeader: signature, requestId: 'req', dataId: 'ABC', secret: 'outro', nowMs: now, maxSkewMs: 60_000 })).toBe(false);
    const old = signWebhook({ dataId: 'ABC', requestId: 'req', ts: String(now - 60 * 60 * 1000), secret: 'segredo' });
    expect(verifyMpSignature({ signatureHeader: old, requestId: 'req', dataId: 'ABC', secret: 'segredo', nowMs: now, maxSkewMs: 10 * 60 * 1000 })).toBe(false);
  });

  it('libera uma vez, ignora repetição e não libera pagamento pendente', async () => {
    const h = await createHarness();
    try {
      await h.send(h.user, '/comprar 15');
      const open = await h.runtime.db.listOpenPayments(`${h.user}@s.whatsapp.net`);
      const mpId = open[0]?.mpId;
      if (!mpId) throw new Error('sem pagamento');
      const gateway = h.runtime.gateway;
      if (!(gateway instanceof MockGateway)) throw new Error('mock');
      const pending = await postWebhook(h.runtime, mpId);
      expect(pending.statusCode).toBe(200);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(0);

      gateway.approve(mpId);
      const [first, second] = await Promise.all([postWebhook(h.runtime, mpId), postWebhook(h.runtime, mpId)]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(15);
      const third = await postWebhook(h.runtime, mpId);
      expect(third.statusCode).toBe(200);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(15);

      const bad = await h.runtime.app.inject({
        method: 'POST',
        url: `/webhooks/mercadopago?data.id=${mpId}&type=payment`,
        headers: { 'content-type': 'application/json', 'x-signature': 'ts=1,v1=abcd', 'x-request-id': 'nope' },
        payload: { type: 'payment', data: { id: mpId } },
      });
      expect(bad.statusCode).toBe(401);
      expect((await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`))?.balance).toBe(15);
    } finally {
      await h.cleanup();
    }
  });

  it('consulta o status quando o webhook não chega', async () => {
    const h = await createHarness();
    try {
      await h.send(h.user, '/comprar pack25');
      const open = await h.runtime.db.listOpenPayments(`${h.user}@s.whatsapp.net`);
      const gateway = h.runtime.gateway;
      if (!(gateway instanceof MockGateway) || !open[0]?.mpId) throw new Error('mock');
      gateway.approve(open[0].mpId);
      await h.send(h.user, '/status');
      const user = await h.runtime.db.getUser(`${h.user}@s.whatsapp.net`);
      expect(user?.balance).toBe(25);
      const card = h.runtime.outbox().find((item) => item.type === 'image');
      expect(card && card.type === 'image' && card.buffer.length).toBeGreaterThan(1000);
    } finally {
      await h.cleanup();
    }
  });

  it('responde 503 se o segredo do webhook não existe', async () => {
    const h = await createHarness(({ env }) => {
      env.MP_WEBHOOK_SECRET = undefined;
    });
    try {
      const response = await h.runtime.app.inject({
        method: 'POST',
        url: '/webhooks/mercadopago',
        headers: { 'content-type': 'application/json' },
        payload: { type: 'payment', data: { id: '1' } },
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await h.cleanup();
    }
  });
});
