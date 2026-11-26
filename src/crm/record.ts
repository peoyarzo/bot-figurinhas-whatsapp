import type { AppContext } from '../context.js';
import type { Logger } from '../logger.js';
import { applyLeadEvent } from './repository.js';
import type { LeadEventKind } from './stage.js';

export async function safeCrm(log: Logger, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    log.warn('crm ignorado', error);
  }
}

export async function crmEvent(
  ctx: AppContext,
  jid: string,
  kind: LeadEventKind,
  extra?: { phone?: string; pushName?: string | null; detail?: string | null; planId?: string | null; planName?: string | null; amountCents?: number | null },
): Promise<void> {
  await safeCrm(ctx.log, () =>
    applyLeadEvent(ctx.db.client, {
      jid,
      phone: extra?.phone,
      pushName: extra?.pushName,
      now: ctx.now(),
      kind,
      detail: extra?.detail,
      planId: extra?.planId,
      planName: extra?.planName,
      amountCents: extra?.amountCents,
    }),
  );
}
