import { createHmac } from 'node:crypto';
import { safeEqual } from '../security.js';

const COOKIE = 'zapfig_admin';

export function sealSession(secret: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function openSession(secret: string, token: string, now: number): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(mac, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof data.exp === 'number' && data.exp > now;
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  const base = `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=${maxAgeSec}`;
  return base;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`;
}

export function readCookie(header: string | undefined, name = COOKIE): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return '';
}
