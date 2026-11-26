import type { AppContext } from '../context.js';
import { parseBrl, formatBrl } from '../money.js';
import { normalizePhone } from '../phone.js';
import { resolvePlanId } from '../plans.js';
import { loadConfig } from '../config.js';
import { buildStatusModel, renderStatusCard } from '../stickers/status-card.js';
import { zonedStartOfDay, zonedStartOfMonth, zonedStartOfWeek } from '../time.js';
import type { InboundMessage, Plan } from '../types.js';
import { startCheckout } from '../payments/flow.js';
import {
  adminOnlyText,
  menuText,
  pausedText,
  plansText,
  resumedText,
  salesText,
  statusCaption,
  unknownCommandText,
} from './texts.js';

export type Command = { name: string; args: string[] };

export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

export async function dispatchCommand(ctx: AppContext, msg: InboundMessage, command: Command, isAdmin: boolean): Promise<void> {
  const name = command.name === 'saldo' ? 'status' : command.name === 'ajuda' ? 'menu' : command.name;
  if (name === 'menu') {
    await ctx.messenger.sendText(msg.jid, menuText(isAdmin));
    return;
  }
  if (name === 'planos') {
    if (command.args[0] === 'set' || command.args[0] === 'reset') {
      if (!isAdmin) {
        await ctx.messenger.sendText(msg.jid, adminOnlyText());
        return;
      }
      await editPlan(ctx, msg.jid, command.args);
      return;
    }
    const plans = await ctx.db.listPlans();
    await ctx.messenger.sendText(msg.jid, plansText(plans, isAdmin));
    return;
  }
  if (name === 'comprar') {
    await startCheckout(ctx, msg.jid, command.args[0], isAdmin);
    return;
  }
  if (name === 'status') {
    await sendStatus(ctx, msg, isAdmin);
    return;
  }
  if (!isAdmin) {
    if (['vendas', 'liberar', 'vip', 'unvip', 'pausar', 'retomar'].includes(name)) {
      await ctx.messenger.sendText(msg.jid, adminOnlyText());
      return;
    }
    await ctx.messenger.sendText(msg.jid, unknownCommandText());
    return;
  }
  if (name === 'pausar') {
    await ctx.db.setPaused(true);
    await ctx.messenger.sendText(msg.jid, pausedText());
    return;
  }
  if (name === 'retomar') {
    await ctx.db.setPaused(false);
    await ctx.messenger.sendText(msg.jid, resumedText());
    return;
  }
  if (name === 'vendas') {
    await sendSales(ctx, msg.jid);
    return;
  }
  if (name === 'liberar') {
    await liberate(ctx, msg.jid, command.args);
    return;
  }
  if (name === 'vip') {
    await toggleVip(ctx, msg.jid, command.args[0], true);
    return;
  }
  if (name === 'unvip') {
    await toggleVip(ctx, msg.jid, command.args[0], false);
    return;
  }
  await ctx.messenger.sendText(msg.jid, unknownCommandText());
}

async function sendStatus(ctx: AppContext, msg: InboundMessage, isAdmin: boolean): Promise<void> {
  await ctx.db.expireCredits(msg.jid, ctx.now());
  const user = await ctx.db.getUser(msg.jid);
  if (!user) return;
  const [plan, lots] = await Promise.all([
    user.planId ? ctx.db.getPlan(user.planId) : Promise.resolve(null),
    ctx.db.listCreditLots(msg.jid, ctx.now()),
  ]);
  const model = buildStatusModel({
    user,
    isAdmin,
    now: ctx.now(),
    planName: plan?.name ?? null,
    timeZone: ctx.config.timeZone,
    brand: ctx.config.sticker.packName,
    lots,
  });
  const caption = statusCaption(model);
  try {
    const png = await renderStatusCard(model);
    await ctx.messenger.sendImage(msg.jid, png, caption);
  } catch (error) {
    ctx.log.error('falha ao montar o cartão', error);
    await ctx.messenger.sendText(msg.jid, caption);
  }
}

async function sendSales(ctx: AppContext, jid: string): Promise<void> {
  const now = ctx.now();
  const zone = ctx.config.timeZone;
  const [day, week, month] = await Promise.all([
    ctx.db.salesSince(zonedStartOfDay(now, zone)),
    ctx.db.salesSince(zonedStartOfWeek(now, zone)),
    ctx.db.salesSince(zonedStartOfMonth(now, zone)),
  ]);
  await ctx.messenger.sendText(jid, salesText({ day, week, month }));
}

async function liberate(ctx: AppContext, adminJid: string, args: string[]): Promise<void> {
  const phone = args[0] ? normalizePhone(args[0]) : null;
  const planId = args[1] ? resolvePlanId(args[1]) : null;
  if (!phone || !planId) {
    await ctx.messenger.sendText(adminJid, 'Uso: /liberar <numero com DDI> <plano>. Exemplo: /liberar 5511900000001 15');
    return;
  }
  const plan = await ctx.db.getPlan(planId);
  if (!plan) {
    await ctx.messenger.sendText(adminJid, 'Plano desconhecido. /planos lista os ids.');
    return;
  }
  const user = await ctx.db.grantPlan(phone, plan, ctx.now());
  const desc = plan.kind === 'credits' ? `${plan.credits ?? 0} figurinhas (saldo ${user.balance})` : `${plan.name} até ${new Date(user.planExpiresAt ?? 0).toISOString()}`;
  if (user.hasInbound) {
    await ctx.messenger.sendText(user.jid, `Liberado: ${plan.name}. Manda uma imagem quando quiser.`);
    await ctx.messenger.sendText(adminJid, `Pronto. ${phone} recebeu ${desc}. Avisei no chat.`);
    return;
  }
  await ctx.messenger.sendText(adminJid, `Pronto. ${phone} recebeu ${desc}. Não chamei essa pessoa — ela ainda não falou com o bot.`);
}

async function toggleVip(ctx: AppContext, adminJid: string, raw: string | undefined, enabled: boolean): Promise<void> {
  if (!raw) {
    if (!enabled) {
      await ctx.messenger.sendText(adminJid, 'Uso: /unvip <numero com DDI>');
      return;
    }
    const phones = await ctx.db.listVip();
    await ctx.messenger.sendText(adminJid, phones.length ? `VIP (${phones.length})\n${phones.map((phone) => `• ${phone}`).join('\n')}` : 'Nenhum VIP.');
    return;
  }
  const phone = normalizePhone(raw);
  if (!phone) {
    await ctx.messenger.sendText(adminJid, 'Número inválido. Use só dígitos, com DDI.');
    return;
  }
  await ctx.db.setVip(phone, enabled, ctx.now());
  await ctx.messenger.sendText(adminJid, enabled ? `${phone} entrou na lista VIP (figurinhas sem descontar saldo).` : `${phone} saiu da lista VIP.`);
}

async function editPlan(ctx: AppContext, jid: string, args: string[]): Promise<void> {
  if (args[0] === 'reset') {
    const id = args[1] ? resolvePlanId(args[1]) ?? args[1] : '';
    const defaults = loadConfig().plans.find((plan) => plan.id === id);
    if (!defaults) {
      await ctx.messenger.sendText(jid, `Não achei o plano "${args[1] ?? ''}" no config.`);
      return;
    }
    await ctx.db.resetPlan(defaults);
    await ctx.messenger.sendText(jid, `Plano ${id} voltou para o valor do config.ts.`);
    return;
  }
  const id = args[1] ? resolvePlanId(args[1]) ?? args[1] : '';
  const fieldRaw = (args[2] ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const value = args.slice(3).join(' ').trim();
  if (!id || !fieldRaw || !value) {
    await ctx.messenger.sendText(jid, 'Uso: /planos set <id> preco 7,90');
    return;
  }
  const current = await ctx.db.getPlan(id);
  if (!current) {
    await ctx.messenger.sendText(jid, `Não achei o plano "${id}".`);
    return;
  }
  const patch = patchFrom(fieldRaw, value, current);
  if (!patch) {
    await ctx.messenger.sendText(jid, 'Campo inválido. Use preco, creditos, dias, nome, ativo ou placeholder.');
    return;
  }
  const updated = await ctx.db.updatePlan(id, patch);
  if (!updated) return;
  await ctx.messenger.sendText(jid, `Plano ${updated.id} atualizado: ${updated.name} — ${formatBrl(updated.priceCents)}${updated.priceIsPlaceholder ? ' (placeholder)' : ''}.`);
}

function patchFrom(field: string, value: string, current: Plan): Partial<Plan> | null {
  if (field === 'preco' || field === 'price') {
    const cents = parseBrl(value);
    if (cents == null) return null;
    return { priceCents: cents, priceIsPlaceholder: false };
  }
  if (field === 'creditos' || field === 'credits') {
    const credits = Number(value);
    if (!Number.isInteger(credits) || credits < 0) return null;
    return { credits, kind: 'credits' };
  }
  if (field === 'dias' || field === 'days') {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 0) return null;
    return { durationDays: days, kind: 'unlimited' };
  }
  if (field === 'nome' || field === 'name') {
    if (!value || value.length > 40) return null;
    return { name: value };
  }
  if (field === 'ativo' || field === 'active') {
    const flag = parseFlag(value);
    if (flag == null) return null;
    return { active: flag };
  }
  if (field === 'placeholder') {
    const flag = parseFlag(value);
    if (flag == null) return null;
    return { priceIsPlaceholder: flag, priceCents: current.priceCents };
  }
  return null;
}

function parseFlag(value: string): boolean | null {
  const cleaned = value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (['sim', 'on', '1', 'true'].includes(cleaned)) return true;
  if (['nao', 'off', '0', 'false'].includes(cleaned)) return false;
  return null;
}
