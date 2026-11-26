export const LEAD_EVENTS = [
  'first_contact',
  'asked_help',
  'saw_plans',
  'chose_plan',
  'pix_generated',
  'pix_expired',
  'paid',
  'first_sticker',
  'sticker_made',
  'credits_ran_out',
  'plan_expired',
  'vip_granted',
  'admin_released',
] as const;

export type LeadEventKind = (typeof LEAD_EVENTS)[number];

export const LEAD_STAGES = [
  'chamou',
  'viu_planos',
  'escolheu_plano',
  'pix_gerado',
  'pix_expirou',
  'pagou',
  'usando',
  'creditos_acabaram',
  'plano_venceu',
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export const STAGE_LABEL: Record<LeadStage, string> = {
  chamou: 'Chamou',
  viu_planos: 'Viu planos',
  escolheu_plano: 'Escolheu plano',
  pix_gerado: 'Pix gerado',
  pix_expirou: 'Pix expirou sem pagar',
  pagou: 'Pagou',
  usando: 'Usando',
  creditos_acabaram: 'Créditos acabaram',
  plano_venceu: 'Plano venceu',
};

const RANK: Record<LeadStage, number> = {
  chamou: 1,
  viu_planos: 2,
  escolheu_plano: 3,
  pix_gerado: 4,
  pix_expirou: 5,
  pagou: 6,
  usando: 7,
  creditos_acabaram: 8,
  plano_venceu: 8,
};

const STOP = new Set<LeadStage>(['pix_expirou', 'creditos_acabaram', 'plano_venceu']);

function targetOf(event: LeadEventKind): LeadStage | null {
  switch (event) {
    case 'first_contact':
    case 'asked_help':
      return 'chamou';
    case 'saw_plans':
      return 'viu_planos';
    case 'chose_plan':
      return 'escolheu_plano';
    case 'pix_generated':
      return 'pix_gerado';
    case 'pix_expired':
      return 'pix_expirou';
    case 'paid':
      return 'pagou';
    case 'first_sticker':
    case 'sticker_made':
      return 'usando';
    case 'credits_ran_out':
      return 'creditos_acabaram';
    case 'plan_expired':
      return 'plano_venceu';
    default:
      return null;
  }
}

/** Avança o funil. Não volta para uma etapa anterior, exceto quando a pessoa recomeça depois de parar. */
export function nextStage(current: LeadStage | null, event: LeadEventKind): LeadStage | null {
  const target = targetOf(event);
  if (!target) return current;
  if (!current) return target;
  if (event === 'paid' || event === 'credits_ran_out' || event === 'plan_expired') return target;
  if (event === 'pix_expired') {
    if (RANK[current] >= RANK.pagou && !STOP.has(current)) return current;
    return 'pix_expirou';
  }
  if (STOP.has(current)) {
    if (event === 'chose_plan' || event === 'pix_generated' || event === 'first_sticker' || event === 'sticker_made') return target;
    return current;
  }
  return RANK[target] > RANK[current] ? target : current;
}

export function isLeadStage(value: string): value is LeadStage {
  return (LEAD_STAGES as readonly string[]).includes(value);
}
