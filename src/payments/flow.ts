import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import { formatBrl } from '../money.js';
import { resolvePlanId } from '../plans.js';
import { formatDate } from '../time.js';
import { MockGateway, PaymentNotConfiguredError } from './gateway.js';
import { buyHelpText, paidText, pixIntro, pixText, placeholderBuyText } from '../bot/texts.js';

export async function startCheckout(ctx: AppContext, jid: string, token: string | undefined, isAdmin: boolean): Promise<void> {
  if (!token) {
    const plans = await ctx.db.listPlans();
    await ctx.messenger.sendText(jid, buyHelpText(plans));
    return;
  }
  const planId = resolvePlanId(token);
  const plan = planId ? await ctx.db.getPlan(planId) : null;
  if (!plan || !plan.active) {
    await ctx.messenger.sendText(jid, 'Não achei esse plano. /planos mostra os que existem.');
    return;
  }
  if (plan.priceIsPlaceholder) {
    await ctx.messenger.sendText(jid, placeholderBuyText(plan));
    return;
  }
  if (plan.priceCents <= 0) {
    await ctx.messenger.sendText(jid, 'Esse plano está sem preço. O admin precisa definir um valor.');
    return;
  }
  const id = randomUUID();
  const now = ctx.now();
  await ctx.db.insertPayment({ id, jid, plan, now });
  try {
    const created = await ctx.gateway.createPix({
      amountCents: plan.priceCents,
      description: plan.name,
      externalReference: id,
      payerEmail: ctx.env.MP_PAYER_EMAIL,
      payerFirstName: ctx.env.MP_PAYER_FIRST_NAME,
      notificationUrl: ctx.env.PUBLIC_BASE_URL ? `${ctx.env.PUBLIC_BASE_URL}/webhooks/mercadopago` : undefined,
    });
    await ctx.db.attachPayment({ id, mpId: created.id, qrCode: created.qrCode, status: created.status, now });
    if (created.status === 'approved') {
      const result = await ctx.db.applyApproved(id, created.id, now);
      if (result.outcome === 'applied') await notifyApplied(ctx, result.jid, result);
      return;
    }
    await ctx.messenger.sendText(
      jid,
      pixText({
        intro: pixIntro(ctx.gateway.mode, ctx.env.MP_ACCESS_TOKEN),
        planName: plan.name,
        amount: formatBrl(plan.priceCents),
        qr: created.qrCode,
      }),
    );
  } catch (error) {
    await ctx.db.markStatus(id, 'failed', ctx.now());
    ctx.log.error('falha ao criar pix', error);
    const detail = isAdmin && error instanceof Error ? `\nDetalhe: ${error.message}` : '';
    const text = error instanceof PaymentNotConfiguredError ? 'O Pix ainda não está configurado.' : 'Não consegui gerar o Pix agora. Tenta de novo em instantes.';
    await ctx.messenger.sendText(jid, `${text}${detail}`);
  }
}

export async function processPaymentNotification(ctx: AppContext, mpId: string): Promise<void> {
  const remote = await ctx.gateway.getPayment(mpId);
  if (!remote) {
    ctx.log.warn('pagamento não encontrado no provedor', { mpId });
    return;
  }
  const local = await ctx.db.findPayment(mpId, remote.externalReference);
  if (!local) {
    ctx.log.warn('pagamento sem pedido local', { mpId });
    return;
  }
  if (remote.status !== 'approved') {
    await ctx.db.markStatus(local.id, remote.status, ctx.now());
    return;
  }
  const result = await ctx.db.applyApproved(local.id, mpId, ctx.now());
  if (result.outcome === 'applied') await notifyApplied(ctx, result.jid, result);
}

export async function refreshPendingPayments(ctx: AppContext, jid: string, force: boolean): Promise<void> {
  const now = ctx.now();
  const previous = ctx.refreshAt.get(jid) ?? 0;
  if (!force && now - previous < ctx.config.payments.refreshMinIntervalMs) return;
  ctx.refreshAt.set(jid, now);
  const open = await ctx.db.listOpenPayments(jid);
  for (const payment of open) {
    if (!payment.mpId) continue;
    try {
      const remote = await ctx.gateway.getPayment(payment.mpId);
      if (!remote) continue;
      if (remote.status === 'approved') {
        const result = await ctx.db.applyApproved(payment.id, payment.mpId, ctx.now());
        if (result.outcome === 'applied') await notifyApplied(ctx, result.jid, result);
      } else if (remote.status !== payment.status) {
        await ctx.db.markStatus(payment.id, remote.status, ctx.now());
      }
    } catch (error) {
      ctx.log.warn('falha ao consultar pagamento pendente', error);
    }
  }
}

async function notifyApplied(
  ctx: AppContext,
  jid: string,
  result: {
    planName: string;
    kind: 'credits' | 'unlimited';
    creditsExpiresAt: number | null;
    user: { hasInbound: boolean; balance: number; planExpiresAt: number | null };
  },
): Promise<void> {
  if (!result.user.hasInbound) return;
  const expiresMs = result.kind === 'credits' ? result.creditsExpiresAt : result.user.planExpiresAt;
  const expiresLabel = expiresMs ? formatDate(expiresMs, ctx.config.timeZone) : null;
  try {
    await ctx.messenger.sendText(jid, paidText({ planName: result.planName, kind: result.kind, balance: result.user.balance, expiresLabel }));
  } catch (error) {
    ctx.log.error('não avisei o comprador', error);
  }
}

export function isMockGateway(gateway: AppContext['gateway']): gateway is MockGateway {
  return gateway instanceof MockGateway;
}
