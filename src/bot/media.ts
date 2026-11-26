import type { AppContext } from '../context.js';
import { zonedDayKey } from '../time.js';
import type { InboundMessage } from '../types.js';
import { extractStickerOpus, soundClipSeconds } from '../stickers/audio.js';
import { mediaToSticker, stickerOptionsFromConfig } from '../stickers/convert.js';
import type { Messenger } from '../whatsapp/messenger.js';
import { dailyLimitFor } from '../safety/warmup.js';
import { resolveEntitlement } from './entitlement.js';
import { globalLimitText, plansText, queueFullText, rateLimitText, tooBigText, warmupText } from './texts.js';

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
  const bypassUserLimit = isAdmin && ctx.config.safety.adminBypassesUserRateLimit;
  if (!bypassUserLimit && !ctx.limiter.tryTake(`user:${msg.jid}`, ctx.config.safety.perUserPerMinute)) {
    await ctx.messenger.sendText(msg.jid, rateLimitText());
    return;
  }
  if (!ctx.limiter.tryTake('global', ctx.config.safety.globalPerMinute)) {
    await ctx.messenger.sendText(msg.jid, globalLimitText());
    return;
  }

  const bypassWarmup = isAdmin && ctx.config.safety.adminBypassesWarmup;
  const day = zonedDayKey(ctx.now(), ctx.config.timeZone);
  let countedDaily = false;
  if (!bypassWarmup) {
    const birthday = Number((await ctx.db.getSetting('bot_birthday_ms')) ?? ctx.now());
    const limit = dailyLimitFor(birthday, ctx.now(), ctx.config.safety);
    const reserved = await ctx.db.tryIncrementDaily(day, limit);
    if (!reserved) {
      await ctx.messenger.sendText(msg.jid, warmupText(limit));
      return;
    }
    countedDaily = true;
  }
  if (ctx.queue.size() >= ctx.config.safety.maxQueue) {
    if (countedDaily) await ctx.db.decrementDaily(day);
    await ctx.messenger.sendText(msg.jid, queueFullText());
    return;
  }

  let reserved: { lotId: string | null } | null = null;
  if (entitlement.source === 'credits') {
    const taken = await ctx.db.tryConsumeCredit(msg.jid, ctx.now());
    if (!taken.ok) {
      if (countedDaily) await ctx.db.decrementDaily(day);
      await sendPlans(ctx, msg.jid, isAdmin);
      return;
    }
    reserved = { lotId: taken.lotId };
  }

  const release = async () => {
    if (countedDaily) {
      countedDaily = false;
      await ctx.db.decrementDaily(day);
    }
    if (reserved) {
      const lotId = reserved.lotId;
      reserved = null;
      await ctx.db.refundCredit(msg.jid, lotId, ctx.now());
    }
  };

  await ctx.queue.enqueue(async () => {
    try {
      await ctx.messenger.sendTyping(msg.jid);
      const converted = await mediaToSticker(msg.media!.buffer, msg.media!.mimetype, stickerOptionsFromConfig(ctx.config, ctx.env.FFMPEG_PATH));
      if (!converted.ok) {
        await release();
        await ctx.messenger.sendText(msg.jid, converted.reason);
        return;
      }
      const audio = await maybeSound(ctx, msg, converted.animated);
      const delivered = await deliverSticker(ctx.messenger, msg.jid, converted.buffer, audio);
      if (audio && delivered.soundError) ctx.log.warn('figurinha com som falhou, mandei muda', delivered.soundError);
      await ctx.db.incrementUsed(msg.jid, ctx.now());
    } catch (error) {
      await release();
      ctx.log.error('falha na figurinha', error);
      await ctx.messenger.sendText(msg.jid, 'Não consegui converter essa mídia.');
    }
  });
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

function canCarryAudio(media: { kind: 'image' | 'video'; mimetype: string }): boolean {
  return media.kind === 'video' || media.mimetype === 'image/gif' || media.mimetype.startsWith('video/');
}

async function maybeSound(ctx: AppContext, msg: InboundMessage, animated: boolean): Promise<Buffer | null> {
  if (!animated || !ctx.env.SOUND_STICKERS || !msg.media || !canCarryAudio(msg.media)) return null;
  const user = await ctx.db.getUser(msg.jid);
  if (!user?.soundStickers) return null;
  const extracted = await extractStickerOpus(msg.media.buffer, {
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
  const plans = await ctx.db.listPlans();
  await ctx.messenger.sendText(jid, plansText(plans, isAdmin));
}
