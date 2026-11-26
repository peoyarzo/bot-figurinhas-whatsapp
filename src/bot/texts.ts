import type { Plan } from '../types.js';
import { formatBrl } from '../money.js';
import { friendlyAlias } from '../plans.js';
import type { SalesBucket } from '../types.js';
import type { StatusModel } from '../stickers/status-card.js';

export function menuText(isAdmin: boolean): string {
  const lines = [
    'Oi. Eu sou o Zapfig. Transformo imagem, GIF ou vídeo curto (até 6 segundos) em figurinha.',
    'Vídeo com áudio pode sair com som. O recurso ainda está no beta do WhatsApp: em alguns celulares a figurinha chega muda.',
    '',
    '/menu — esta lista',
    '/planos — ver preços',
    '/comprar 15 — pagar o pacote no Pix',
    '/status — cartão com saldo e validade',
    '/som on — figurinha com som quando houver áudio',
    '/som off — figurinha muda',
    '',
    'Não há figurinha grátis. Sem saldo, eu mando os planos.',
  ];
  if (isAdmin) {
    lines.push(
      '',
      'Admin:',
      '/vendas — resumo do dia, da semana e do mês',
      '/liberar <numero> <plano>',
      '/vip <numero> — sem número, lista a VIP',
      '/unvip <numero>',
      '/pausar e /retomar',
    );
  }
  return lines.join('\n');
}

export function plansText(plans: Plan[], isAdmin: boolean): string {
  const lines = ['Planos', ''];
  for (const plan of plans) {
    if (!plan.active && !isAdmin) continue;
    const price = plan.priceIsPlaceholder ? `${formatBrl(plan.priceCents)} (PREÇO PLACEHOLDER)` : formatBrl(plan.priceCents);
    const detail = planDetail(plan);
    lines.push(`• ${plan.name} — ${price}${plan.active ? '' : ' (inativo)'}`);
    lines.push(`  ${detail}`);
    lines.push(`  /comprar ${friendlyAlias(plan.id)}`);
  }
  if (isAdmin) {
    lines.push(
      '',
      'Editar:',
      '/planos set <id> preco 7,90',
      '/planos set <id> creditos 20',
      '/planos set <id> dias 7',
      '/planos set <id> nome Novo nome',
      '/planos set <id> ativo sim',
      '/planos set <id> placeholder nao',
      '/planos reset <id>',
    );
  }
  return lines.join('\n');
}

export function buyHelpText(plans: Plan[]): string {
  const aliases = plans.filter((plan) => plan.active).map((plan) => `/comprar ${friendlyAlias(plan.id)}`);
  return ['Qual plano?', ...aliases].join('\n');
}

export function pixIntro(mode: 'mock' | 'mercadopago' | 'unconfigured', accessToken?: string): string {
  if (mode === 'mock') return 'Isto é um Pix simulado. Ninguém é cobrado.';
  if (accessToken?.startsWith('TEST-')) return 'Pix de teste do Mercado Pago. Não use dinheiro real.';
  return 'Pix copia e cola:';
}

export function pixText(input: { intro: string; planName: string; amount: string; qr: string }): string {
  return [input.intro, '', `${input.planName} — ${input.amount}`, '', 'Copia e cola:', input.qr, '', 'Quando o pagamento for aprovado, eu libero o plano sozinho. Se você já pagou e nada mudou, manda /status que eu consulto de novo.'].join('\n');
}

export function paidText(input: { planName: string; kind: 'credits' | 'unlimited'; balance: number; expiresLabel: string | null }): string {
  if (input.kind === 'unlimited') {
    if (input.expiresLabel) return `Pagamento aprovado. ${input.planName} liberado até ${input.expiresLabel}. Pode mandar imagem, GIF ou vídeo curto.`;
    return `Pagamento aprovado. ${input.planName} liberado. Pode mandar imagem, GIF ou vídeo curto.`;
  }
  if (input.expiresLabel) return `Pagamento aprovado. ${input.planName} liberado. Saldo: ${input.balance} figurinhas, válidas até ${input.expiresLabel}.`;
  return `Pagamento aprovado. ${input.planName} liberado. Saldo: ${input.balance} figurinhas. Não vencem.`;
}

function planDetail(plan: Plan): string {
  if (plan.kind === 'unlimited') return `${plan.durationDays ?? 0} dias sem limite`;
  const credits = `${plan.credits ?? 0} figurinhas`;
  if (plan.creditsExpireDays != null && plan.creditsExpireDays > 0) return `${credits}, valem ${plan.creditsExpireDays} dias`;
  return `${credits}, não vencem`;
}

export function idleText(): string {
  return 'Manda uma imagem, GIF ou vídeo curto. /menu lista os comandos.';
}

export function rateLimitText(): string {
  return 'Muitas figurinhas em pouco tempo. Espera um minuto e manda de novo.';
}

export function globalLimitText(): string {
  return 'Estou no limite geral deste minuto. Tenta de novo já já.';
}

export function warmupText(limit: number): string {
  return `Cheguei no limite de hoje (${limit}). Nos primeiros dias eu faço menos figurinhas para a conta não ser bloqueada. Amanhã o limite sobe.`;
}

export function queueFullText(): string {
  return 'Fila cheia agora. Manda de novo em alguns segundos.';
}

export function tooBigText(): string {
  return 'Esse arquivo passa de 8 MB. Manda uma imagem ou um vídeo menor.';
}

export function documentText(): string {
  return 'Manda como foto ou vídeo, não como arquivo.';
}

export function adminOnlyText(): string {
  return 'Esse comando é só de quem administra o bot.';
}

export function unknownCommandText(): string {
  return 'Não conheço esse comando. /menu mostra o que eu sei fazer.';
}

export function pausedText(): string {
  return 'Zapfig pausado. Eu não respondo ninguém até /retomar. A sessão do WhatsApp continua.';
}

export function resumedText(): string {
  return 'Zapfig retomado.';
}

export function soundOnText(): string {
  return 'Som ligado. Vídeo e GIF com áudio viram figurinha com som. Continua valendo uma figurinha.';
}

export function soundOffText(): string {
  return 'Som desligado. A figurinha sai muda.';
}

export function soundUsageText(enabled: boolean): string {
  return `Som ${enabled ? 'ligado' : 'desligado'}. Use /som on ou /som off.`;
}

export function soundServerOffText(enabled: boolean): string {
  return `Preferência salva: som ${enabled ? 'ligado' : 'desligado'}. Neste servidor SOUND_STICKERS está desligado, então a figurinha sai muda.`;
}

export function statusCaption(model: StatusModel): string {
  return `${model.plan} · ${model.headline} ${model.caption} · ${model.detail} · usadas ${model.used}`;
}

export function salesText(input: { day: SalesBucket; week: SalesBucket; month: SalesBucket }): string {
  const block = (title: string, bucket: SalesBucket) => `${title}: ${bucket.count} · ${formatBrl(bucket.amountCents)}`;
  const lines = ['Vendas aprovadas (horário de Brasília)', '', block('Hoje', input.day), block('Esta semana', input.week), block('Este mês', input.month), '', 'Hoje por plano:'];
  if (!input.day.byPlan.length) lines.push('nenhuma');
  for (const plan of input.day.byPlan) lines.push(`• ${plan.planName} — ${plan.count} — ${formatBrl(plan.amountCents)}`);
  return lines.join('\n');
}

export function placeholderBuyText(plan: Plan): string {
  return `O plano ${plan.name} ainda está com preço placeholder (${formatBrl(plan.priceCents)}). O dono precisa confirmar o valor em src/config.ts ou com /planos set ${plan.id} preco 9,90.`;
}
