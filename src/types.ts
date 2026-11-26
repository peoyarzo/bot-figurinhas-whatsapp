import type { PlanDraft, PlanKind } from './config.js';

export type Plan = PlanDraft & { edited: boolean };

export type UserRow = {
  jid: string;
  phone: string;
  pushName: string | null;
  balance: number;
  trialRemaining: number;
  stickersUsed: number;
  planId: string | null;
  planExpiresAt: number | null;
  isVip: boolean;
  hasInbound: boolean;
  /** Padrão true: vídeo com áudio vira figurinha com som. `/som off` grava false. */
  soundStickers: boolean;
  createdAt: number;
  updatedAt: number;
};

export type PaymentRow = {
  id: string;
  mpId: string | null;
  jid: string;
  planId: string;
  planName: string;
  amountCents: number;
  kind: PlanKind;
  creditsSnapshot: number | null;
  durationDaysSnapshot: number | null;
  creditsExpireDaysSnapshot: number | null;
  status: string;
  qrCode: string | null;
  createdAt: number;
  updatedAt: number;
  appliedAt: number | null;
};

export type InboundMessage = {
  jid: string;
  phone: string;
  pushName?: string;
  text: string;
  media?: { kind: 'image' | 'video'; mimetype: string; buffer: Buffer };
  mediaError?: boolean;
  fromGroup: boolean;
  document?: boolean;
};

export type SalesBucket = {
  count: number;
  amountCents: number;
  byPlan: Array<{ planId: string; planName: string; count: number; amountCents: number }>;
};

export type CreditLot = {
  remaining: number;
  expiresAt: number | null;
  createdAt: number;
};

export type ApplyOutcome =
  | { outcome: 'applied'; jid: string; planName: string; kind: PlanKind; user: UserRow; creditsExpiresAt: number | null }
  | { outcome: 'duplicate'; jid: string }
  | { outcome: 'missing' };
