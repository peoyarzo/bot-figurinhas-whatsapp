import type { AppContext } from '../context.js';
import { zonedDayKey } from '../time.js';
import type { InboundMessage } from '../types.js';
import { mediaToSticker, stickerOptionsFromConfig } from '../stickers/convert.js';
import { dailyLimitFor } from '../safety/warmup.js';
import { resolveEntitlement } from './entitlement.js';
import { globalLimitText, noBalanceText, queueFullText, rateLimitText, tooBigText, warmupText } from './texts.js';

export async function handleMedia(ctx: AppContext, msg: InboundMessage, isAdmin: boolean): Promise<void> {
  if (!msg.media) return;
  const user = await ctx.db.getUser(msg.jid);
  if (!user) return;
  const entitlement = resolveEntitlement(user, { isAdmin, now: ctx.now() });
  if (!entitlement.ok) {
    if (ctx.limiter.tryTake(`nobalance:${msg.jid}`, 1)) await ctx.messenger.sendText(msg.jid, noBalanceText());
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

  let reserved: 'balance' | 'trial' | null = null;
  if (entitlement.source === 'credits' || entitlement.source === 'trial') {
    const bucket = entitlement.source === 'credits' ? 'balance' : 'trial';
    const took = await ctx.db.tryConsumeCredit(msg.jid, bucket, ctx.now());
    if (!took) {
      if (countedDaily) await ctx.db.decrementDaily(day);
      await ctx.messenger.sendText(msg.jid, noBalanceText());
      return;
    }
    reserved = bucket;
  }

  const release = async () => {
    if (countedDaily) {
      countedDaily = false;
      await ctx.db.decrementDaily(day);
    }
    if (reserved) {
      const bucket = reserved;
      reserved = null;
      await ctx.db.refundCredit(msg.jid, bucket, ctx.now());
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
      await ctx.messenger.sendSticker(msg.jid, converted.buffer);
      await ctx.db.incrementUsed(msg.jid, ctx.now());
    } catch (error) {
      await release();
      ctx.log.error('falha na figurinha', error);
      await ctx.messenger.sendText(msg.jid, 'Não consegui converter essa mídia.');
    }
  });
}
