import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import type { Client } from '@libsql/client';
import { migrate } from '../db/schema.js';

const CREDS_ID = 'default';

type CacheValue = unknown;

function revive(type: string, value: unknown): unknown {
  if (type === 'app-state-sync-key' && value) {
    return proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Sessão do Baileys (creds + keys) no libSQL.
 * Cada keys.set vira um único batch — a própria lib agrupa as mutações
 * e entrega tudo de uma vez no fim da transação dela.
 * Um processo novo lê de novo e reaproveita a mesma sessão.
 */
export async function useLibsqlAuthState(client: Client): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  await migrate(client);
  const cache = new Map<string, CacheValue>();
  const existing = await client.execute({ sql: 'SELECT data FROM wa_creds WHERE id = ?', args: [CREDS_ID] });
  let creds: AuthenticationCreds;
  if (existing.rows.length) {
    creds = JSON.parse(String(existing.rows[0].data), BufferJSON.reviver) as AuthenticationCreds;
  } else {
    creds = initAuthCreds();
    await writeCreds(client, creds);
  }

  const keys: AuthenticationState['keys'] = {
    get: async (type, ids) => {
      const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
      const missing: string[] = [];
      for (const id of ids) {
        const cached = cache.get(`${type}:${id}`);
        if (cached !== undefined) {
          if (cached !== null) result[id] = cached as SignalDataTypeMap[typeof type];
          continue;
        }
        missing.push(id);
      }
      for (let index = 0; index < missing.length; index += 80) {
        const chunk = missing.slice(index, index + 80);
        const placeholders = chunk.map(() => '?').join(',');
        const loaded = await client.execute({
          sql: `SELECT key_id, data FROM wa_keys WHERE type = ? AND key_id IN (${placeholders})`,
          args: [type, ...chunk],
        });
        const found = new Set<string>();
        for (const row of loaded.rows) {
          const id = String(row.key_id);
          found.add(id);
          const parsed = revive(type, JSON.parse(String(row.data), BufferJSON.reviver));
          cache.set(`${type}:${id}`, parsed);
          result[id] = parsed as SignalDataTypeMap[typeof type];
        }
        for (const id of chunk) {
          if (!found.has(id)) cache.set(`${type}:${id}`, null);
        }
      }
      return result;
    },
    set: async (data: SignalDataSet) => {
      const statements: Array<{ sql: string; args: Array<string | null> }> = [];
      for (const type of Object.keys(data) as Array<keyof SignalDataSet>) {
        const entries = data[type];
        if (!entries) continue;
        for (const id of Object.keys(entries)) {
          const value = entries[id];
          const cacheKey = `${type}:${id}`;
          if (value == null) {
            cache.set(cacheKey, null);
            statements.push({ sql: 'DELETE FROM wa_keys WHERE type = ? AND key_id = ?', args: [type, id] });
            continue;
          }
          cache.set(cacheKey, value);
          statements.push({
            sql: `INSERT INTO wa_keys (type, key_id, data) VALUES (?, ?, ?)
                  ON CONFLICT(type, key_id) DO UPDATE SET data = excluded.data`,
            args: [type, id, JSON.stringify(value, BufferJSON.replacer)],
          });
        }
      }
      if (statements.length) await client.batch(statements, 'write');
    },
    clear: async () => {
      cache.clear();
      await client.execute('DELETE FROM wa_keys');
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await writeCreds(client, creds);
    },
  };
}

async function writeCreds(client: Client, creds: AuthenticationCreds): Promise<void> {
  await client.execute({
    sql: `INSERT INTO wa_creds (id, data, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    args: [CREDS_ID, JSON.stringify(creds, BufferJSON.replacer), Date.now()],
  });
}

export async function clearAuthState(client: Client): Promise<void> {
  await migrate(client);
  await client.batch(
    [
      { sql: 'DELETE FROM wa_creds', args: [] },
      { sql: 'DELETE FROM wa_keys', args: [] },
    ],
    'write',
  );
}
