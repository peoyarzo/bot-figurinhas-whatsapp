import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  type AuthenticationState,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { Client } from '@libsql/client';
import pino from 'pino';
import { assertPairingChipAllowed, isForbiddenBotChip } from '../chip-guard.js';
import type { Logger } from '../logger.js';
import type { InboundMessage } from '../types.js';
import { clearAuthState, useLibsqlAuthState } from './auth-state.js';
import { ConnectionController, type SocketLike } from './connection.js';
import type { Messenger } from './messenger.js';
import { normalizeIncoming } from './normalize.js';

type WaSocket = ReturnType<typeof makeWASocket>;

export function createBaileysMessenger(getSocket: () => WaSocket | null): Messenger {
  return {
    async sendText(jid, text) {
      const sock = requireSocket(getSocket);
      await sock.sendMessage(jid, { text });
    },
    async sendImage(jid, buffer, caption) {
      const sock = requireSocket(getSocket);
      await sock.sendMessage(jid, { image: buffer, caption });
    },
    async sendSticker(jid, buffer) {
      const sock = requireSocket(getSocket);
      await sock.sendMessage(jid, { sticker: buffer });
    },
    async sendTyping(jid) {
      const sock = requireSocket(getSocket);
      await sock.sendPresenceUpdate('composing', jid);
    },
  };
}

function requireSocket(getSocket: () => WaSocket | null): WaSocket {
  const sock = getSocket();
  if (!sock) throw new Error('socket do WhatsApp indisponível');
  return sock;
}

export async function buildBaileys(input: {
  client: Client;
  onMessage: (message: InboundMessage) => Promise<void>;
  pairingNumber?: string;
  markOnlineOnConnect: boolean;
  logger: Logger;
}): Promise<{ controller: ConnectionController; messenger: Messenger }> {
  assertPairingChipAllowed(input.pairingNumber);
  const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' });
  let version: [number, number, number] | undefined;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
  } catch (error) {
    input.logger.warn('não consegui buscar a versão do WhatsApp; sigo com o padrão da biblioteca', error);
  }

  let current: WaSocket | null = null;
  const controller = new ConnectionController({
    loadAuth: async () => {
      const auth = await useLibsqlAuthState(input.client);
      assertPairingChipAllowed(auth.state.creds.me?.id);
      return auth;
    },
    isForbiddenChip: isForbiddenBotChip,
    onForbiddenChip: () => {
      input.logger.error('Encerrando: a sessão pareada é o número proibido como chip.');
      process.exit(1);
    },
    createSocket: (state) => {
      const sock = makeWASocket({
        auth: state as AuthenticationState,
        printQRInTerminal: false,
        markOnlineOnConnect: input.markOnlineOnConnect,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        browser: Browsers.ubuntu('Chrome'),
        logger: baileysLogger,
        ...(version ? { version } : {}),
      });
      current = sock;
      return sock as unknown as SocketLike;
    },
    onMessage: input.onMessage,
    normalize: (raw) =>
      normalizeIncoming(raw, async (message) => {
        const sock = current;
        if (!sock) throw new Error('socket indisponível para baixar mídia');
        const downloaded = await downloadMediaMessage(message as WAMessage, 'buffer', {}, {
          logger: baileysLogger,
          reuploadRequest: (msg) => sock.updateMediaMessage(msg),
        });
        return Buffer.from(downloaded);
      }),
    resetAuth: () => clearAuthState(input.client),
    pairingNumber: input.pairingNumber,
    loggedOutStatusCode: DisconnectReason.loggedOut,
    logger: input.logger,
  });
  return { controller, messenger: createBaileysMessenger(() => current) };
}
