import sharp from 'sharp';
import { formatDate } from '../time.js';
import type { UserRow } from '../types.js';

export type StatusModel = {
  name: string;
  plan: string;
  headline: string;
  caption: string;
  detail: string;
  used: number;
  brand: string;
};

export type CreditLotView = { remaining: number; expiresAt: number | null };

export function buildStatusModel(input: {
  user: UserRow;
  isAdmin: boolean;
  now: number;
  planName: string | null;
  timeZone: string;
  brand: string;
  lots?: CreditLotView[];
}): StatusModel {
  const name = clip(input.user.pushName || input.user.phone, 22);
  const used = input.user.stickersUsed;
  const brand = input.brand;
  if (input.isAdmin) {
    return { name, plan: 'Admin', headline: '∞', caption: 'sem limite', detail: 'figurinhas ilimitadas', used, brand };
  }
  if (input.user.isVip) {
    return { name, plan: 'VIP', headline: '∞', caption: 'sem limite', detail: 'figurinhas ilimitadas', used, brand };
  }
  const unlimited = input.user.planExpiresAt != null && input.user.planExpiresAt > input.now;
  if (unlimited && input.user.planExpiresAt) {
    const days = Math.max(1, Math.ceil((input.user.planExpiresAt - input.now) / 86_400_000));
    const extras = input.user.balance > 0 ? creditNote(input.lots, input.timeZone, input.user.balance) : '';
    return {
      name,
      plan: input.planName ?? 'Ilimitado',
      headline: String(days),
      caption: days === 1 ? 'dia restante' : 'dias restantes',
      detail: [`válido até ${formatDate(input.user.planExpiresAt, input.timeZone)}`, extras].filter(Boolean).join(' · '),
      used,
      brand,
    };
  }
  if (input.user.balance > 0) {
    return {
      name,
      plan: 'Pacote',
      headline: String(input.user.balance),
      caption: input.user.balance === 1 ? 'figurinha restante' : 'figurinhas restantes',
      detail: input.lots ? creditExpiryDetail(input.lots, input.timeZone, input.user.balance) : 'avulsas',
      used,
      brand,
    };
  }
  return { name, plan: 'Sem plano', headline: '0', caption: 'figurinhas', detail: 'veja /planos', used, brand };
}

function creditNote(lots: CreditLotView[] | undefined, timeZone: string, balance: number): string {
  if (!lots) return `${balance} avulsas guardadas`;
  return creditExpiryDetail(lots, timeZone, balance);
}

export function creditExpiryDetail(lots: CreditLotView[], timeZone: string, balance: number): string {
  const expiring = new Map<number, number>();
  let permanent = 0;
  let tracked = 0;
  for (const lot of lots) {
    tracked += lot.remaining;
    if (lot.expiresAt == null) permanent += lot.remaining;
    else expiring.set(lot.expiresAt, (expiring.get(lot.expiresAt) ?? 0) + lot.remaining);
  }
  permanent += Math.max(0, balance - tracked);
  const parts: string[] = [];
  for (const expiresAt of [...expiring.keys()].sort((a, b) => a - b)) {
    parts.push(`${expiring.get(expiresAt) ?? 0} até ${formatDate(expiresAt, timeZone)}`);
  }
  if (permanent > 0) parts.push(parts.length ? `${permanent} não vencem` : 'não vencem');
  return parts.join(' · ') || 'avulsas';
}

export function renderStatusCardSvg(model: StatusModel): string {
  const pillWidth = Math.min(420, Math.max(120, model.plan.length * 16 + 36));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="960" height="540" viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg">
  <rect width="960" height="540" fill="#101218"/>
  <rect x="36" y="32" width="888" height="476" rx="28" fill="#171a22"/>
  <rect x="36" y="32" width="14" height="476" rx="7" fill="#f0b429"/>
  <text x="78" y="86" fill="#a39e93" font-size="16" font-family="Inter, Liberation Sans, DejaVu Sans, sans-serif" letter-spacing="3">SEU SALDO</text>
  <text x="78" y="148" fill="#f7f3ea" font-size="44" font-family="Inter, Liberation Sans, DejaVu Sans, sans-serif">${escapeXml(model.name)}</text>
  <rect x="78" y="172" width="${pillWidth}" height="36" rx="18" fill="#2a2418"/>
  <text x="96" y="196" fill="#f0b429" font-size="18" font-family="Inter, Liberation Sans, DejaVu Sans, sans-serif">${escapeXml(model.plan)}</text>
  <text x="78" y="340" fill="#f7f3ea" font-size="108" font-family="Inter, Liberation Sans, DejaVu Sans, sans-serif">${escapeXml(model.headline)}</text>
  <text x="78" y="386" fill="#a39e93" font-size="24" font-family="Inter, Liberation Sans, DejaVu Sans, sans-serif">${escapeXml(model.caption)}</text>
  <text x="78" y="430" fill="#d9d3c7" font-size="20" font-family="Inter, Liberation Sans, DejaVu Sans, sans-serif">${escapeXml(clip(model.detail, 64))}</text>
  <line x1="78" y1="462" x2="884" y2="462" stroke="#2c3140" stroke-width="2"/>
  <text x="78" y="498" fill="#f7f3ea" font-size="18" font-family="Inter, Liberation Sans, DejaVu Sans, sans-serif">usadas ${model.used}</text>
  <text x="884" y="498" fill="#a39e93" font-size="18" font-family="Inter, Liberation Sans, DejaVu Sans, sans-serif" text-anchor="end">${escapeXml(model.brand)}</text>
  <g fill="none" stroke="#2c3140" stroke-width="3">
    <rect x="690" y="150" width="150" height="150" rx="28"/>
    <rect x="718" y="178" width="94" height="94" rx="18"/>
  </g>
</svg>`;
}

export async function renderStatusCard(model: StatusModel): Promise<Buffer> {
  return sharp(Buffer.from(renderStatusCardSvg(model))).png({ compressionLevel: 9 }).toBuffer();
}

export function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}
