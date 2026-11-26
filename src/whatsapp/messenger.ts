import type { Logger } from '../logger.js';
import type { Database } from '../db/database.js';

export type Outbound =
  | { type: 'text'; jid: string; text: string }
  | { type: 'image'; jid: string; buffer: Buffer; caption?: string }
  | { type: 'sticker'; jid: string; buffer: Buffer; audio?: Buffer }
  | { type: 'typing'; jid: string };

export interface Messenger {
  sendText(jid: string, text: string): Promise<void>;
  sendImage(jid: string, buffer: Buffer, caption?: string): Promise<void>;
  sendSticker(jid: string, buffer: Buffer, audio?: Buffer): Promise<void>;
  sendTyping(jid: string): Promise<void>;
}

export class RecordingMessenger implements Messenger {
  readonly sent: Outbound[] = [];

  async sendText(jid: string, text: string): Promise<void> {
    this.sent.push({ type: 'text', jid, text });
  }

  async sendImage(jid: string, buffer: Buffer, caption?: string): Promise<void> {
    this.sent.push({ type: 'image', jid, buffer, caption });
  }

  async sendSticker(jid: string, buffer: Buffer, audio?: Buffer): Promise<void> {
    this.sent.push(audio?.length ? { type: 'sticker', jid, buffer, audio } : { type: 'sticker', jid, buffer });
  }

  async sendTyping(jid: string): Promise<void> {
    this.sent.push({ type: 'typing', jid });
  }
}

/** Recusa qualquer envio para quem ainda não mandou mensagem. Não existe broadcast. */
export class GuardedMessenger implements Messenger {
  constructor(
    private readonly inner: Messenger,
    private readonly db: Database,
    private readonly log: Logger,
  ) {}

  private async assert(jid: string): Promise<void> {
    const user = await this.db.getUser(jid);
    if (!user?.hasInbound) {
      this.log.error('bloqueei envio: a pessoa não chamou o bot primeiro', { jid });
      throw new Error('envio bloqueado: sem mensagem recebida');
    }
  }

  async sendText(jid: string, text: string): Promise<void> {
    await this.assert(jid);
    await this.inner.sendText(jid, text);
  }

  async sendImage(jid: string, buffer: Buffer, caption?: string): Promise<void> {
    await this.assert(jid);
    await this.inner.sendImage(jid, buffer, caption);
  }

  async sendSticker(jid: string, buffer: Buffer, audio?: Buffer): Promise<void> {
    await this.assert(jid);
    await this.inner.sendSticker(jid, buffer, audio);
  }

  async sendTyping(jid: string): Promise<void> {
    await this.assert(jid);
    await this.inner.sendTyping(jid);
  }
}
