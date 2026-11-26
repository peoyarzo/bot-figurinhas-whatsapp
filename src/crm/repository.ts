import { randomUUID } from 'node:crypto';
import type { Client, InValue } from '@libsql/client';
import { phoneFromJid } from '../phone.js';
import { isLeadStage, nextStage, type LeadEventKind, type LeadStage } from './stage.js';

export type LeadRow = {
  jid: string;
  phone: string;
  pushName: string | null;
  firstSeen: number;
  lastSeen: number;
  stage: LeadStage;
  lastPlanId: string | null;
  lastPlanName: string | null;
  totalSpentCents: number;
  purchaseCount: number;
  stickersMade: number;
  creditsLeft: number;
  expiresAt: number | null;
  source: string | null;
  notes: string;
  tags: string;
};

export type LeadEventRow = {
  id: string;
  jid: string;
  kind: string;
  createdAt: number;
  detail: string | null;
};

export type LeadQuery = {
  q?: string;
  stage?: string;
  bought?: 'yes' | 'no' | '';
  planId?: string;
  fromMs?: number | null;
  toMs?: number | null;
  sort?: 'last_seen' | 'first_seen' | 'name' | 'spent' | 'stickers' | 'stage';
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
};

const SORT: Record<NonNullable<LeadQuery['sort']>, string> = {
  last_seen: 'last_seen',
  first_seen: 'first_seen',
  name: 'LOWER(COALESCE(push_name, phone))',
  spent: 'total_spent_cents',
  stickers: 'stickers_made',
  stage: `CASE current_stage
    WHEN 'chamou' THEN 1 WHEN 'viu_planos' THEN 2 WHEN 'escolheu_plano' THEN 3
    WHEN 'pix_gerado' THEN 4 WHEN 'pix_expirou' THEN 5 WHEN 'pagou' THEN 6
    WHEN 'usando' THEN 7 WHEN 'creditos_acabaram' THEN 8 WHEN 'plano_venceu' THEN 9
    ELSE 0 END`,
};

const UNIQUE_KINDS = new Set<LeadEventKind>(['first_contact', 'first_sticker', 'paid', 'pix_expired', 'plan_expired']);

export async function applyLeadEvent(
  client: Client,
  input: {
    jid: string;
    phone?: string;
    pushName?: string | null;
    now: number;
    kind: LeadEventKind;
    detail?: string | null;
    planId?: string | null;
    planName?: string | null;
    amountCents?: number | null;
  },
): Promise<void> {
  const phone = input.phone?.replace(/\D/g, '') || phoneFromJid(input.jid);
  const user = await one(client, 'SELECT * FROM users WHERE jid = ?', [input.jid]);
  const lots = await client.execute({
    sql: `SELECT expires_at FROM credit_lots
          WHERE jid = ? AND remaining > 0 AND expires_at IS NOT NULL AND expires_at > ?
          ORDER BY expires_at ASC LIMIT 1`,
    args: [input.jid, input.now],
  });
  const existing = await one(client, 'SELECT * FROM leads WHERE jid = ?', [input.jid]);
  const current = existing && isLeadStage(str(existing, 'current_stage')) ? (str(existing, 'current_stage') as LeadStage) : null;
  const stage = nextStage(current, input.kind) ?? current ?? 'chamou';
  const planExpires = user ? numOrNull(user, 'plan_expires_at') : null;
  const creditExpires = lots.rows.length ? numOrNull(row(lots.rows[0]), 'expires_at') : null;
  const activePlan = planExpires != null && planExpires > input.now ? planExpires : null;
  const expiries = [activePlan, creditExpires].filter((value): value is number => value != null);
  const expiresAt = expiries.length ? Math.min(...expiries) : null;
  const stickers = user ? num(user, 'stickers_used') : existing ? num(existing, 'stickers_made') : 0;
  const credits = user ? num(user, 'balance') : existing ? num(existing, 'credits_left') : 0;
  const pushName = input.pushName ?? (user ? strOrNull(user, 'push_name') : null) ?? (existing ? strOrNull(existing, 'push_name') : null);
  let spent = existing ? num(existing, 'total_spent_cents') : 0;
  let purchases = existing ? num(existing, 'purchase_count') : 0;
  let lastPlanId = input.planId ?? (existing ? strOrNull(existing, 'last_plan_id') : null);
  let lastPlanName = input.planName ?? (existing ? strOrNull(existing, 'last_plan_name') : null);
  const paidAlready = input.kind === 'paid' && input.detail ? await hasEvent(client, input.jid, 'paid', input.detail) : false;
  if (input.kind === 'paid' && !paidAlready) {
    purchases += 1;
    spent += input.amountCents ?? 0;
    if (input.planId) lastPlanId = input.planId;
    if (input.planName) lastPlanName = input.planName;
  }
  await client.execute({
    sql: `INSERT INTO leads (
      jid, phone, push_name, first_seen, last_seen, current_stage, last_plan_id, last_plan_name,
      total_spent_cents, purchase_count, stickers_made, credits_left, expires_at, source, notes, tags, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', '', ?)
    ON CONFLICT(jid) DO UPDATE SET
      phone = excluded.phone,
      push_name = COALESCE(excluded.push_name, leads.push_name),
      last_seen = excluded.last_seen,
      current_stage = excluded.current_stage,
      last_plan_id = excluded.last_plan_id,
      last_plan_name = excluded.last_plan_name,
      total_spent_cents = excluded.total_spent_cents,
      purchase_count = excluded.purchase_count,
      stickers_made = excluded.stickers_made,
      credits_left = excluded.credits_left,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at`,
    args: [
      input.jid,
      phone,
      pushName,
      existing ? num(existing, 'first_seen') : input.now,
      input.now,
      stage,
      lastPlanId,
      lastPlanName,
      spent,
      purchases,
      stickers,
      credits,
      expiresAt,
      input.now,
    ],
  });
  if (input.kind === 'sticker_made') {
    if (stickers > 0 && !(await hasEvent(client, input.jid, 'first_sticker', ''))) {
      await insertEvent(client, input.jid, 'first_sticker', input.now, null);
    }
    return;
  }
  if (UNIQUE_KINDS.has(input.kind) && (await hasEvent(client, input.jid, input.kind, input.detail ?? ''))) return;
  await insertEvent(client, input.jid, input.kind, input.now, input.detail ?? null);
}

export async function updateLeadNotes(client: Client, phone: string, notes: string, tags: string, now: number): Promise<boolean> {
  const result = await client.execute({
    sql: 'UPDATE leads SET notes = ?, tags = ?, updated_at = ? WHERE phone = ?',
    args: [notes.slice(0, 2000), tags.slice(0, 200), now, phone],
  });
  return result.rowsAffected > 0;
}

export async function getLeadByPhone(client: Client, phone: string): Promise<LeadRow | null> {
  const found = await one(client, 'SELECT * FROM leads WHERE phone = ?', [phone]);
  return found ? mapLead(found) : null;
}

export async function listLeadEvents(client: Client, jid: string): Promise<LeadEventRow[]> {
  const result = await client.execute({
    sql: 'SELECT * FROM lead_events WHERE jid = ? ORDER BY created_at ASC, rowid ASC',
    args: [jid],
  });
  return result.rows.map((item) => {
    const record = row(item);
    return {
      id: str(record, 'id'),
      jid: str(record, 'jid'),
      kind: str(record, 'kind'),
      createdAt: num(record, 'created_at'),
      detail: strOrNull(record, 'detail'),
    };
  });
}

export async function listPaymentsForJid(client: Client, jid: string): Promise<Array<Record<string, unknown>>> {
  const result = await client.execute({
    sql: 'SELECT * FROM payments WHERE jid = ? ORDER BY created_at DESC',
    args: [jid],
  });
  return result.rows.map((item) => row(item));
}

export async function queryLeads(client: Client, filter: LeadQuery): Promise<{ rows: LeadRow[]; total: number }> {
  const { where, args } = leadWhere(filter);
  const sort = SORT[filter.sort ?? 'last_seen'];
  const dir = filter.dir === 'asc' ? 'ASC' : 'DESC';
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));
  const page = Math.max(1, filter.page ?? 1);
  const totalResult = await client.execute({ sql: `SELECT COUNT(*) AS qty FROM leads ${where}`, args });
  const total = totalResult.rows.length ? num(row(totalResult.rows[0]), 'qty') : 0;
  const result = await client.execute({
    sql: `SELECT * FROM leads ${where} ORDER BY ${sort} ${dir}, phone ASC LIMIT ? OFFSET ?`,
    args: [...args, pageSize, (page - 1) * pageSize],
  });
  return { rows: result.rows.map((item) => mapLead(row(item))), total };
}

export async function exportLeads(client: Client, filter: LeadQuery): Promise<LeadRow[]> {
  const { where, args } = leadWhere(filter);
  const sort = SORT[filter.sort ?? 'last_seen'];
  const dir = filter.dir === 'asc' ? 'ASC' : 'DESC';
  const result = await client.execute({
    sql: `SELECT * FROM leads ${where} ORDER BY ${sort} ${dir}, phone ASC LIMIT 5000`,
    args,
  });
  return result.rows.map((item) => mapLead(row(item)));
}

export async function stageCounts(client: Client): Promise<Array<{ stage: string; count: number }>> {
  const result = await client.execute('SELECT current_stage AS stage, COUNT(*) AS qty FROM leads GROUP BY current_stage');
  return result.rows.map((item) => {
    const record = row(item);
    return { stage: str(record, 'stage'), count: num(record, 'qty') };
  });
}

export async function leadTotals(client: Client): Promise<{ leads: number; buyers: number }> {
  const result = await client.execute(
    'SELECT COUNT(*) AS leads, COALESCE(SUM(CASE WHEN purchase_count > 0 THEN 1 ELSE 0 END), 0) AS buyers FROM leads',
  );
  const record = result.rows.length ? row(result.rows[0]) : {};
  return { leads: num(record, 'leads') || 0, buyers: num(record, 'buyers') || 0 };
}

export async function backfillLeads(client: Client, now: number): Promise<void> {
  const users = await client.execute('SELECT * FROM users');
  for (const item of users.rows) {
    const user = row(item);
    const jid = str(user, 'jid');
    const exists = await one(client, 'SELECT jid FROM leads WHERE jid = ?', [jid]);
    if (exists) continue;
    const created = num(user, 'created_at');
    const phone = str(user, 'phone');
    const pushName = strOrNull(user, 'push_name');
    await applyLeadEvent(client, { jid, phone, pushName, now: created, kind: 'first_contact' });
    const payments = await client.execute({
      sql: 'SELECT * FROM payments WHERE jid = ? ORDER BY created_at ASC',
      args: [jid],
    });
    for (const paymentItem of payments.rows) {
      const payment = row(paymentItem);
      const when = num(payment, 'created_at');
      await applyLeadEvent(client, {
        jid,
        phone,
        now: when,
        kind: 'chose_plan',
        detail: str(payment, 'id'),
        planId: str(payment, 'plan_id'),
        planName: str(payment, 'plan_name'),
      });
      if (payment.applied_at != null) {
        await applyLeadEvent(client, {
          jid,
          phone,
          now: num(payment, 'applied_at'),
          kind: 'paid',
          detail: str(payment, 'id'),
          planId: str(payment, 'plan_id'),
          planName: str(payment, 'plan_name'),
          amountCents: num(payment, 'amount_cents'),
        });
      } else if (['cancelled', 'expired', 'rejected'].includes(str(payment, 'status'))) {
        await applyLeadEvent(client, { jid, phone, now: num(payment, 'updated_at'), kind: 'pix_expired', detail: str(payment, 'id') });
      } else if (payment.mp_id != null) {
        await applyLeadEvent(client, { jid, phone, now: when, kind: 'pix_generated', detail: str(payment, 'id') });
      }
    }
    if (num(user, 'stickers_used') > 0) {
      await applyLeadEvent(client, { jid, phone, now: num(user, 'updated_at'), kind: 'sticker_made' });
    }
    const balance = num(user, 'balance');
    const planExpires = numOrNull(user, 'plan_expires_at');
    if (planExpires != null && planExpires <= now && balance === 0) {
      await applyLeadEvent(client, { jid, phone, now: planExpires, kind: 'plan_expired', detail: String(planExpires) });
    } else if (balance === 0 && num(user, 'stickers_used') > 0) {
      await applyLeadEvent(client, { jid, phone, now: num(user, 'updated_at'), kind: 'credits_ran_out' });
    }
    await applyLeadEvent(client, { jid, phone, pushName, now: num(user, 'updated_at') || now, kind: 'first_contact' });
  }
}

function leadWhere(filter: LeadQuery): { where: string; args: InValue[] } {
  const clauses: string[] = [];
  const args: InValue[] = [];
  const q = filter.q?.trim();
  if (q) {
    const name = `%${q.toLowerCase().replace(/[%_]/g, '')}%`;
    const digits = q.replace(/\D/g, '');
    if (digits) {
      clauses.push('(LOWER(COALESCE(push_name, \'\')) LIKE ? OR phone LIKE ?)');
      args.push(name, `%${digits}%`);
    } else {
      clauses.push('LOWER(COALESCE(push_name, \'\')) LIKE ?');
      args.push(name);
    }
  }
  if (filter.stage && isLeadStage(filter.stage)) {
    clauses.push('current_stage = ?');
    args.push(filter.stage);
  }
  if (filter.bought === 'yes') clauses.push('purchase_count > 0');
  if (filter.bought === 'no') clauses.push('purchase_count = 0');
  if (filter.planId) {
    clauses.push('last_plan_id = ?');
    args.push(filter.planId);
  }
  if (filter.fromMs != null) {
    clauses.push('last_seen >= ?');
    args.push(filter.fromMs);
  }
  if (filter.toMs != null) {
    clauses.push('last_seen < ?');
    args.push(filter.toMs);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

async function hasEvent(client: Client, jid: string, kind: string, detail: string): Promise<boolean> {
  const found = await one(client, 'SELECT id FROM lead_events WHERE jid = ? AND kind = ? AND COALESCE(detail, \'\') = ? LIMIT 1', [
    jid,
    kind,
    detail,
  ]);
  return Boolean(found);
}

async function insertEvent(client: Client, jid: string, kind: string, createdAt: number, detail: string | null): Promise<void> {
  await client.execute({
    sql: 'INSERT INTO lead_events (id, jid, kind, created_at, detail) VALUES (?, ?, ?, ?, ?)',
    args: [randomUUID(), jid, kind, createdAt, detail],
  });
}

function mapLead(record: Record<string, unknown>): LeadRow {
  const stage = str(record, 'current_stage');
  return {
    jid: str(record, 'jid'),
    phone: str(record, 'phone'),
    pushName: strOrNull(record, 'push_name'),
    firstSeen: num(record, 'first_seen'),
    lastSeen: num(record, 'last_seen'),
    stage: isLeadStage(stage) ? stage : 'chamou',
    lastPlanId: strOrNull(record, 'last_plan_id'),
    lastPlanName: strOrNull(record, 'last_plan_name'),
    totalSpentCents: num(record, 'total_spent_cents'),
    purchaseCount: num(record, 'purchase_count'),
    stickersMade: num(record, 'stickers_made'),
    creditsLeft: num(record, 'credits_left'),
    expiresAt: numOrNull(record, 'expires_at'),
    source: strOrNull(record, 'source'),
    notes: str(record, 'notes'),
    tags: str(record, 'tags'),
  };
}

async function one(client: Client, sql: string, args: InValue[] = []): Promise<Record<string, unknown> | null> {
  const result = await client.execute({ sql, args });
  if (!result.rows.length) return null;
  return row(result.rows[0]);
}

function row(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value === 'bigint') return Number(value);
  return Number(value ?? 0);
}

function numOrNull(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value == null) return null;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function str(record: Record<string, unknown>, key: string): string {
  return String(record[key] ?? '');
}

function strOrNull(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return value == null ? null : String(value);
}
