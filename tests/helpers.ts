import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig, type AppConfig } from '../src/config.js';
import { loadEnv, type Env } from '../src/env.js';
import { toJid } from '../src/phone.js';
import { signWebhook } from '../src/payments/signature.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import type { InboundMessage } from '../src/types.js';
import type { Outbound } from '../src/whatsapp/messenger.js';

export async function createHarness(adjust?: (input: { config: AppConfig; env: Env }) => void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-'));
  const env = loadEnv({
    ADMIN_TOKEN: 'test-token',
    ADMIN_NUMBERS: '5511900000099',
    LIBSQL_URL: `file:${path.join(dir, 't.db')}`,
    MOCK_WHATSAPP: '1',
    MOCK_MP: '1',
    MP_WEBHOOK_SECRET: 'test-secret',
    MP_PAYER_EMAIL: 'pagador.sandbox@example.com',
    MP_PAYER_FIRST_NAME: 'APRO',
  });
  const config = loadConfig();
  config.trial.freeStickers = 0;
  config.safety.jitterMinMs = 0;
  config.safety.jitterMaxMs = 0;
  config.safety.perUserPerMinute = 20;
  config.safety.globalPerMinute = 100;
  config.safety.dailyLimitAfterWarmup = 1000;
  config.safety.warmup = [{ day: 1, dailyLimit: 1000 }];
  config.payments.refreshMinIntervalMs = 0;
  adjust?.({ config, env });
  const nowBox = { value: Date.parse('2026-11-18T15:00:00.000Z') };
  const runtime = await createRuntime(env, { config, now: () => nowBox.value });
  const user = '5511900000001';
  const admin = '5511900000099';
  return {
    runtime,
    env,
    config,
    nowBox,
    user,
    admin,
    async send(phone: string, text: string, extra?: Partial<InboundMessage>): Promise<Outbound[]> {
      const before = runtime.outbox().length;
      await runtime.handle({
        jid: toJid(phone),
        phone,
        text,
        fromGroup: false,
        pushName: phone === admin ? 'Admin' : 'Lia',
        ...extra,
      });
      return runtime.outbox().slice(before);
    },
    async cleanup() {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function redPng(): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 200, channels: 4, background: { r: 220, g: 30, b: 40, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

export async function postWebhook(runtime: Runtime, mpId: string, secret = 'test-secret', skewMs = 0): Promise<{ statusCode: number; body: string }> {
  const ts = String(Date.now() - skewMs);
  const requestId = `req-${mpId}-${skewMs}-${Math.random()}`;
  const signature = signWebhook({ dataId: mpId, requestId, ts, secret });
  const response = await runtime.app.inject({
    method: 'POST',
    url: `/webhooks/mercadopago?data.id=${encodeURIComponent(mpId)}&type=payment`,
    headers: { 'content-type': 'application/json', 'x-signature': signature, 'x-request-id': requestId },
    payload: { action: 'payment.updated', type: 'payment', data: { id: mpId } },
  });
  return { statusCode: response.statusCode, body: response.body };
}

export function textsOf(items: Outbound[]): string[] {
  return items.filter((item) => item.type === 'text').map((item) => (item.type === 'text' ? item.text : ''));
}
