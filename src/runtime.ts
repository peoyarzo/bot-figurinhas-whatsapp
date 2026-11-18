import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { createDbClient } from './db/client.js';
import { Database } from './db/database.js';
import type { Env } from './env.js';
import { createLogger, type Logger } from './logger.js';
import { createGateway } from './payments/gateway.js';
import { SlidingWindowLimiter } from './safety/limiter.js';
import { SendQueue } from './safety/queue.js';
import { handleInbound } from './bot/handle-message.js';
import { buildServer } from './http/server.js';
import type { InboundMessage } from './types.js';
import { GuardedMessenger, RecordingMessenger, type Messenger, type Outbound } from './whatsapp/messenger.js';
import { mockConnection, type ConnectionHandle } from './whatsapp/connection.js';
import type { FastifyInstance } from 'fastify';
import type { Client } from '@libsql/client';

export type Runtime = {
  env: Env;
  config: AppConfig;
  db: Database;
  gateway: ReturnType<typeof createGateway>;
  app: FastifyInstance;
  log: Logger;
  outbox: () => Outbound[];
  handle: (message: InboundMessage) => Promise<void>;
  connection: ConnectionHandle;
  close: () => Promise<void>;
  client: Client;
};

export async function createRuntime(
  env: Env,
  options?: {
    config?: AppConfig;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    logger?: Logger;
  },
): Promise<Runtime> {
  const config = options?.config ?? loadConfig();
  const now = options?.now ?? (() => Date.now());
  const log = options?.logger ?? createLogger();
  const client = createDbClient(env);
  const db = new Database(client);
  await db.migrate();
  await db.seedPlans(config.plans);
  await db.ensureBirthday(now());
  const gateway = createGateway(env);
  const recording = env.MOCK_WHATSAPP ? new RecordingMessenger() : null;
  let raw: Messenger = recording ?? {
    async sendText() {
      throw new Error('socket ainda não está pronto');
    },
    async sendImage() {
      throw new Error('socket ainda não está pronto');
    },
    async sendSticker() {
      throw new Error('socket ainda não está pronto');
    },
    async sendTyping() {
      throw new Error('socket ainda não está pronto');
    },
  };
  const messenger = new GuardedMessenger(
    {
      sendText: (jid, text) => raw.sendText(jid, text),
      sendImage: (jid, buffer, caption) => raw.sendImage(jid, buffer, caption),
      sendSticker: (jid, buffer) => raw.sendSticker(jid, buffer),
      sendTyping: (jid) => raw.sendTyping(jid),
    },
    db,
    log,
  );
  const ctx: AppContext = {
    config,
    env,
    log,
    db,
    gateway,
    messenger,
    limiter: new SlidingWindowLimiter(now, 60_000),
    queue: new SendQueue({
      maxInFlight: config.safety.maxInFlight,
      jitterMinMs: config.safety.jitterMinMs,
      jitterMaxMs: config.safety.jitterMaxMs,
      sleep: options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options?.random ?? Math.random,
    }),
    now,
    refreshAt: new Map(),
  };
  let connection: ConnectionHandle = mockConnection();
  if (!env.MOCK_WHATSAPP) {
    const { buildBaileys } = await import('./whatsapp/baileys-socket.js');
    let dispatch: (message: InboundMessage) => Promise<void> = async () => {};
    const built = await buildBaileys({
      client,
      onMessage: (message) => dispatch(message),
      pairingNumber: env.PAIRING_NUMBER,
      markOnlineOnConnect: config.safety.markOnlineOnConnect,
      logger: log,
    });
    raw = built.messenger;
    connection = built.controller;
    dispatch = (message) => handleInbound(ctx, message);
    await built.controller.open();
  }
  const app = buildServer({ ctx, connection, recording });
  let closed = false;
  return {
    env,
    config,
    db,
    gateway,
    app,
    log,
    client,
    connection,
    outbox: () => (recording ? [...recording.sent] : []),
    handle: (message) => handleInbound(ctx, message),
    close: async () => {
      if (closed) return;
      closed = true;
      await connection.stop().catch(() => undefined);
      await app.close().catch(() => undefined);
      client.close();
    },
  };
}
