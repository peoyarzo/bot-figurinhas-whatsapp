import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { createRuntime } from './runtime.js';

const log = createLogger();
const env = loadEnv();
if (env.NODE_ENV === 'production' && env.LIBSQL_URL.startsWith('file:')) {
  log.warn('LIBSQL_URL aponta para arquivo local. No Render o disco é apagado — use Turso.');
}
const runtime = await createRuntime(env, { logger: log });
await runtime.app.listen({ port: env.PORT, host: env.HOST });
log.info(`HTTP em ${env.HOST}:${env.PORT}`, { mockWhatsapp: env.MOCK_WHATSAPP, mockMp: env.MOCK_MP });

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('encerrando');
  await runtime.close();
  process.exit(0);
}
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
