import { createClient, type Client } from '@libsql/client';
import type { Env } from '../env.js';

export function createDbClient(env: Pick<Env, 'LIBSQL_URL' | 'LIBSQL_AUTH_TOKEN'>): Client {
  return createClient({
    url: env.LIBSQL_URL,
    authToken: env.LIBSQL_AUTH_TOKEN,
  });
}
