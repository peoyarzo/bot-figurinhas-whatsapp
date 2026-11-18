import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import type { PaymentGateway } from './payments/gateway.js';
import type { SlidingWindowLimiter } from './safety/limiter.js';
import type { SendQueue } from './safety/queue.js';
import type { Messenger } from './whatsapp/messenger.js';

export type AppContext = {
  config: AppConfig;
  env: Env;
  log: Logger;
  db: Database;
  gateway: PaymentGateway;
  messenger: Messenger;
  limiter: SlidingWindowLimiter;
  queue: SendQueue;
  now: () => number;
  refreshAt: Map<string, number>;
};
