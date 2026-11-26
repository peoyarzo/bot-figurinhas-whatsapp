import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Outbound } from '../whatsapp/messenger.js';
import QRCode from 'qrcode';
import type { AppContext } from '../context.js';
import { processPaymentNotification } from '../payments/flow.js';
import { verifyMpSignature } from '../payments/signature.js';
import { safeEqual } from '../security.js';
import { toJid } from '../phone.js';
import { handleInbound } from '../bot/handle-message.js';
import type { InboundMessage } from '../types.js';
import { MockGateway } from '../payments/gateway.js';
import type { ConnectionHandle } from '../whatsapp/connection.js';
import type { RecordingMessenger } from '../whatsapp/messenger.js';
import { homePage, qrPage } from './pages.js';
import { registerAdmin } from './admin.js';

export type HttpDeps = {
  ctx: AppContext;
  connection: ConnectionHandle;
  recording: RecordingMessenger | null;
};

export function buildServer(deps: HttpDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  const { ctx, connection } = deps;

  app.setErrorHandler((error, _request, reply) => {
    ctx.log.error('erro http', error);
    return reply.code(500).send({ ok: false });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ ok: false, error: 'não encontrado' }));

  app.get('/', async (_request, reply) => {
    const paused = await ctx.db.isPaused();
    return reply.type('text/html; charset=utf-8').send(homePage({ whatsapp: connection.snapshot().status, paused }));
  });

  app.get('/health', async (_request, reply) => {
    try {
      await ctx.db.ping();
    } catch (error) {
      ctx.log.error('banco indisponível', error);
      return reply.code(503).send({ ok: false });
    }
    const paused = await ctx.db.isPaused();
    return {
      ok: true,
      service: 'zapfig',
      whatsapp: connection.snapshot().status,
      paused,
      uptimeSec: Math.round(process.uptime()),
    };
  });

  app.get('/qr', async (request, reply) => {
    const token = queryToken(request);
    if (!safeEqual(token, ctx.env.ADMIN_TOKEN)) return reply.code(401).send('não autorizado');
    const snapshot = connection.snapshot();
    const qrDataUrl = snapshot.qr ? await QRCode.toDataURL(snapshot.qr, { margin: 1, width: 320 }) : null;
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(qrPage({ snapshot, qrDataUrl, token }));
  });

  app.post('/session/reset', async (request, reply) => {
    const token = queryToken(request);
    if (!safeEqual(token, ctx.env.ADMIN_TOKEN)) return reply.code(401).send({ ok: false });
    if (connection.snapshot().status === 'mock') return reply.code(409).send({ ok: false, error: 'modo mock não tem sessão de WhatsApp' });
    await connection.resetAndRestart();
    return reply.redirect(`/qr?token=${encodeURIComponent(token)}`);
  });

  app.post('/webhooks/mercadopago', async (request, reply) => {
    if (!ctx.env.MP_WEBHOOK_SECRET) return reply.code(503).send({ ok: false, error: 'webhook não configurado' });
    const query = (request.query ?? {}) as Record<string, unknown>;
    const dataId = readDataId(query, request.body);
    const requestId = header(request, 'x-request-id');
    const valid = verifyMpSignature({
      signatureHeader: header(request, 'x-signature'),
      requestId,
      dataId,
      secret: ctx.env.MP_WEBHOOK_SECRET,
      nowMs: Date.now(),
      maxSkewMs: ctx.config.payments.webhookMaxSkewMs,
    });
    if (!valid) return reply.code(401).send({ ok: false, error: 'assinatura inválida' });
    const type = readType(query, request.body);
    if (!dataId || (type && type !== 'payment')) return reply.code(200).send({ ok: true, ignored: true });
    try {
      await processPaymentNotification(ctx, dataId);
    } catch (error) {
      ctx.log.error('falha ao processar webhook', error);
      return reply.code(500).send({ ok: false });
    }
    return reply.code(200).send({ ok: true });
  });

  if (ctx.env.MOCK_WHATSAPP) {
    app.post('/mock/inbound', async (request, reply) => {
      if (!authorized(request, ctx.env.ADMIN_TOKEN)) return reply.code(401).send({ ok: false });
      const body = (request.body ?? {}) as {
        phone?: string;
        text?: string;
        pushName?: string;
        fromGroup?: boolean;
        imageBase64?: string;
        videoBase64?: string;
        mimetype?: string;
      };
      const phone = (body.phone ?? '').replace(/\D/g, '');
      if (phone.length < 10) return reply.code(400).send({ ok: false, error: 'phone inválido' });
      const before = deps.recording ? deps.recording.sent.length : 0;
      const message: InboundMessage = {
        jid: toJid(phone),
        phone,
        pushName: body.pushName,
        text: body.text ?? '',
        fromGroup: Boolean(body.fromGroup),
      };
      if (body.imageBase64) message.media = { kind: 'image', mimetype: body.mimetype ?? 'image/png', buffer: decodeBase64(body.imageBase64) };
      else if (body.videoBase64) message.media = { kind: 'video', mimetype: body.mimetype ?? 'video/mp4', buffer: decodeBase64(body.videoBase64) };
      await handleInbound(ctx, message);
      const fresh = deps.recording ? deps.recording.sent.slice(before) : [];
      return { ok: true, replies: fresh.map(summarize) };
    });
    app.get('/mock/outbox', async (request, reply) => {
      if (!authorized(request, ctx.env.ADMIN_TOKEN)) return reply.code(401).send({ ok: false });
      return { ok: true, replies: (deps.recording?.sent ?? []).map(summarize) };
    });
  }

  if (ctx.gateway instanceof MockGateway) {
    const gateway = ctx.gateway;
    app.post('/mock/payments/:mpId/approve', async (request, reply) => {
      if (!authorized(request, ctx.env.ADMIN_TOKEN)) return reply.code(401).send({ ok: false });
      const mpId = (request.params as { mpId: string }).mpId;
      if (!gateway.approve(mpId)) return reply.code(404).send({ ok: false });
      return { ok: true };
    });
  }

  registerAdmin(app, ctx);
  return app;
}

function queryToken(request: FastifyRequest): string {
  const query = request.query as { token?: string | string[] };
  const value = Array.isArray(query.token) ? query.token[0] : query.token;
  return value ?? '';
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function authorized(request: FastifyRequest, expected: string): boolean {
  const headerToken = header(request, 'x-admin-token');
  const query = queryToken(request);
  return safeEqual(headerToken, expected) || safeEqual(query, expected);
}

function readDataId(query: Record<string, unknown>, body: unknown): string {
  const direct = query['data.id'];
  if (typeof direct === 'string' && direct) return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  const nested = query.data;
  if (nested && typeof nested === 'object' && 'id' in nested) {
    const id = (nested as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  if (body && typeof body === 'object' && 'data' in body) {
    const id = (body as { data?: { id?: unknown } }).data?.id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return '';
}

function readType(query: Record<string, unknown>, body: unknown): string {
  if (typeof query.type === 'string') return query.type;
  if (body && typeof body === 'object' && typeof (body as { type?: unknown }).type === 'string') return (body as { type: string }).type;
  return '';
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value.replace(/^data:[^;]+;base64,/, ''), 'base64');
}

function summarize(item: Outbound) {
  if (item.type === 'text') return { type: item.type, jid: item.jid, text: item.text };
  if (item.type === 'typing') return { type: item.type, jid: item.jid };
  if (item.type === 'image') return { type: item.type, jid: item.jid, caption: item.caption, bytes: item.buffer.length };
  return { type: item.type, jid: item.jid, bytes: item.buffer.length };
}
