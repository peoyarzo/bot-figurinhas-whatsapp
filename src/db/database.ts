import { randomUUID } from 'node:crypto';
import type { Client, InArgs, ResultSet, Transaction } from '@libsql/client';
import type { PlanDraft } from '../config.js';
import { phoneFromJid, toJid } from '../phone.js';
import type { ApplyOutcome, CreditLot, PaymentRow, Plan, SalesBucket, UserRow } from '../types.js';
import { migrate } from './schema.js';

type Runner = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;

function rowOf(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

function num(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

function numOrNull(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value == null) return null;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function str(row: Record<string, unknown>, key: string): string {
  return String(row[key]);
}

function strOrNull(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return value == null ? null : String(value);
}

function flag(row: Record<string, unknown>, key: string): boolean {
  return Number(row[key]) === 1;
}

function creditExpiresAt(days: number | null, now: number): number | null {
  if (days == null || days <= 0) return null;
  return now + days * 86_400_000;
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|constraint/i.test(message);
}

function mapUser(row: Record<string, unknown>): UserRow {
  return {
    jid: str(row, 'jid'),
    phone: str(row, 'phone'),
    pushName: strOrNull(row, 'push_name'),
    balance: num(row, 'balance'),
    trialRemaining: num(row, 'trial_remaining'),
    stickersUsed: num(row, 'stickers_used'),
    planId: strOrNull(row, 'plan_id'),
    planExpiresAt: numOrNull(row, 'plan_expires_at'),
    isVip: flag(row, 'is_vip'),
    hasInbound: flag(row, 'has_inbound'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
  };
}

function mapPlan(row: Record<string, unknown>): Plan {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    priceCents: num(row, 'price_cents'),
    kind: str(row, 'kind') === 'unlimited' ? 'unlimited' : 'credits',
    credits: numOrNull(row, 'credits'),
    durationDays: numOrNull(row, 'duration_days'),
    creditsExpireDays: numOrNull(row, 'credits_expire_days'),
    priceIsPlaceholder: flag(row, 'price_is_placeholder'),
    active: flag(row, 'active'),
    sortOrder: num(row, 'sort_order'),
    edited: flag(row, 'edited'),
  };
}

function mapPayment(row: Record<string, unknown>): PaymentRow {
  return {
    id: str(row, 'id'),
    mpId: strOrNull(row, 'mp_id'),
    jid: str(row, 'jid'),
    planId: str(row, 'plan_id'),
    planName: str(row, 'plan_name'),
    amountCents: num(row, 'amount_cents'),
    kind: str(row, 'kind') === 'unlimited' ? 'unlimited' : 'credits',
    creditsSnapshot: numOrNull(row, 'credits_snapshot'),
    durationDaysSnapshot: numOrNull(row, 'duration_days_snapshot'),
    creditsExpireDaysSnapshot: numOrNull(row, 'credits_expire_days_snapshot'),
    status: str(row, 'status'),
    qrCode: strOrNull(row, 'qr_code'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
    appliedAt: numOrNull(row, 'applied_at'),
  };
}

async function run(runner: Runner, sql: string, args: InArgs = []): Promise<ResultSet> {
  return runner.execute({ sql, args });
}

export class Database {
  constructor(readonly client: Client) {}

  async migrate(): Promise<void> {
    await migrate(this.client);
  }

  async ping(): Promise<void> {
    await this.client.execute('SELECT 1');
  }

  async seedPlans(defaults: PlanDraft[]): Promise<void> {
    for (const plan of defaults) {
      const current = await this.getPlan(plan.id);
      if (!current) {
        await this.writePlan(plan, false);
        continue;
      }
      if (!current.edited) await this.writePlan(plan, false);
    }
  }

  async listPlans(): Promise<Plan[]> {
    const result = await this.client.execute('SELECT * FROM plans ORDER BY sort_order ASC, id ASC');
    return result.rows.map((row) => mapPlan(rowOf(row)));
  }

  async getPlan(id: string): Promise<Plan | null> {
    const result = await run(this.client, 'SELECT * FROM plans WHERE id = ?', [id]);
    if (!result.rows.length) return null;
    return mapPlan(rowOf(result.rows[0]));
  }

  async updatePlan(id: string, patch: Partial<PlanDraft>): Promise<Plan | null> {
    const current = await this.getPlan(id);
    if (!current) return null;
    const next: Plan = { ...current, ...patch, id, edited: true };
    await this.writePlan(next, true);
    return next;
  }

  async resetPlan(plan: PlanDraft): Promise<void> {
    await this.writePlan(plan, false);
  }

  private async writePlan(plan: PlanDraft, edited: boolean): Promise<void> {
    await run(
      this.client,
      `INSERT INTO plans (
        id, name, price_cents, kind, credits, duration_days, credits_expire_days, price_is_placeholder, active, sort_order, edited
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        price_cents = excluded.price_cents,
        kind = excluded.kind,
        credits = excluded.credits,
        duration_days = excluded.duration_days,
        credits_expire_days = excluded.credits_expire_days,
        price_is_placeholder = excluded.price_is_placeholder,
        active = excluded.active,
        sort_order = excluded.sort_order,
        edited = excluded.edited`,
      [
        plan.id,
        plan.name,
        plan.priceCents,
        plan.kind,
        plan.credits,
        plan.durationDays,
        plan.creditsExpireDays,
        plan.priceIsPlaceholder ? 1 : 0,
        plan.active ? 1 : 0,
        plan.sortOrder,
        edited ? 1 : 0,
      ],
    );
  }

  async getUser(jid: string): Promise<UserRow | null> {
    const result = await run(this.client, 'SELECT * FROM users WHERE jid = ?', [jid]);
    if (!result.rows.length) return null;
    return mapUser(rowOf(result.rows[0]));
  }

  async isVipPhone(phone: string): Promise<boolean> {
    const result = await run(this.client, 'SELECT phone FROM vip_phones WHERE phone = ?', [phone]);
    return result.rows.length > 0;
  }

  async listVip(): Promise<string[]> {
    const result = await this.client.execute('SELECT phone FROM vip_phones ORDER BY phone ASC');
    return result.rows.map((row) => str(rowOf(row), 'phone'));
  }

  async setVip(phone: string, enabled: boolean, now: number): Promise<void> {
    const jid = toJid(phone);
    if (enabled) {
      await run(this.client, 'INSERT INTO vip_phones (phone, created_at) VALUES (?, ?) ON CONFLICT(phone) DO NOTHING', [phone, now]);
      await run(this.client, 'UPDATE users SET is_vip = 1, updated_at = ? WHERE phone = ? OR jid = ?', [now, phone, jid]);
      return;
    }
    await run(this.client, 'DELETE FROM vip_phones WHERE phone = ?', [phone]);
    await run(this.client, 'UPDATE users SET is_vip = 0, updated_at = ? WHERE phone = ? OR jid = ?', [now, phone, jid]);
  }

  async touchInbound(input: { jid: string; phone: string; pushName: string | null; now: number }): Promise<void> {
    const vip = await this.isVipPhone(input.phone);
    const existing = await this.getUser(input.jid);
    if (!existing) {
      try {
        await run(
          this.client,
          `INSERT INTO users (
            jid, phone, push_name, balance, trial_remaining, stickers_used, plan_id, plan_expires_at, is_vip, has_inbound, created_at, updated_at
          ) VALUES (?, ?, ?, 0, 0, 0, NULL, NULL, ?, 1, ?, ?)`,
          [input.jid, input.phone, input.pushName, vip ? 1 : 0, input.now, input.now],
        );
        return;
      } catch (error) {
        if (!isConstraintError(error)) throw error;
      }
    }
    await run(
      this.client,
      `UPDATE users
       SET phone = ?, push_name = COALESCE(?, push_name), has_inbound = 1,
           is_vip = CASE WHEN ? = 1 THEN 1 ELSE is_vip END, updated_at = ?
       WHERE jid = ?`,
      [input.phone, input.pushName, vip ? 1 : 0, input.now, input.jid],
    );
  }

  async expireCredits(jid: string, now: number): Promise<void> {
    const tx = await this.client.transaction('write');
    try {
      await this.expireLots(tx, jid, now);
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    } finally {
      tx.close();
    }
  }

  async listCreditLots(jid: string, now: number): Promise<CreditLot[]> {
    const result = await run(
      this.client,
      `SELECT remaining, expires_at, created_at FROM credit_lots
       WHERE jid = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at ASC, created_at ASC`,
      [jid, now],
    );
    return result.rows.map((row) => {
      const record = rowOf(row);
      return {
        remaining: num(record, 'remaining'),
        expiresAt: numOrNull(record, 'expires_at'),
        createdAt: num(record, 'created_at'),
      };
    });
  }

  async tryConsumeCredit(jid: string, now: number): Promise<{ ok: true; lotId: string | null } | { ok: false }> {
    const tx = await this.client.transaction('write');
    try {
      await this.expireLots(tx, jid, now);
      const found = await run(
        tx,
        `SELECT id FROM credit_lots
         WHERE jid = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at ASC, created_at ASC
         LIMIT 1`,
        [jid, now],
      );
      if (found.rows.length) {
        const lotId = str(rowOf(found.rows[0]), 'id');
        const lotUpdate = await run(tx, 'UPDATE credit_lots SET remaining = remaining - 1 WHERE id = ? AND remaining > 0', [lotId]);
        if (lotUpdate.rowsAffected !== 1) {
          await tx.rollback();
          return { ok: false };
        }
        const balanceUpdate = await run(tx, 'UPDATE users SET balance = balance - 1, updated_at = ? WHERE jid = ? AND balance > 0', [now, jid]);
        if (balanceUpdate.rowsAffected !== 1) {
          await tx.rollback();
          return { ok: false };
        }
        await tx.commit();
        return { ok: true, lotId };
      }
      const legacy = await run(tx, 'UPDATE users SET balance = balance - 1, updated_at = ? WHERE jid = ? AND balance > 0', [now, jid]);
      if (legacy.rowsAffected !== 1) {
        await tx.rollback();
        return { ok: false };
      }
      await tx.commit();
      return { ok: true, lotId: null };
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    } finally {
      tx.close();
    }
  }

  async refundCredit(jid: string, lotId: string | null, now: number): Promise<void> {
    const tx = await this.client.transaction('write');
    try {
      if (lotId) {
        const updated = await run(tx, 'UPDATE credit_lots SET remaining = remaining + 1 WHERE id = ?', [lotId]);
        if (updated.rowsAffected !== 1) throw new Error('lote de crédito sumiu no estorno');
      }
      await run(tx, 'UPDATE users SET balance = balance + 1, updated_at = ? WHERE jid = ?', [now, jid]);
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    } finally {
      tx.close();
    }
  }

  async incrementUsed(jid: string, now: number): Promise<void> {
    await run(this.client, 'UPDATE users SET stickers_used = stickers_used + 1, updated_at = ? WHERE jid = ?', [now, jid]);
  }

  async tryIncrementDaily(day: string, max: number): Promise<boolean> {
    const tx = await this.client.transaction('write');
    try {
      const current = await run(tx, 'SELECT count FROM daily_counts WHERE day = ?', [day]);
      const count = current.rows.length ? num(rowOf(current.rows[0]), 'count') : 0;
      if (count >= max) {
        await tx.rollback();
        return false;
      }
      if (!current.rows.length) {
        await run(tx, 'INSERT INTO daily_counts (day, count) VALUES (?, 1)', [day]);
      } else {
        await run(tx, 'UPDATE daily_counts SET count = ? WHERE day = ?', [count + 1, day]);
      }
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    } finally {
      tx.close();
    }
  }

  async decrementDaily(day: string): Promise<void> {
    await run(this.client, 'UPDATE daily_counts SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE day = ?', [day]);
  }

  async getDailyCount(day: string): Promise<number> {
    const result = await run(this.client, 'SELECT count FROM daily_counts WHERE day = ?', [day]);
    if (!result.rows.length) return 0;
    return num(rowOf(result.rows[0]), 'count');
  }

  async getSetting(key: string): Promise<string | null> {
    const result = await run(this.client, 'SELECT value FROM settings WHERE key = ?', [key]);
    if (!result.rows.length) return null;
    return str(rowOf(result.rows[0]), 'value');
  }

  async setSetting(key: string, value: string): Promise<void> {
    await run(this.client, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  async ensureBirthday(now: number): Promise<number> {
    const existing = await this.getSetting('bot_birthday_ms');
    if (existing) return Number(existing);
    await this.setSetting('bot_birthday_ms', String(now));
    return now;
  }

  async isPaused(): Promise<boolean> {
    return (await this.getSetting('paused')) === '1';
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.setSetting('paused', paused ? '1' : '0');
  }

  async insertPayment(input: {
    id: string;
    jid: string;
    plan: Plan;
    now: number;
  }): Promise<void> {
    await run(
      this.client,
      `INSERT INTO payments (
        id, mp_id, jid, plan_id, plan_name, amount_cents, kind, credits_snapshot, duration_days_snapshot, credits_expire_days_snapshot, status, qr_code, created_at, updated_at, applied_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', NULL, ?, ?, NULL)`,
      [
        input.id,
        input.jid,
        input.plan.id,
        input.plan.name,
        input.plan.priceCents,
        input.plan.kind,
        input.plan.credits,
        input.plan.durationDays,
        input.plan.creditsExpireDays,
        input.now,
        input.now,
      ],
    );
  }

  async attachPayment(input: { id: string; mpId: string; qrCode: string; status: string; now: number }): Promise<void> {
    await run(this.client, 'UPDATE payments SET mp_id = ?, qr_code = ?, status = ?, updated_at = ? WHERE id = ?', [
      input.mpId,
      input.qrCode,
      input.status,
      input.now,
      input.id,
    ]);
  }

  async markStatus(id: string, status: string, now: number): Promise<void> {
    await run(this.client, 'UPDATE payments SET status = ?, updated_at = ? WHERE id = ? AND applied_at IS NULL', [status, now, id]);
  }

  async getPaymentById(id: string): Promise<PaymentRow | null> {
    const result = await run(this.client, 'SELECT * FROM payments WHERE id = ?', [id]);
    if (!result.rows.length) return null;
    return mapPayment(rowOf(result.rows[0]));
  }

  async findPayment(mpId: string, externalReference?: string): Promise<PaymentRow | null> {
    const byMp = await run(this.client, 'SELECT * FROM payments WHERE mp_id = ?', [mpId]);
    if (byMp.rows.length) return mapPayment(rowOf(byMp.rows[0]));
    if (!externalReference) return null;
    return this.getPaymentById(externalReference);
  }

  async listOpenPayments(jid: string): Promise<PaymentRow[]> {
    const result = await run(
      this.client,
      `SELECT * FROM payments
       WHERE jid = ? AND applied_at IS NULL AND status IN ('creating', 'pending', 'in_process', 'approved')
       ORDER BY created_at ASC`,
      [jid],
    );
    return result.rows.map((row) => mapPayment(rowOf(row)));
  }

  async applyApproved(internalId: string, mpId: string, now: number): Promise<ApplyOutcome> {
    const tx = await this.client.transaction('write');
    let jid = '';
    let creditsExpiresAt: number | null = null;
    try {
      const found = await run(tx, 'SELECT * FROM payments WHERE id = ?', [internalId]);
      if (!found.rows.length) {
        await tx.rollback();
        return { outcome: 'missing' };
      }
      const payment = mapPayment(rowOf(found.rows[0]));
      jid = payment.jid;
      if (payment.appliedAt) {
        await tx.rollback();
        return { outcome: 'duplicate', jid };
      }
      try {
        await run(tx, 'INSERT INTO payment_grants (mp_id, payment_id, granted_at) VALUES (?, ?, ?)', [mpId, payment.id, now]);
      } catch (error) {
        await tx.rollback();
        if (isConstraintError(error)) return { outcome: 'duplicate', jid };
        throw error;
      }
      const updated = await run(
        tx,
        `UPDATE payments
         SET status = 'approved', mp_id = COALESCE(mp_id, ?), applied_at = ?, updated_at = ?
         WHERE id = ? AND applied_at IS NULL`,
        [mpId, now, now, payment.id],
      );
      if (updated.rowsAffected !== 1) {
        await tx.rollback();
        return { outcome: 'duplicate', jid };
      }
      await this.ensurePlaceholder(tx, payment.jid, phoneFromJid(payment.jid), now);
      if (payment.kind === 'credits') {
        creditsExpiresAt = creditExpiresAt(payment.creditsExpireDaysSnapshot, now);
        await this.addCreditLot(tx, payment.jid, payment.creditsSnapshot ?? 0, creditsExpiresAt, now);
      } else {
        const days = payment.durationDaysSnapshot ?? 0;
        if (days <= 0) throw new Error(`plano ${payment.planId} sem duração`);
        await this.extendUnlimited(tx, payment.jid, payment.planId, days, now);
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    } finally {
      tx.close();
    }
    const user = await this.getUser(jid);
    if (!user) throw new Error('usuário sumiu depois do pagamento');
    const payment = await this.getPaymentById(internalId);
    return {
      outcome: 'applied',
      jid,
      planName: payment?.planName ?? 'plano',
      kind: payment?.kind ?? 'credits',
      user,
      creditsExpiresAt,
    };
  }

  async grantPlan(phone: string, plan: Plan, now: number): Promise<UserRow> {
    const jid = toJid(phone);
    const tx = await this.client.transaction('write');
    try {
      await this.ensurePlaceholder(tx, jid, phone, now);
      if (plan.kind === 'credits') {
        await this.addCreditLot(tx, jid, plan.credits ?? 0, creditExpiresAt(plan.creditsExpireDays, now), now);
      } else {
        const days = plan.durationDays ?? 0;
        if (days <= 0) throw new Error(`plano ${plan.id} sem duração`);
        await this.extendUnlimited(tx, jid, plan.id, days, now);
      }
      await run(tx, 'INSERT INTO admin_grants (id, phone, plan_id, created_at) VALUES (?, ?, ?, ?)', [randomUUID(), phone, plan.id, now]);
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    } finally {
      tx.close();
    }
    const user = await this.getUser(jid);
    if (!user) throw new Error('usuário sumiu depois da liberação');
    return user;
  }

  async salesSince(sinceMs: number): Promise<SalesBucket> {
    const totals = await run(
      this.client,
      `SELECT COUNT(*) AS qty, COALESCE(SUM(amount_cents), 0) AS total
       FROM payments WHERE applied_at IS NOT NULL AND applied_at >= ?`,
      [sinceMs],
    );
    const grouped = await run(
      this.client,
      `SELECT plan_id, plan_name, COUNT(*) AS qty, COALESCE(SUM(amount_cents), 0) AS total
       FROM payments WHERE applied_at IS NOT NULL AND applied_at >= ?
       GROUP BY plan_id, plan_name
       ORDER BY total DESC`,
      [sinceMs],
    );
    const head = totals.rows.length ? rowOf(totals.rows[0]) : {};
    return {
      count: num(head, 'qty') || 0,
      amountCents: num(head, 'total') || 0,
      byPlan: grouped.rows.map((row) => {
        const record = rowOf(row);
        return {
          planId: str(record, 'plan_id'),
          planName: str(record, 'plan_name'),
          count: num(record, 'qty'),
          amountCents: num(record, 'total'),
        };
      }),
    };
  }

  private async ensurePlaceholder(tx: Transaction, jid: string, phone: string, now: number): Promise<void> {
    const found = await run(tx, 'SELECT jid FROM users WHERE jid = ?', [jid]);
    if (found.rows.length) return;
    const vip = await run(tx, 'SELECT phone FROM vip_phones WHERE phone = ?', [phone]);
    await run(
      tx,
      `INSERT INTO users (
        jid, phone, push_name, balance, trial_remaining, stickers_used, plan_id, plan_expires_at, is_vip, has_inbound, created_at, updated_at
      ) VALUES (?, ?, NULL, 0, 0, 0, NULL, NULL, ?, 0, ?, ?)`,
      [jid, phone, vip.rows.length ? 1 : 0, now, now],
    );
  }

  private async expireLots(tx: Transaction, jid: string, now: number): Promise<void> {
    const expired = await run(
      tx,
      `SELECT COALESCE(SUM(remaining), 0) AS qty
       FROM credit_lots
       WHERE jid = ? AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= ?`,
      [jid, now],
    );
    const qty = expired.rows.length ? num(rowOf(expired.rows[0]), 'qty') : 0;
    if (qty <= 0) return;
    await run(
      tx,
      'UPDATE credit_lots SET remaining = 0 WHERE jid = ? AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= ?',
      [jid, now],
    );
    await run(
      tx,
      'UPDATE users SET balance = CASE WHEN balance >= ? THEN balance - ? ELSE 0 END, updated_at = ? WHERE jid = ?',
      [qty, qty, now, jid],
    );
  }

  private async addCreditLot(tx: Transaction, jid: string, credits: number, expiresAt: number | null, now: number): Promise<void> {
    if (credits <= 0) return;
    await run(
      tx,
      `INSERT INTO credit_lots (id, jid, remaining, granted, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), jid, credits, credits, expiresAt, now],
    );
    await run(tx, 'UPDATE users SET balance = balance + ?, updated_at = ? WHERE jid = ?', [credits, now, jid]);
  }

  private async extendUnlimited(tx: Transaction, jid: string, planId: string, days: number, now: number): Promise<void> {
    const existing = await run(tx, 'SELECT plan_expires_at FROM users WHERE jid = ?', [jid]);
    const current = existing.rows.length ? numOrNull(rowOf(existing.rows[0]), 'plan_expires_at') : null;
    const expires = Math.max(now, current ?? 0) + days * 86_400_000;
    await run(tx, 'UPDATE users SET plan_id = ?, plan_expires_at = ?, updated_at = ? WHERE jid = ?', [planId, expires, now, jid]);
  }
}
