import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { afterEach, describe, expect, it } from 'vitest';
import { useLibsqlAuthState } from '../src/whatsapp/auth-state.js';

const files: string[] = [];

async function tempClient(): Promise<{ client: Client; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'figbot-auth-'));
  const file = path.join(dir, 'auth.db');
  files.push(dir);
  return { client: createClient({ url: `file:${file}` }), file };
}

afterEach(async () => {
  await Promise.all(files.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('auth state no libSQL', () => {
  it('grava credenciais e reaproveita na próxima abertura', async () => {
    const { client } = await tempClient();
    const first = await useLibsqlAuthState(client);
    const original = Buffer.from(first.state.creds.noiseKey.public);
    expect(first.state.creds.registered).toBe(false);
    first.state.creds.registered = true;
    first.state.creds.accountSyncCounter = 4;
    await first.saveCreds();
    const second = await useLibsqlAuthState(client);
    expect(second.state.creds.registered).toBe(true);
    expect(second.state.creds.accountSyncCounter).toBe(4);
    expect(Buffer.from(second.state.creds.noiseKey.public).equals(original)).toBe(true);
    const fresh = initAuthCreds();
    expect(Buffer.from(fresh.noiseKey.public).equals(original)).toBe(false);
    client.close();
  });

  it('grava chaves em um único lote e apaga com null', async () => {
    const { client } = await tempClient();
    let batches = 0;
    const original = client.batch.bind(client);
    client.batch = async (stmts, mode) => {
      batches += 1;
      return original(stmts, mode);
    };
    const { state } = await useLibsqlAuthState(client);
    const key = proto.Message.AppStateSyncKeyData.fromObject({ keyData: Buffer.from([9, 8, 7]), fingerprint: { rawId: 3 } });
    await state.keys.set({
      'pre-key': { '1': { public: Buffer.from('abc'), private: Buffer.from('def') }, '2': { public: Buffer.from('ghi'), private: Buffer.from('jkl') } },
      session: { abc: Buffer.from([1, 2, 3]) },
      'app-state-sync-key': { k1: key },
    });
    expect(batches).toBe(1);
    const pre = await state.keys.get('pre-key', ['1', 'missing']);
    expect(Buffer.from(pre['1'].public).equals(Buffer.from('abc'))).toBe(true);
    expect(pre.missing).toBeUndefined();
    const session = await state.keys.get('session', ['abc']);
    expect(Buffer.from(session.abc).equals(Buffer.from([1, 2, 3]))).toBe(true);
    await state.keys.set({ 'pre-key': { '1': null } });
    const gone = await state.keys.get('pre-key', ['1']);
    expect(gone['1']).toBeUndefined();
    const reloaded = await useLibsqlAuthState(client);
    const again = await reloaded.state.keys.get('app-state-sync-key', ['k1']);
    expect(Buffer.from(again.k1.keyData as Uint8Array).equals(Buffer.from([9, 8, 7]))).toBe(true);
    await reloaded.state.keys.clear?.();
    const cleared = await reloaded.state.keys.get('session', ['abc']);
    expect(cleared.abc).toBeUndefined();
    expect(BufferJSON).toBeTruthy();
    client.close();
  });
});
