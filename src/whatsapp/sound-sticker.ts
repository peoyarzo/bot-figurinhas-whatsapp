import {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
  type WAMediaUploadFunction,
} from '@whiskeysockets/baileys';
import { OPUS_MIME } from '../stickers/audio.js';

type Pending = { audio: proto.Message.IAudioMessage; token: number };

const pending = new Map<string, Pending>();
let nextToken = 0;
let installed = false;

type ProtoWriter = ReturnType<typeof proto.Message.encode>;

export function soundStickerKey(fileSha256: Uint8Array): string {
  return Buffer.from(fileSha256).toString('base64');
}

export function resetSoundStickerState(): void {
  pending.clear();
}

/** Liga o áudio ao fileSha256 do webp. O encode do Baileys consulta isso e tira o registro no fim do envio. */
export function registerSoundSticker(fileSha256: Uint8Array, audio: proto.Message.IAudioMessage): number {
  const token = ++nextToken;
  pending.set(soundStickerKey(fileSha256), { audio, token });
  return token;
}

export function clearSoundSticker(fileSha256: Uint8Array, token: number): void {
  const key = soundStickerKey(fileSha256);
  const current = pending.get(key);
  if (current?.token === token) pending.delete(key);
}

function lookupAudio(fileSha256: Uint8Array | null | undefined): proto.Message.IAudioMessage | undefined {
  if (!fileSha256?.length) return undefined;
  return pending.get(soundStickerKey(fileSha256))?.audio;
}

/**
 * O WAProto da 6.7.24 (e da 7.0.0-rc14) não tem o campo 134.
 * Na hora do encode, se este sticker tem áudio registrado, o stickerMessage
 * de topo sai do fio e entra 134 { 1 { 26: sticker + campo 24 = 0 + campo 26 = áudio } }.
 * O deviceSentMessage chama Message.encode de novo, então os outros aparelhos recebem o mesmo fio.
 * Sem registro, o encode original segue intacto.
 */
export function installSoundStickerEncodePatch(): void {
  if (installed) return;
  installed = true;
  const original = proto.Message.encode;
  proto.Message.encode = function (message, writer) {
    const sticker = message?.stickerMessage;
    const audio = sticker ? lookupAudio(sticker.fileSha256) : undefined;
    if (!sticker || !audio) return original(message, writer);
    const holder = message as { stickerMessage?: proto.IMessage['stickerMessage'] };
    holder.stickerMessage = null;
    try {
      const out = original(message, writer);
      appendField134(out, sticker, audio);
      return out;
    } finally {
      holder.stickerMessage = sticker;
    }
  };
}

function audioForWire(audio: proto.Message.IAudioMessage): proto.Message.IAudioMessage {
  const copy: proto.Message.IAudioMessage = { ...audio, mimetype: OPUS_MIME };
  delete copy.ptt;
  return copy;
}

function appendField134(writer: ProtoWriter, sticker: proto.Message.IStickerMessage, audio: proto.Message.IAudioMessage): void {
  const stickerBytes = encodeStickerWithAudio(sticker, audio);
  const innerMessage = wrapLengthDelimited(26, stickerBytes);
  const futureProof = wrapLengthDelimited(1, innerMessage);
  writer.uint32((134 << 3) | 2).bytes(futureProof);
}

function encodeStickerWithAudio(sticker: proto.Message.IStickerMessage, audio: proto.Message.IAudioMessage): Uint8Array {
  const writer = proto.Message.StickerMessage.encode(sticker);
  writer.uint32((24 << 3) | 0).uint32(0);
  const audioBytes = proto.Message.AudioMessage.encode(audioForWire(audio)).finish();
  writer.uint32((26 << 3) | 2).bytes(audioBytes);
  return writer.finish();
}

function wrapLengthDelimited(field: number, payload: Uint8Array): Uint8Array {
  const writer = proto.Message.StickerMessage.encode({});
  writer.uint32((field << 3) | 2).bytes(payload);
  return writer.finish();
}

type SoundSocket = {
  user?: { id?: string | null } | null;
  waUploadToServer: WAMediaUploadFunction;
  relayMessage: (jid: string, message: proto.IMessage, options: { messageId: string }) => Promise<unknown>;
};

export async function relaySoundSticker(sock: SoundSocket, jid: string, webp: Buffer, opus: Buffer): Promise<void> {
  installSoundStickerEncodePatch();
  const upload = sock.waUploadToServer;
  const [stickerPrepared, audioPrepared] = await Promise.all([
    prepareWAMessageMedia({ sticker: webp, isAnimated: true, mimetype: 'image/webp' }, { upload, mediaTypeOverride: 'sticker' }),
    prepareWAMessageMedia({ audio: opus, mimetype: OPUS_MIME, ptt: false }, { upload, mediaTypeOverride: 'audio' }),
  ]);
  const stickerMessage = stickerPrepared.stickerMessage;
  const audioMessage = audioPrepared.audioMessage;
  const sha = stickerMessage?.fileSha256;
  if (!stickerMessage || !sha?.length || !audioMessage) throw new Error('upload da figurinha com som incompleto');
  audioMessage.mimetype = OPUS_MIME;
  delete audioMessage.ptt;
  const token = registerSoundSticker(sha, audioMessage);
  try {
    const userJid = sock.user?.id;
    if (!userJid) throw new Error('socket sem usuário');
    const created = generateWAMessageFromContent(jid, { stickerMessage }, { userJid });
    const message = created.message;
    const messageId = created.key.id;
    if (!message || !messageId) throw new Error('não montei a figurinha com som');
    await sock.relayMessage(jid, message, { messageId });
  } finally {
    clearSoundSticker(sha, token);
  }
}
