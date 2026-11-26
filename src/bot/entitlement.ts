import type { UserRow } from '../types.js';

export type Entitlement =
  | { ok: true; source: 'admin' | 'vip' | 'unlimited' | 'credits' }
  | { ok: false; reason: 'none' };

export function resolveEntitlement(user: UserRow, input: { isAdmin: boolean; now: number }): Entitlement {
  if (input.isAdmin) return { ok: true, source: 'admin' };
  if (user.isVip) return { ok: true, source: 'vip' };
  if (user.planExpiresAt != null && user.planExpiresAt > input.now) return { ok: true, source: 'unlimited' };
  if (user.balance > 0) return { ok: true, source: 'credits' };
  return { ok: false, reason: 'none' };
}
