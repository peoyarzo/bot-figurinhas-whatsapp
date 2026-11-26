import type { AppContext } from '../context.js';
import { crmEvent } from '../crm/record.js';
import { refreshPendingPayments } from '../payments/flow.js';
import type { InboundMessage } from '../types.js';
import { dispatchCommand, parseCommand } from './commands.js';
import { handleFormatReply, handleMedia } from './media.js';
import { documentText, idleText } from './texts.js';

export async function handleInbound(ctx: AppContext, msg: InboundMessage): Promise<void> {
  if (msg.fromGroup && ctx.config.safety.ignoreGroups) {
    ctx.log.info('mensagem de grupo ignorada', { jid: msg.jid });
    return;
  }
  const isAdmin = ctx.env.ADMIN_NUMBERS.includes(msg.phone);
  const before = await ctx.db.getUser(msg.jid);
  await ctx.db.touchInbound({
    jid: msg.jid,
    phone: msg.phone,
    pushName: msg.pushName ?? null,
    now: ctx.now(),
  });
  await ctx.db.expireCredits(msg.jid, ctx.now());
  const after = await ctx.db.getUser(msg.jid);
  await crmEvent(ctx, msg.jid, 'first_contact', { phone: msg.phone, pushName: msg.pushName ?? null });
  if (before && after && before.balance > 0 && after.balance === 0 && !(after.planExpiresAt != null && after.planExpiresAt > ctx.now())) {
    await crmEvent(ctx, msg.jid, 'credits_ran_out');
  }
  if (after?.planExpiresAt != null && after.planExpiresAt <= ctx.now() && after.balance === 0) {
    await crmEvent(ctx, msg.jid, 'plan_expired', { detail: String(after.planExpiresAt) });
  }
  if (!isAdmin && (await ctx.db.isPaused())) {
    ctx.log.info('bot pausado, mensagem ignorada', { phone: msg.phone });
    return;
  }
  const command = parseCommand(msg.text);
  await refreshPendingPayments(ctx, msg.jid, command?.name === 'status' || command?.name === 'saldo');
  if (command) {
    await dispatchCommand(ctx, msg, command, isAdmin);
    return;
  }
  if (msg.mediaError) {
    await ctx.messenger.sendText(msg.jid, 'Não consegui baixar o arquivo. Manda de novo.');
    return;
  }
  if (msg.document) {
    if (ctx.limiter.tryTake(`hint:${msg.jid}`, ctx.config.safety.hintPerMinute)) {
      await ctx.messenger.sendText(msg.jid, documentText());
    }
    return;
  }
  if (msg.media) {
    await handleMedia(ctx, msg, isAdmin);
    return;
  }
  if (msg.text.trim() && (await handleFormatReply(ctx, msg, isAdmin))) return;
  if (msg.text.trim() && ctx.limiter.tryTake(`hint:${msg.jid}`, ctx.config.safety.hintPerMinute)) {
    await ctx.messenger.sendText(msg.jid, idleText());
  }
}
