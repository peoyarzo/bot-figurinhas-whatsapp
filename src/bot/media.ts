import type { AppContext } from '../context.js';
import { zonedDayKey } from '../time.js';
import type { InboundMessage } from '../types.js';
import { fitForFormat, parseFormatChoice, PENDING_MEDIA_MS, type StickerFit } from './format.js';
import { extractStickerOpus, soundClipSeconds } from '../stickers/audio.js';
import { mediaToSticker, stickerOptionsFromConfig } from '../stickers/convert.js';
import type { Messenger } from '../whatsapp/messenger.js';
import { crmEvent } from '../crm/record.js';
import { dailyLimitFor } from '../safety/warmup.js';
import { resolveEntitlement } from './entitlement.js';
import {
  formatExpiredText,
  formatMissingText,
  formatQuestionText,
  globalLimitText,
  plansText,
  queueFullText,
  rateLimitText,
  tooBigText,
  warmupText,
} from './texts.js';

type MediaPayload = { kind: 'image' | 'video'; mimetype: string; buffer: Buffer };

export async function handleMedia(ctx: AppContext, msg: InboundMessage, isAdmin: boolean): Promise<void> {
  if (!msg.media) return;
  const user = await ctx.db.getUser(msg.jid);
  if (!user) return;
  const entitlement = resolveEntitlement(user, { isAdmin, now: ctx.now() });
  if (!entitlement.ok) {
    await sendPlans(ctx, msg.jid, isAdmin);
    return;
  }
  if (msg.media.buffer.length > ctx.config.safety.maxInputBytes) {
    await ctx.messenger.sendText(msg.jid, tooBigText());
    return;
  }
  if (user.stickerFormat === 'perguntar') {
    await ctx.db.savePendingMedia({
      jid: msg.jid,
      kind: msg.media.kind,
      mimetype: msg.media.mimetype,
      data: msg.media.buffer,
      now: ctx.now(),
      ttlMs: PENDING_MEDIA_MS,
    });
    await ctx.messenger.sendText(msg.jid, formatQuestionText());
    return;
  }
  await ctx.db.clearPendingMedia(msg.jid);
  await enqueueSticker(ctx, msg.jid, msg.media, fitForFormat(user.stickerFormat), isAdmin);
}

export async function handleFormatReply(ctx: AppContext, msg: InboundMessage, isAdmin: boolean): Promise<boolean> {
  const choice = parseFormatChoice(msg.text);
  const pending = await ctx.db.peekPendingMedia(msg.jid, ctx.now());
  if (pending === 'missing') {
    if (!choice) return false;
    await ctx.messenger.sendText(msg.jid, formatMissingText());
    return true;
  }
  if (pending === 'expired') {
    await ctx.messenger.sendText(msg.jid, formatExpiredText());
    return true;
  }
  if (!choice) {
    await ctx.messenger.sendText(msg.jid, formatQuestionText());
    return true;
  }
  const gate = await openGate(ctx, msg.jid, isAdmin);
  if (!gate.ok) return true;
  const claimed = await ctx.db.takePendingMedia(msg.jid, ctx.now());
  if (claimed.status !== 'ready') {
    await gate.release();
    await ctx.messenger.sendText(msg.jid, claimed.status === 'expired' ? formatExpiredText() : formatMissingText());
    return true;
  }
  await runSticker(ctx, msg.jid, claimed.media, choice, gate.release);
  return true;
}

export async function deliverSticker(
  messenger: Messenger,
  jid: string,
  sticker: Buffer,
  audio: Buffer | null,
): Promise<{ mode: 'sound' | 'plain'; soundError?: unknown }> {
  if (!audio?.length) {
    await messenger.sendSticker(jid, sticker);
    return { mode: 'plain' };
  }
  try {
    await messenger.sendSticker(jid, sticker, audio);
    return { mode: 'sound' };
  } catch (soundError) {
    await messenger.sendSticker(jid, sticker);
    return { mode: 'plain', soundError };
  }
}

async function enqueueSticker(ctx: AppContext, jid: string, media: MediaPayload, fit: StickerFit, isAdmin: boolean): Promise<void> {
  const gate = await openGate(ctx, jid, isAdmin);
  if (!gate.ok) return;
  await runSticker(ctx, jid, media, fit, gate.release);
}

async function runSticker(
  ctx: AppContext,
  jid: string,
  media: MediaPayload,
  fit: StickerFit,
  release: () => Promise<void>,
): Promise<void> {
  await ctx.queue.enqueue(async () => {
    try {
      await ctx.messenger.sendTyping(jid);
      const converted = await mediaToSticker(media.buffer, media.mimetype, stickerOptionsFromConfig(ctx.config, ctx.env.FFMPEG_PATH, fit));
      if (!converted.ok) {
        await release();
        await ctx.messenger.sendText(jid, converted.reason);
        return;
      }
      const audio = await maybeSound(ctx, jid, media, converted.animated);
      const delivered = await deliverSticker(ctx.messenger, jid, converted.buffer, audio);
      if (audio && delivered.soundError) ctx.log.warn('figurinha com som falhou, mandei muda', delivered.soundError);
      await ctx.db.incrementUsed(jid, ctx.now());
      await crmEvent(ctx, jid, 'sticker_made');
      const buyer = await ctx.db.getUser(jid);
      const unlimited = buyer?.planExpiresAt != null && buyer.planExpiresAt > ctx.now();
      if (buyer && buyer.balance === 0 && !buyer.isVip && !unlimited) await crmEvent(ctx, jid, 'credits_ran_out');
    } catch (error) {
      await release();
      ctx.log.error('falha na figurinha', error);
      await ctx.messenger.sendText(jid, 'Não consegui converter essa mídia.');
    }
  });
}

type Gate = { ok: false } | { ok: true; release: () => Promise<void> };

async function openGate(ctx: AppContext, jid: string, isAdmin: boolean): Promise<Gate> {
  const user = await ctx.db.getUser(jid);
  if (!user) return { ok: false };
  const entitlement = resolveEntitlement(user, { isAdmin, now: ctx.now() });
  if (!entitlement.ok) {
    await sendPlans(ctx, jid, isAdmin);
    return { ok: false };
  }
  const bypassUserLimit = isAdmin && ctx.config.safety.adminBypassesUserRateLimit;
  if (!bypassUserLimit && !ctx.limiter.tryTake(`user:${jid}`, ctx.config.safety.perUserPerMinute)) {
    await ctx.messenger.sendText(jid, rateLimitText());
    return { ok: false };
  }
  if (!ctx.limiter.tryTake('global', ctx.config.safety.globalPerMinute)) {
    await ctx.messenger.sendText(jid, globalLimitText());
    return { ok: false };
  }

  const bypassWarmup = isAdmin && ctx.config.safety.adminBypassesWarmup;
  const day = zonedDayKey(ctx.now(), ctx.config.timeZone);
  let countedDaily = false;
  if (!bypassWarmup) {
    const birthday = Number((await ctx.db.getSetting('bot_birthday_ms')) ?? ctx.now());
    const limit = dailyLimitFor(birthday, ctx.now(), ctx.config.safety);
    const reservedDaily = await ctx.db.tryIncrementDaily(day, limit);
    if (!reservedDaily) {
      await ctx.messenger.sendText(jid, warmupText(limit));
      return { ok: false };
    }
    countedDaily = true;
  }
  if (ctx.queue.size() >= ctx.config.safety.maxQueue) {
    if (countedDaily) await ctx.db.decrementDaily(day);
    await ctx.messenger.sendText(jid, queueFullText());
    return { ok: false };
  }

  let reserved: { lotId: string | null } | null = null;
  if (entitlement.source === 'credits') {
    const taken = await ctx.db.tryConsumeCredit(jid, ctx.now());
    if (!taken.ok) {
      if (countedDaily) await ctx.db.decrementDaily(day);
      await sendPlans(ctx, jid, isAdmin);
      return { ok: false };
    }
    reserved = { lotId: taken.lotId };
  }

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (countedDaily) {
      countedDaily = false;
      await ctx.db.decrementDaily(day);
    }
    if (reserved) {
      const lotId = reserved.lotId;
      reserved = null;
      await ctx.db.refundCredit(jid, lotId, ctx.now());
    }
  };
  return { ok: true, release };
}

function canCarryAudio(media: MediaPayload): boolean {
  return media.kind === 'video' || media.mimetype === 'image/gif' || media.mimetype.startsWith('video/');
}

async function maybeSound(ctx: AppContext, jid: string, media: MediaPayload, animated: boolean): Promise<Buffer | null> {
  if (!animated || !ctx.env.SOUND_STICKERS || !canCarryAudio(media)) return null;
  const user = await ctx.db.getUser(jid);
  if (!user?.soundStickers) return null;
  const extracted = await extractStickerOpus(media.buffer, {
    seconds: soundClipSeconds(ctx.config.sticker.maxAnimatedSeconds),
    ffmpegPath: ctx.env.FFMPEG_PATH,
  });
  if (!extracted.ok) {
    if (extracted.reason !== 'no-audio') ctx.log.warn('não extraí o áudio da figurinha', extracted.reason);
    return null;
  }
  return extracted.buffer;
}

async function sendPlans(ctx: AppContext, jid: string, isAdmin: boolean): Promise<void> {
  if (!ctx.limiter.tryTake(`nobalance:${jid}`, 1)) return;
  await crmEvent(ctx, jid, 'saw_plans');
  const plans = await ctx.db.listPlans();
  await ctx.messenger.sendText(jid, plansText(plans, isAdmin));
}
