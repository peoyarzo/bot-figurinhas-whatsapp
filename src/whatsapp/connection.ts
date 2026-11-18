import type { Logger } from '../logger.js';
import type { InboundMessage } from '../types.js';

export function nextBackoffMs(attempt: number, base = 1000, cap = 30_000): number {
  return Math.min(cap, base * 2 ** attempt);
}

export type ConnectionSnapshot = {
  status: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'logged_out' | 'mock';
  qr: string | null;
  pairingCode: string | null;
  attempt: number;
};

export type SocketLike = {
  ev: {
    on: (event: string, listener: (payload: unknown) => void) => void;
    removeAllListeners: () => void;
  };
  end: (error?: unknown) => void;
  authState?: { creds?: { registered?: boolean; me?: { id?: string } } };
  requestPairingCode?: (phone: string) => Promise<string>;
  sendMessage?: (jid: string, content: unknown) => Promise<unknown>;
  sendPresenceUpdate?: (type: 'composing' | 'paused', jid: string) => Promise<unknown>;
};

type DisconnectUpdate = {
  connection?: 'open' | 'close' | 'connecting';
  qr?: string;
  lastDisconnect?: { error?: { output?: { statusCode?: number } } };
};

export type ConnectionDeps = {
  loadAuth: () => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  createSocket: (state: unknown) => SocketLike;
  onMessage: (message: InboundMessage) => Promise<void>;
  normalize: (raw: unknown) => Promise<InboundMessage | null>;
  resetAuth?: () => Promise<void>;
  pairingNumber?: string;
  isForbiddenChip?: (value: string | undefined) => boolean;
  onForbiddenChip?: () => void;
  loggedOutStatusCode: number;
  logger: Logger;
  backoff?: (attempt: number) => number;
  schedule?: (fn: () => void, ms: number) => () => void;
};

export interface ConnectionHandle {
  snapshot: () => ConnectionSnapshot;
  stop: () => Promise<void>;
  resetAndRestart: () => Promise<void>;
  idle: () => Promise<void>;
  getSocket: () => SocketLike | null;
  open?: () => Promise<void>;
}

/**
 * Uma conexão por vez: o socket antigo perde os listeners e é encerrado
 * antes de abrir outro. loggedOut para de vez e avisa no log.
 */
export class ConnectionController implements ConnectionHandle {
  private sock: SocketLike | null = null;
  private generation = 0;
  private attempt = 0;
  private status: ConnectionSnapshot['status'] = 'idle';
  private qr: string | null = null;
  private pairingCode: string | null = null;
  private pairingNumber: string | undefined;
  private pairingTried = new Set<number>();
  private stopped = false;
  private loggedOut = false;
  private opening: Promise<void> | null = null;
  private timerCancel: (() => void) | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ConnectionDeps) {
    if (deps.pairingNumber && !/^\d{8,15}$/.test(deps.pairingNumber)) {
      deps.logger.error('PAIRING_NUMBER inválido. Use só dígitos, com DDI, sem + ou espaços.');
      this.pairingNumber = undefined;
    } else {
      this.pairingNumber = deps.pairingNumber;
    }
  }

  snapshot(): ConnectionSnapshot {
    return { status: this.status, qr: this.qr, pairingCode: this.pairingCode, attempt: this.attempt };
  }

  getSocket(): SocketLike | null {
    return this.sock;
  }

  async idle(): Promise<void> {
    await this.tail;
  }

  async open(): Promise<void> {
    if (this.stopped || this.loggedOut) return;
    if (this.opening) return this.opening;
    this.opening = this.openInner().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timerCancel) {
      this.timerCancel();
      this.timerCancel = null;
    }
    this.destroyCurrent();
    await this.idle();
  }

  async resetAndRestart(): Promise<void> {
    this.stopped = false;
    this.loggedOut = false;
    if (this.timerCancel) {
      this.timerCancel();
      this.timerCancel = null;
    }
    this.status = 'connecting';
    this.attempt = 0;
    this.qr = null;
    this.pairingCode = null;
    this.pairingTried.clear();
    this.destroyCurrent();
    if (this.deps.resetAuth) await this.deps.resetAuth();
    await this.open();
  }

  private track(work: Promise<void>): void {
    this.tail = this.tail.then(() => work, () => work);
  }

  private destroyCurrent(): void {
    const sock = this.sock;
    if (!sock) return;
    this.sock = null;
    this.generation += 1;
    try {
      sock.ev.removeAllListeners();
    } catch (error) {
      this.deps.logger.warn('falha ao remover listeners do socket', error);
    }
    try {
      sock.end(undefined);
    } catch (error) {
      this.deps.logger.warn('falha ao encerrar o socket', error);
    }
  }

  private async openInner(): Promise<void> {
    this.destroyCurrent();
    if (this.stopped || this.loggedOut) return;
    const gen = ++this.generation;
    this.status = 'connecting';
    const auth = await this.deps.loadAuth();
    if (gen !== this.generation || this.stopped || this.loggedOut) return;
    const sock = this.deps.createSocket(auth.state);
    if (gen !== this.generation || this.stopped || this.loggedOut) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch {
        // o socket novo nem chegou a ser o atual
      }
      return;
    }
    this.sock = sock;
    sock.ev.on('creds.update', () => {
      this.track(auth.saveCreds().catch((error: unknown) => this.deps.logger.error('falha ao gravar credenciais', error)));
    });
    sock.ev.on('connection.update', (payload) => {
      if (gen !== this.generation) return;
      this.track(this.handleUpdate(sock, gen, payload));
    });
    sock.ev.on('messages.upsert', (payload) => {
      if (gen !== this.generation) return;
      this.track(this.handleMessages(payload));
    });
  }

  private refuseForbiddenChip(): void {
    this.loggedOut = true;
    this.status = 'logged_out';
    this.qr = null;
    this.pairingCode = null;
    this.destroyCurrent();
    this.deps.logger.error('Recusei iniciar: o chip pareado é 5511976882096. Esse número pode ser admin, nunca o chip do bot.');
    this.deps.onForbiddenChip?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.loggedOut || this.timerCancel) return;
    const delay = (this.deps.backoff ?? nextBackoffMs)(this.attempt);
    this.attempt += 1;
    this.status = 'reconnecting';
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
    this.timerCancel = schedule(() => {
      this.timerCancel = null;
      this.track(this.open());
    }, delay);
  }

  private async handleUpdate(sock: SocketLike, gen: number, payload: unknown): Promise<void> {
    const update = payload as DisconnectUpdate;
    if (update.qr) this.qr = update.qr;
    if (update.connection === 'open') {
      const chip = sock.authState?.creds?.me?.id;
      if (chip && this.deps.isForbiddenChip?.(chip)) {
        this.refuseForbiddenChip();
        return;
      }
      this.status = 'open';
      this.attempt = 0;
      this.qr = null;
    }
    if (this.pairingNumber && this.deps.isForbiddenChip?.(this.pairingNumber)) {
      this.refuseForbiddenChip();
      return;
    }
    if (update.qr && this.pairingNumber && !sock.authState?.creds?.registered && !this.pairingTried.has(gen)) {
      this.pairingTried.add(gen);
      if (sock.requestPairingCode) {
        try {
          const code = await sock.requestPairingCode(this.pairingNumber);
          if (this.generation === gen) this.pairingCode = code;
        } catch (error) {
          this.deps.logger.error('falha ao pedir código de pareamento', error);
        }
      } else {
        this.deps.logger.error('socket sem requestPairingCode');
      }
    }
    if (update.connection !== 'close') return;
    const statusCode = update.lastDisconnect?.error?.output?.statusCode;
    this.destroyCurrent();
    if (statusCode === this.deps.loggedOutStatusCode) {
      this.loggedOut = true;
      this.status = 'logged_out';
      this.qr = null;
      this.deps.logger.error('Sessão do WhatsApp encerrada (loggedOut). Parei a reconexão. Não vou abrir outro socket até o reset da sessão.');
      return;
    }
    if (!this.stopped) this.scheduleReconnect();
  }

  private async handleMessages(payload: unknown): Promise<void> {
    const typed = payload as { messages?: unknown[]; type?: string };
    if (typed.type && typed.type !== 'notify') return;
    for (const raw of typed.messages ?? []) {
      try {
        const message = await this.deps.normalize(raw);
        if (!message) continue;
        await this.deps.onMessage(message);
      } catch (error) {
        this.deps.logger.error('falha ao tratar mensagem', error);
      }
    }
  }
}

export function mockConnection(): ConnectionHandle {
  return {
    snapshot: () => ({ status: 'mock', qr: null, pairingCode: null, attempt: 0 }),
    stop: async () => {},
    resetAndRestart: async () => {},
    idle: async () => {},
    getSocket: () => null,
  };
}
