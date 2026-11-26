import { assertPairingChipAllowed } from './chip-guard.js';

export type Env = {
  PORT: number;
  HOST: string;
  NODE_ENV: string;
  LOG_LEVEL: string;
  ADMIN_TOKEN: string;
  ADMIN_NUMBERS: string[];
  LIBSQL_URL: string;
  LIBSQL_AUTH_TOKEN?: string;
  MOCK_WHATSAPP: boolean;
  MOCK_MP: boolean;
  MP_ACCESS_TOKEN?: string;
  MP_WEBHOOK_SECRET?: string;
  MP_PAYER_EMAIL: string;
  MP_PAYER_FIRST_NAME: string;
  PUBLIC_BASE_URL?: string;
  PAIRING_NUMBER?: string;
  FFMPEG_PATH?: string;
  /** Padrão true. `0`, `false` ou `off` desliga a figurinha com som no servidor. */
  SOUND_STICKERS: boolean;
  /** Vazio desliga /admin (responde 404). */
  ADMIN_PASSWORD?: string;
  /** Assina o cookie da sessão do painel. Obrigatório junto com ADMIN_PASSWORD. */
  ADMIN_SESSION_SECRET?: string;
};

function read(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = source[key];
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const token = read(source, 'ADMIN_TOKEN');
  if (!token) throw new Error('ADMIN_TOKEN é obrigatório');
  const port = Number(read(source, 'PORT') ?? '8787');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT inválida');
  const adminNumbers = (read(source, 'ADMIN_NUMBERS') ?? '')
    .split(',')
    .map((item) => item.replace(/\D/g, ''))
    .filter(Boolean);
  const pairing = read(source, 'PAIRING_NUMBER')?.replace(/\D/g, '');
  assertPairingChipAllowed(pairing);
  const base = read(source, 'PUBLIC_BASE_URL')?.replace(/\/$/, '');
  return {
    PORT: port,
    HOST: read(source, 'HOST') ?? '0.0.0.0',
    NODE_ENV: read(source, 'NODE_ENV') ?? 'development',
    LOG_LEVEL: read(source, 'LOG_LEVEL') ?? 'info',
    ADMIN_TOKEN: token,
    ADMIN_NUMBERS: adminNumbers,
    LIBSQL_URL: read(source, 'LIBSQL_URL') ?? 'file:local.db',
    LIBSQL_AUTH_TOKEN: read(source, 'LIBSQL_AUTH_TOKEN'),
    MOCK_WHATSAPP: read(source, 'MOCK_WHATSAPP') === '1',
    MOCK_MP: read(source, 'MOCK_MP') === '1',
    MP_ACCESS_TOKEN: read(source, 'MP_ACCESS_TOKEN'),
    MP_WEBHOOK_SECRET: read(source, 'MP_WEBHOOK_SECRET'),
    MP_PAYER_EMAIL: read(source, 'MP_PAYER_EMAIL') ?? 'pagador.sandbox@example.com',
    MP_PAYER_FIRST_NAME: read(source, 'MP_PAYER_FIRST_NAME') ?? 'APRO',
    PUBLIC_BASE_URL: base,
    PAIRING_NUMBER: pairing,
    FFMPEG_PATH: read(source, 'FFMPEG_PATH'),
    SOUND_STICKERS: flagDefaultTrue(source, 'SOUND_STICKERS'),
    ADMIN_PASSWORD: read(source, 'ADMIN_PASSWORD'),
    ADMIN_SESSION_SECRET: read(source, 'ADMIN_SESSION_SECRET'),
  };
}

function flagDefaultTrue(source: NodeJS.ProcessEnv, key: string): boolean {
  const value = read(source, key);
  if (value == null) return true;
  const cleaned = value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (['0', 'false', 'off', 'no', 'nao'].includes(cleaned)) return false;
  if (['1', 'true', 'on', 'yes', 'sim'].includes(cleaned)) return true;
  throw new Error(`${key} inválido`);
}
