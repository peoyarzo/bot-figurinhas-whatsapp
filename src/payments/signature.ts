import { createHmac, timingSafeEqual } from 'node:crypto';

export function buildManifest(dataId: string, requestId: string, ts: string): string {
  const parts: string[] = [];
  if (dataId) parts.push(`id:${dataId.toLowerCase()}`);
  if (requestId) parts.push(`request-id:${requestId}`);
  parts.push(`ts:${ts}`);
  return `${parts.join(';')};`;
}

export function signWebhook(input: { dataId: string; requestId: string; ts: string; secret: string }): string {
  const manifest = buildManifest(input.dataId, input.requestId, input.ts);
  const hash = createHmac('sha256', input.secret).update(manifest).digest('hex');
  return `ts=${input.ts},v1=${hash}`;
}

function timestampMs(ts: string): number | null {
  if (!/^\d+$/.test(ts)) return null;
  const value = Number(ts);
  if (!Number.isFinite(value)) return null;
  if (ts.length >= 13 || value > 10_000_000_000) return value;
  return value * 1000;
}

export function verifyMpSignature(input: {
  signatureHeader: string | undefined;
  requestId: string | undefined;
  dataId: string;
  secret: string;
  nowMs: number;
  maxSkewMs: number;
}): boolean {
  if (!input.secret || !input.signatureHeader) return false;
  let ts = '';
  let received = '';
  for (const part of input.signatureHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    if (key === 'v1') received = value;
  }
  if (!ts || !/^[0-9a-f]+$/i.test(received) || received.length % 2 !== 0) return false;
  const stamp = timestampMs(ts);
  if (stamp == null) return false;
  if (input.maxSkewMs > 0 && Math.abs(input.nowMs - stamp) > input.maxSkewMs) return false;
  const expected = createHmac('sha256', input.secret).update(buildManifest(input.dataId, input.requestId ?? '', ts)).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
