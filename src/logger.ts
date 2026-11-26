export type Logger = {
  info: (message: string, extra?: unknown) => void;
  warn: (message: string, extra?: unknown) => void;
  error: (message: string, extra?: unknown) => void;
};

function pack(extra: unknown): unknown {
  if (extra instanceof Error) return { name: extra.name, message: extra.message };
  return extra;
}

export function createLogger(): Logger {
  const write = (level: 'info' | 'warn' | 'error', message: string, extra?: unknown) => {
    const line = {
      time: new Date().toISOString(),
      level,
      msg: message,
      ...(extra === undefined ? {} : { extra: pack(extra) }),
    };
    const out = level === 'error' ? console.error : console.log;
    out(JSON.stringify(line));
  };
  return {
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
  };
}

export function createMemoryLogger(): { logger: Logger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const logger: Logger = {
    info: (msg) => lines.push({ level: 'info', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
  };
  return { logger, lines };
}
