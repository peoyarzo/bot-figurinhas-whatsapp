/**
 * Tudo que muda o negócio fica aqui.
 * Preço é sempre em centavos (350 = R$ 3,50).
 * Plano já gravado no banco e editado pelo /planos set não é
 * sobrescrito no boot. /planos reset <id> volta para estes valores.
 */

export type PlanKind = 'credits' | 'unlimited';

export type PlanDraft = {
  id: string;
  name: string;
  priceCents: number;
  kind: PlanKind;
  credits: number | null;
  durationDays: number | null;
  /** null = os créditos não vencem. Número positivo = vencem N dias depois da compra. */
  creditsExpireDays: number | null;
  priceIsPlaceholder: boolean;
  active: boolean;
  sortOrder: number;
};

export type SafetyConfig = {
  ignoreGroups: boolean;
  perUserPerMinute: number;
  globalPerMinute: number;
  maxInFlight: number;
  maxQueue: number;
  jitterMinMs: number;
  jitterMaxMs: number;
  hintPerMinute: number;
  warmup: Array<{ day: number; dailyLimit: number }>;
  dailyLimitAfterWarmup: number;
  markOnlineOnConnect: boolean;
  adminBypassesUserRateLimit: boolean;
  adminBypassesWarmup: boolean;
  maxInputBytes: number;
};

export type AppConfig = {
  timeZone: string;
  sticker: {
    packId: string;
    packName: string;
    author: string;
    emojis: string[];
    maxStaticBytes: number;
    maxAnimatedBytes: number;
    maxAnimatedSeconds: number;
  };
  payments: {
    refreshMinIntervalMs: number;
    webhookMaxSkewMs: number;
  };
  safety: SafetyConfig;
  plans: PlanDraft[];
};

const baseConfig: AppConfig = {
  timeZone: 'America/Sao_Paulo',
  sticker: {
    packId: 'figurinhas-bot',
    packName: 'Figurinhas',
    author: 'Figurinhas',
    emojis: ['✨'],
    maxStaticBytes: 100 * 1024,
    maxAnimatedBytes: 500 * 1024,
    maxAnimatedSeconds: 6,
  },
  payments: {
    refreshMinIntervalMs: 15_000,
    webhookMaxSkewMs: 10 * 60 * 1000,
  },
  safety: {
    ignoreGroups: true,
    perUserPerMinute: 4,
    globalPerMinute: 12,
    maxInFlight: 2,
    maxQueue: 20,
    jitterMinMs: 800,
    jitterMaxMs: 2200,
    hintPerMinute: 1,
    warmup: [
      { day: 1, dailyLimit: 30 },
      { day: 2, dailyLimit: 60 },
      { day: 3, dailyLimit: 120 },
    ],
    dailyLimitAfterWarmup: 400,
    markOnlineOnConnect: false,
    adminBypassesUserRateLimit: true,
    adminBypassesWarmup: true,
    maxInputBytes: 8 * 1024 * 1024,
  },
  plans: [
    {
      id: 'pack15',
      name: '15 figurinhas',
      priceCents: 350,
      kind: 'credits',
      credits: 15,
      durationDays: null,
      creditsExpireDays: 30,
      priceIsPlaceholder: false,
      active: true,
      sortOrder: 1,
    },
    {
      id: 'pack25',
      name: '25 figurinhas',
      priceCents: 550,
      kind: 'credits',
      credits: 25,
      durationDays: null,
      creditsExpireDays: null,
      priceIsPlaceholder: false,
      active: true,
      sortOrder: 2,
    },
    {
      id: 'weekly',
      name: 'Semanal ilimitado',
      priceCents: 790,
      kind: 'unlimited',
      credits: null,
      durationDays: 7,
      creditsExpireDays: null,
      priceIsPlaceholder: false,
      active: true,
      sortOrder: 3,
    },
    {
      id: 'days30',
      name: '30 dias',
      priceCents: 1490,
      kind: 'unlimited',
      credits: null,
      durationDays: 30,
      creditsExpireDays: null,
      priceIsPlaceholder: false,
      active: true,
      sortOrder: 4,
    },
    {
      id: 'months3',
      name: '3 meses',
      priceCents: 1990,
      kind: 'unlimited',
      credits: null,
      durationDays: 90,
      creditsExpireDays: null,
      priceIsPlaceholder: false,
      active: true,
      sortOrder: 5,
    },
  ],
};

export function loadConfig(): AppConfig {
  return structuredClone(baseConfig);
}
