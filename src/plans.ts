const ALIASES: Record<string, string> = {
  '15': 'pack15',
  pack15: 'pack15',
  fig15: 'pack15',
  '25': 'pack25',
  pack25: 'pack25',
  fig25: 'pack25',
  semanal: 'weekly',
  semana: 'weekly',
  weekly: 'weekly',
  '30': 'days30',
  mensal: 'days30',
  '30dias': 'days30',
  days30: 'days30',
  trimestral: 'months3',
  '3meses': 'months3',
  '90dias': 'months3',
  months3: 'months3',
};

const FRIENDLY: Record<string, string> = {
  pack15: '15',
  pack25: '25',
  weekly: 'semanal',
  days30: '30',
  months3: 'trimestral',
};

export function resolvePlanId(token: string): string | null {
  return ALIASES[token.trim().toLowerCase()] ?? null;
}

export function friendlyAlias(planId: string): string {
  return FRIENDLY[planId] ?? planId;
}
