import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ConnectionController, nextBackoffMs, type SocketLike } from '../src/whatsapp/connection.js';
import { isForbiddenBotChip } from '../src/chip-guard.js';
import { createMemoryLogger } from '../src/logger.js';
import type { InboundMessage } from '../src/types.js';

function fakeSocket(id: number, registered: boolean, events: string[]): SocketLike & { emit: (event: string, payload: unknown) => void } {
  const ev = new EventEmitter();
  const sock = {
    id,
    ev,
    end() {
      events.push(`end${id}`);
    },
    authState: { creds: { registered } },
    requestPairingCode: async (phone: string) => {
      events.push(`pair${phone}`);
      return 'ABCD1234';
    },
    emit(event: string, payload: unknown) {
      ev.emit(event, payload);
    },
  };
  return sock;
}

describe('reconexão', () => {
  it('cresce o backoff até o teto', () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(2)).toBe(4000);
    expect(nextBackoffMs(10)).toBe(30_000);
  });

  it('encerra o socket antigo antes de abrir outro e para no loggedOut', async () => {
    const events: string[] = [];
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const tasks: Array<{ fn: () => void; ms: number }> = [];
    const { logger, lines } = createMemoryLogger();
    let loads = 0;
    const controller = new ConnectionController({
      loadAuth: async () => {
        loads += 1;
        return { state: { generation: loads }, saveCreds: async () => {} };
      },
      createSocket: () => {
        const sock = fakeSocket(sockets.length + 1, true, events);
        events.push(`create${sock.id}`);
        sockets.push(sock);
        return sock;
      },
      onMessage: async () => {
        events.push('message');
      },
      normalize: async (raw) => raw as InboundMessage,
      loggedOutStatusCode: 401,
      logger,
      schedule: (fn, ms) => {
        tasks.push({ fn, ms });
        return () => {
          const index = tasks.findIndex((task) => task.fn === fn);
          if (index >= 0) tasks.splice(index, 1);
        };
      },
    });
    await controller.open();
    expect(events).toEqual(['create1']);
    sockets[0].emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await controller.idle();
    expect(tasks.map((task) => task.ms)).toEqual([1000]);
    expect(events).toContain('end1');
    tasks[0].fn();
    await controller.idle();
    expect(events).toEqual(['create1', 'end1', 'create2']);
    expect(loads).toBe(2);
    sockets[0].emit('messages.upsert', { type: 'notify', messages: [{ jid: 'old' }] });
    await controller.idle();
    sockets[1].emit('messages.upsert', { type: 'notify', messages: [{ jid: 'new' }] });
    sockets[1].emit('messages.upsert', { type: 'append', messages: [{ jid: 'history' }] });
    await controller.idle();
    expect(events.filter((item) => item === 'message')).toEqual(['message']);

    sockets[1].emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await controller.idle();
    expect(controller.snapshot().status).toBe('logged_out');
    expect(lines.some((line) => line.level === 'error' && line.msg.includes('loggedOut'))).toBe(true);
    const created = events.filter((item) => item.startsWith('create')).length;
    await controller.open();
    expect(events.filter((item) => item.startsWith('create')).length).toBe(created);
  });

  it('pede o código de pareamento uma vez', async () => {
    const events: string[] = [];
    let sock: ReturnType<typeof fakeSocket> | null = null;
    const { logger } = createMemoryLogger();
    const controller = new ConnectionController({
      loadAuth: async () => ({ state: {}, saveCreds: async () => {} }),
      createSocket: () => {
        sock = fakeSocket(1, false, events);
        return sock;
      },
      onMessage: async () => {},
      normalize: async () => null,
      pairingNumber: '5511900000001',
      loggedOutStatusCode: 401,
      logger,
      schedule: () => () => {},
    });
    await controller.open();
    sock!.emit('connection.update', { qr: 'qr-1', connection: 'connecting' });
    await controller.idle();
    sock!.emit('connection.update', { qr: 'qr-2' });
    await controller.idle();
    expect(events.filter((item) => item.startsWith('pair'))).toEqual(['pair5511900000001']);
    expect(controller.snapshot().qr).toBe('qr-2');
    expect(controller.snapshot().pairingCode).toBe('ABCD1234');
  });

  it('para se a sessão pareada for o chip proibido', async () => {
    const events: string[] = [];
    let sock: ReturnType<typeof fakeSocket> | null = null;
    const { logger, lines } = createMemoryLogger();
    let notified = 0;
    const controller = new ConnectionController({
      loadAuth: async () => ({ state: {}, saveCreds: async () => {} }),
      createSocket: () => {
        sock = fakeSocket(1, true, events);
        sock.authState = { creds: { registered: true, me: { id: '5511976882096:0@s.whatsapp.net' } } };
        events.push('create1');
        return sock;
      },
      onMessage: async () => {},
      normalize: async () => null,
      isForbiddenChip: isForbiddenBotChip,
      onForbiddenChip: () => {
        notified += 1;
      },
      loggedOutStatusCode: 401,
      logger,
      schedule: (fn, ms) => {
        events.push(`sched${ms}`);
        return () => {};
      },
    });
    await controller.open();
    sock!.emit('connection.update', { connection: 'open' });
    await controller.idle();
    expect(controller.snapshot().status).toBe('logged_out');
    expect(events).toContain('end1');
    expect(events.some((item) => item.startsWith('sched'))).toBe(false);
    expect(notified).toBe(1);
    expect(lines.some((line) => line.msg.includes('5511976882096'))).toBe(true);
    await controller.open();
    expect(events.filter((item) => item.startsWith('create'))).toEqual(['create1']);
  });
});
