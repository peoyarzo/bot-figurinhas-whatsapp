import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { signWebhook } from './payments/signature.js';
import { createRuntime, type Runtime } from './runtime.js';
import { readStickerExif } from './stickers/exif.js';
import { toJid } from './phone.js';
import type { InboundMessage } from './types.js';

export type DemoReport = {
  transcript: string;
  balance: number;
  trial: number;
  stickerBytes: number;
  cardBytes: number;
  webhookStatuses: number[];
  salesText: string;
};

export async function startDemo(): Promise<DemoReport> {
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-demo-'));
  const env = loadEnv({
    ADMIN_TOKEN: 'demo-token',
    ADMIN_NUMBERS: '5511900000099',
    LIBSQL_URL: `file:${path.join(dir, 'demo.db')}`,
    MOCK_WHATSAPP: '1',
    MOCK_MP: '1',
    MP_WEBHOOK_SECRET: 'demo-secret',
    MP_PAYER_FIRST_NAME: 'APRO',
  });
  const config = loadConfig();
  config.safety.jitterMinMs = 0;
  config.safety.jitterMaxMs = 0;
  const runtime = await createRuntime(env, { config });
  try {
    return await runPurchaseFlow(runtime, { userPhone: '5511900000001', adminPhone: '5511900000099', pushName: 'Lia' });
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runPurchaseFlow(runtime: Runtime, input: { userPhone: string; adminPhone: string; pushName: string }): Promise<DemoReport> {
  const lines: string[] = [];
  const say = async (phone: string, text: string, pushName: string, extra?: Partial<InboundMessage>) => {
    const before = runtime.outbox().length;
    await runtime.handle({ jid: toJid(phone), phone, text, pushName, fromGroup: false, ...extra });
    const fresh = runtime.outbox().slice(before);
    lines.push(`> ${phone}: ${text || extra?.media?.kind || '(mídia)'}`);
    for (const item of fresh) {
      if (item.type === 'text') lines.push(`< ${item.text}`);
      else lines.push(`< ${item.type}${item.type === 'image' || item.type === 'sticker' ? ` ${item.buffer.length} bytes` : ''}`);
    }
    return fresh;
  };

  const health = await runtime.app.inject({ method: 'GET', url: '/health' });
  if (health.statusCode !== 200) throw new Error(`health ${health.statusCode}`);
  const denied = await runtime.app.inject({ method: 'GET', url: '/qr' });
  if (denied.statusCode !== 401) throw new Error('QR sem token deveria ser 401');
  const qr = await runtime.app.inject({ method: 'GET', url: '/qr?token=demo-token' });
  if (qr.statusCode !== 200 || !qr.body.includes('MOCK_WHATSAPP')) throw new Error('página de QR em modo mock não apareceu');

  await say(input.userPhone, '/menu', input.pushName);
  await say(input.userPhone, '/planos', input.pushName);
  await say(input.userPhone, '/comprar 15', input.pushName);
  const open = await runtime.db.listOpenPayments(toJid(input.userPhone));
  const mpId = open[0]?.mpId;
  if (!mpId) throw new Error('o Pix simulado não ganhou id');
  const approved = await runtime.app.inject({
    method: 'POST',
    url: `/mock/payments/${mpId}/approve`,
    headers: { 'x-admin-token': runtime.env.ADMIN_TOKEN },
  });
  if (approved.statusCode !== 200) throw new Error('não consegui simular a aprovação APRO');
  const beforeWebhook = runtime.outbox().length;
  const statuses = [await postWebhook(runtime, mpId), await postWebhook(runtime, mpId)];
  if (statuses.some((status) => status !== 200)) throw new Error(`webhook inesperado: ${statuses.join(',')}`);
  for (const item of runtime.outbox().slice(beforeWebhook)) {
    if (item.type === 'text') lines.push(`< ${item.text}`);
  }
  const afterPay = await runtime.db.getUser(toJid(input.userPhone));
  if (!afterPay || afterPay.balance !== 15) throw new Error(`saldo depois do pagamento: ${afterPay?.balance}`);
  lines.push(`saldo após o Pix (e o webhook repetido): ${afterPay.balance}`);

  const image = await sharp({
    create: { width: 640, height: 400, channels: 4, background: { r: 220, g: 40, b: 70, alpha: 1 } },
  }).png().toBuffer();
  const stickerReply = await say(input.userPhone, '', input.pushName, { media: { kind: 'image', mimetype: 'image/png', buffer: image } });
  const sticker = stickerReply.find((item) => item.type === 'sticker');
  if (!sticker || sticker.type !== 'sticker') throw new Error('figurinha não foi enviada');
  const meta = await sharp(sticker.buffer).metadata();
  if (meta.format !== 'webp' || meta.width !== 512 || meta.height !== 512) throw new Error('figurinha fora do formato 512 webp');
  const exif = readStickerExif(sticker.buffer);
  if (exif?.packName !== runtime.config.sticker.packName) throw new Error('EXIF sem o nome do pacote');
  const user = await runtime.db.getUser(toJid(input.userPhone));
  if (!user || user.balance !== 14) throw new Error(`saldo depois da figurinha: ${user?.balance}`);
  if (user.trialRemaining !== runtime.config.trial.freeStickers) throw new Error('o teste grátis foi consumido no lugar do pacote');

  const statusReply = await say(input.userPhone, '/status', input.pushName);
  const card = statusReply.find((item) => item.type === 'image');
  if (!card || card.type !== 'image') throw new Error('cartão de status não foi enviado');
  const salesReply = await say(input.adminPhone, '/vendas', 'Admin');
  const sales = salesReply.find((item) => item.type === 'text');
  const salesText = sales && sales.type === 'text' ? sales.text : '';
  if (!salesText.includes('R$ 3,50')) throw new Error(`vendas sem o Pix de 15: ${salesText}`);
  lines.push('Demo concluída sem abrir socket do WhatsApp. Jitter zerado aqui; em produção o atraso é aleatório.');
  return {
    transcript: lines.join('\n'),
    balance: user.balance,
    trial: user.trialRemaining,
    stickerBytes: sticker.buffer.length,
    cardBytes: card.buffer.length,
    webhookStatuses: statuses,
    salesText,
  };
}

async function postWebhook(runtime: Runtime, mpId: string): Promise<number> {
  const ts = String(Date.now());
  const requestId = `demo-${mpId}`;
  const signature = signWebhook({ dataId: mpId, requestId, ts, secret: runtime.env.MP_WEBHOOK_SECRET ?? '' });
  const response = await runtime.app.inject({
    method: 'POST',
    url: `/webhooks/mercadopago?data.id=${encodeURIComponent(mpId)}&type=payment`,
    headers: { 'content-type': 'application/json', 'x-signature': signature, 'x-request-id': requestId },
    payload: { action: 'payment.updated', type: 'payment', data: { id: mpId } },
  });
  return response.statusCode;
}
