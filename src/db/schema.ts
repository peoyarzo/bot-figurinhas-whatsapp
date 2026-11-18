import type { Client } from '@libsql/client';

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS wa_creds (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wa_keys (
    type TEXT NOT NULL,
    key_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (type, key_id)
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    jid TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    push_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    trial_remaining INTEGER NOT NULL DEFAULT 0,
    stickers_used INTEGER NOT NULL DEFAULT 0,
    plan_id TEXT,
    plan_expires_at INTEGER,
    is_vip INTEGER NOT NULL DEFAULT 0,
    has_inbound INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone)`,
  `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    kind TEXT NOT NULL,
    credits INTEGER,
    duration_days INTEGER,
    price_is_placeholder INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    edited INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    mp_id TEXT UNIQUE,
    jid TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    plan_name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    kind TEXT NOT NULL,
    credits_snapshot INTEGER,
    duration_days_snapshot INTEGER,
    status TEXT NOT NULL,
    qr_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    applied_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payments_jid_status ON payments (jid, status)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_applied ON payments (applied_at)`,
  `CREATE TABLE IF NOT EXISTS payment_grants (
    mp_id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL,
    granted_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS daily_counts (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vip_phones (
    phone TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_grants (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

export async function migrate(client: Client): Promise<void> {
  try {
    await client.execute('PRAGMA journal_mode = WAL');
  } catch {
    // Turso remoto não aceita este pragma. O arquivo local aceita.
  }
  try {
    await client.execute('PRAGMA busy_timeout = 5000');
  } catch {
    // idem
  }
  for (const statement of SCHEMA) {
    await client.execute(statement);
  }
}
