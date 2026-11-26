import { phoneFromJid } from '../phone.js';
import type { InboundMessage } from '../types.js';

type RawKey = { remoteJid?: string | null; fromMe?: boolean | null };
type RawMessage = { key?: RawKey; pushName?: string; message?: Record<string, unknown> | null };

function unwrap(message: Record<string, unknown> | null | undefined, depth = 0): Record<string, unknown> | null {
  if (!message || depth > 3) return message ?? null;
  const nested = (message.ephemeralMessage ?? message.viewOnceMessage ?? message.viewOnceMessageV2) as
    | { message?: Record<string, unknown> }
    | undefined;
  if (nested?.message) return unwrap(nested.message, depth + 1);
  return message;
}

function textOf(message: Record<string, unknown>): string {
  if (typeof message.conversation === 'string') return message.conversation;
  const extended = message.extendedTextMessage as { text?: string } | undefined;
  if (typeof extended?.text === 'string') return extended.text;
  const image = message.imageMessage as { caption?: string } | undefined;
  if (typeof image?.caption === 'string') return image.caption;
  const video = message.videoMessage as { caption?: string } | undefined;
  if (typeof video?.caption === 'string') return video.caption;
  return '';
}

export async function normalizeIncoming(raw: unknown, download: (raw: unknown) => Promise<Buffer>): Promise<InboundMessage | null> {
  const message = raw as RawMessage;
  const jid = message.key?.remoteJid ?? '';
  if (!jid || message.key?.fromMe) return null;
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return null;
  const content = unwrap(message.message);
  if (!content) return null;
  if (content.stickerMessage || content.protocolMessage || content.reactionMessage) return null;

  const base = {
    jid,
    phone: phoneFromJid(jid),
    pushName: message.pushName,
    fromGroup: jid.endsWith('@g.us'),
    text: textOf(content),
  };

  if (content.documentMessage) return { ...base, document: true };
  const image = content.imageMessage as { mimetype?: string } | undefined;
  const video = content.videoMessage as { mimetype?: string; gifPlayback?: boolean } | undefined;
  if (!image && !video) {
    if (!base.text) return null;
    return base;
  }

  const kind = video ? 'video' : 'image';
  const mimetype = video?.mimetype || image?.mimetype || (video?.gifPlayback ? 'image/gif' : 'image/jpeg');
  try {
    const buffer = await download(raw);
    return { ...base, media: { kind, mimetype, buffer } };
  } catch {
    return { ...base, mediaError: true };
  }
}
