import { formatBrl } from '../money.js';
import { formatDate } from '../time.js';
import type { LeadEventRow, LeadRow } from '../crm/repository.js';
import { LEAD_STAGES, STAGE_LABEL, type LeadStage } from '../crm/stage.js';

export function loginPage(error: string): string {
  return layout(
    'Entrar',
    `<form method="post" action="/admin/login" class="card narrow">
      <h1>Zapfig</h1>
      <p class="muted">Painel dos contatos. Só quem administra entra.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <label>Senha<input type="password" name="password" autocomplete="current-password" required/></label>
      <button type="submit">Entrar</button>
    </form>`,
  );
}

export function dashboardPage(input: {
  leads: number;
  buyers: number;
  revenue: { today: number; week: number; month: number };
  stages: Array<{ stage: LeadStage; label: string; count: number }>;
  plans: Array<{ planName: string; count: number; amountCents: number }>;
}): string {
  const conversion = input.leads === 0 ? '0%' : `${((input.buyers / input.leads) * 100).toFixed(1).replace('.', ',')}%`;
  const cards = [
    ['Contatos', String(input.leads)],
    ['Compraram', String(input.buyers)],
    ['Conversão', conversion],
    ['Hoje', formatBrl(input.revenue.today)],
    ['7 dias', formatBrl(input.revenue.week)],
    ['30 dias', formatBrl(input.revenue.month)],
  ]
    .map(([label, value]) => `<article class="stat"><span>${label}</span><strong>${value}</strong></article>`)
    .join('');
  const funnel = input.stages
    .map((stage) => `<li><span>${escapeHtml(stage.label)}</span><b>${stage.count}</b></li>`)
    .join('');
  const plans = input.plans.length
    ? input.plans
        .map(
          (plan) =>
            `<tr><td>${escapeHtml(plan.planName)}</td><td>${plan.count}</td><td>${formatBrl(plan.amountCents)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="3">Nenhuma venda ainda.</td></tr>';
  return layout(
    'Painel',
    `${nav('painel')}
    <section class="stats">${cards}</section>
    <div class="split">
      <section class="card"><h2>Funil</h2><ol class="funnel">${funnel}</ol></section>
      <section class="card"><h2>Receita por plano</h2>
        <table><thead><tr><th>Plano</th><th>Vendas</th><th>Total</th></tr></thead><tbody>${plans}</tbody></table>
      </section>
    </div>`,
  );
}

export function leadsPage(input: {
  rows: LeadRow[];
  total: number;
  page: number;
  pages: number;
  query: Record<string, string>;
  plans: Array<{ id: string; name: string }>;
  timeZone: string;
}): string {
  const filters = input.query;
  const stages: Array<LeadStage | ''> = ['', ...LEAD_STAGES];
  const stageOptions = stages
    .map((stage) => {
      const label = stage ? STAGE_LABEL[stage] : 'Todas as etapas';
      const selected = (filters.stage ?? '') === stage ? ' selected' : '';
      return `<option value="${escapeHtml(stage)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join('');
  const planOptions = ['<option value="">Todos os planos</option>']
    .concat(
      input.plans.map((plan) => {
        const selected = (filters.plan ?? '') === plan.id ? ' selected' : '';
        return `<option value="${escapeHtml(plan.id)}"${selected}>${escapeHtml(plan.name)}</option>`;
      }),
    )
    .join('');
  const bought = filters.bought ?? '';
  const rows = input.rows.length
    ? input.rows
        .map((lead) => {
          const name = lead.pushName || 'Sem nome';
          return `<tr>
            <td><a href="/admin/leads/${encodeURIComponent(lead.phone)}">${escapeHtml(name)}</a><div class="muted">${escapeHtml(lead.phone)}</div></td>
            <td>${escapeHtml(STAGE_LABEL[lead.stage])}</td>
            <td>${lead.purchaseCount > 0 ? 'Sim' : 'Não'}</td>
            <td>${escapeHtml(lead.lastPlanName ?? '—')}</td>
            <td>${formatBrl(lead.totalSpentCents)}</td>
            <td>${lead.stickersMade}</td>
            <td>${formatDate(lead.lastSeen, input.timeZone)}</td>
            <td><a class="wa" href="https://wa.me/${encodeURIComponent(lead.phone)}" target="_blank" rel="noreferrer">WhatsApp</a></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="8">Nenhum contato com esses filtros.</td></tr>';
  const csv = `/admin/leads.csv?${new URLSearchParams(input.query).toString()}`;
  return layout(
    'Contatos',
    `${nav('contatos')}
    <form class="filters" method="get" action="/admin/leads">
      <label>Busca<input name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="Nome ou número"/></label>
      <label>Etapa<select name="stage">${stageOptions}</select></label>
      <label>Comprou<select name="bought">
        <option value=""${bought === '' ? ' selected' : ''}>Todos</option>
        <option value="yes"${bought === 'yes' ? ' selected' : ''}>Sim</option>
        <option value="no"${bought === 'no' ? ' selected' : ''}>Não</option>
      </select></label>
      <label>Plano<select name="plan">${planOptions}</select></label>
      <label>De<input type="date" name="from" value="${escapeHtml(filters.from ?? '')}"/></label>
      <label>Até<input type="date" name="to" value="${escapeHtml(filters.to ?? '')}"/></label>
      <button type="submit">Filtrar</button>
      <a class="button" href="${escapeHtml(csv)}">CSV</a>
    </form>
    <div class="table-wrap"><table>
      <thead><tr>
        ${sortLink('Nome', 'name', input.query)}
        ${sortLink('Etapa', 'stage', input.query)}
        <th>Comprou</th>
        <th>Plano</th>
        ${sortLink('Gasto', 'spent', input.query)}
        ${sortLink('Figurinhas', 'stickers', input.query)}
        ${sortLink('Última vez', 'last_seen', input.query)}
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="pager">${input.total} contatos · página ${input.page} de ${input.pages} ${pageLink(input.page - 1, input.pages, input.query, 'Anterior')} ${pageLink(input.page + 1, input.pages, input.query, 'Próxima')}</p>`,
  );
}

export function leadDetailPage(input: {
  lead: LeadRow;
  events: LeadEventRow[];
  payments: Array<{ when: number; planName: string; amountCents: number; status: string }>;
  timeZone: string;
  saved: boolean;
}): string {
  const lead = input.lead;
  const events = input.events
    .map(
      (event) =>
        `<li><time>${formatDate(event.createdAt, input.timeZone)}</time> <b>${escapeHtml(eventLabel(event.kind))}</b>${visibleDetail(event.detail)}</li>`,
    )
    .join('');
  const payments = input.payments.length
    ? input.payments
        .map(
          (payment) =>
            `<tr><td>${formatDate(payment.when, input.timeZone)}</td><td>${escapeHtml(payment.planName)}</td><td>${formatBrl(payment.amountCents)}</td><td>${escapeHtml(payment.status)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="4">Nenhuma compra.</td></tr>';
  return layout(
    lead.pushName || lead.phone,
    `${nav('contatos')}
    <p><a href="/admin/leads">← Contatos</a></p>
    <section class="card">
      <h1>${escapeHtml(lead.pushName || 'Sem nome')}</h1>
      <p><a class="wa" href="https://wa.me/${encodeURIComponent(lead.phone)}" target="_blank" rel="noreferrer">Abrir WhatsApp ${escapeHtml(lead.phone)}</a></p>
      <dl class="facts">
        <div><dt>Etapa</dt><dd>${escapeHtml(STAGE_LABEL[lead.stage])}</dd></div>
        <div><dt>Plano</dt><dd>${escapeHtml(lead.lastPlanName ?? '—')}</dd></div>
        <div><dt>Gasto</dt><dd>${formatBrl(lead.totalSpentCents)} · ${lead.purchaseCount} compras</dd></div>
        <div><dt>Créditos</dt><dd>${lead.creditsLeft}${lead.expiresAt ? ` · até ${formatDate(lead.expiresAt, input.timeZone)}` : ''}</dd></div>
        <div><dt>Figurinhas</dt><dd>${lead.stickersMade}</dd></div>
        <div><dt>Origem</dt><dd>${escapeHtml(lead.source || '—')}</dd></div>
      </dl>
    </section>
    <section class="card"><h2>Compras</h2>
      <table><thead><tr><th>Quando</th><th>Plano</th><th>Valor</th><th>Status</th></tr></thead><tbody>${payments}</tbody></table>
    </section>
    <section class="card"><h2>Linha do tempo</h2><ol class="timeline">${events || '<li>Sem eventos.</li>'}</ol></section>
    <form class="card" method="post" action="/admin/leads/${encodeURIComponent(lead.phone)}">
      <h2>Notas e marcas</h2>
      ${input.saved ? '<p class="ok">Salvo.</p>' : ''}
      <label>Notas<textarea name="notes" rows="4">${escapeHtml(lead.notes)}</textarea></label>
      <label>Marcas<input name="tags" value="${escapeHtml(lead.tags)}" placeholder="indicou, vip"/></label>
      <button type="submit">Salvar</button>
    </form>`,
  );
}

export function leadsCsv(rows: LeadRow[], timeZone: string): string {
  const header = ['nome', 'telefone', 'etapa', 'comprou', 'plano', 'gasto_centavos', 'compras', 'figurinhas', 'creditos', 'validade', 'primeira_vez', 'ultima_vez', 'notas', 'marcas'];
  const lines = [header.join(',')];
  for (const lead of rows) {
    lines.push(
      [
        lead.pushName ?? '',
        lead.phone,
        STAGE_LABEL[lead.stage],
        lead.purchaseCount > 0 ? 'sim' : 'nao',
        lead.lastPlanName ?? '',
        String(lead.totalSpentCents),
        String(lead.purchaseCount),
        String(lead.stickersMade),
        String(lead.creditsLeft),
        lead.expiresAt ? formatDate(lead.expiresAt, timeZone) : '',
        formatDate(lead.firstSeen, timeZone),
        formatDate(lead.lastSeen, timeZone),
        lead.notes,
        lead.tags,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\n')}\n`;
}

function visibleDetail(detail: string | null): string {
  if (!detail) return '';
  if (detail.length > 48 || /^[0-9a-f-]{20,}$/i.test(detail) || /^\d{12,}$/.test(detail)) return '';
  return ` <span class="muted">${escapeHtml(detail)}</span>`;
}

function eventLabel(kind: string): string {
  const labels: Record<string, string> = {
    first_contact: 'Chamou',
    asked_help: 'Pediu ajuda',
    saw_plans: 'Viu planos',
    chose_plan: 'Escolheu plano',
    pix_generated: 'Pix gerado',
    pix_expired: 'Pix expirou',
    paid: 'Pagou',
    first_sticker: 'Primeira figurinha',
    credits_ran_out: 'Créditos acabaram',
    plan_expired: 'Plano venceu',
    vip_granted: 'VIP',
    admin_released: 'Liberado pelo admin',
  };
  return labels[kind] ?? kind;
}

function sortLink(label: string, sort: string, query: Record<string, string>): string {
  const next = { ...query, sort, dir: query.sort === sort && query.dir !== 'asc' ? 'asc' : 'desc' };
  return `<th><a href="/admin/leads?${new URLSearchParams(next).toString()}">${escapeHtml(label)}</a></th>`;
}

function pageLink(page: number, pages: number, query: Record<string, string>, label: string): string {
  if (page < 1 || page > pages) return '';
  const next = { ...query, page: String(page) };
  return `<a href="/admin/leads?${new URLSearchParams(next).toString()}">${label}</a>`;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex, nofollow"/>
  <title>${escapeHtml(title)} · Zapfig</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, Liberation Sans, sans-serif; background: #101218; color: #f4f1ea; }
    a { color: #f0b429; }
    main { max-width: 68rem; margin: 0 auto; padding: 1rem 1rem 3rem; }
    h1, h2 { font-weight: 600; }
    h1 { font-size: 1.6rem; margin: 0 0 0.4rem; }
    h2 { font-size: 1.05rem; margin: 0 0 0.8rem; }
    .nav { display: flex; gap: 0.8rem; align-items: center; margin-bottom: 1rem; }
    .nav a, .nav button { background: transparent; color: #f4f1ea; border: 0; font: inherit; padding: 0.4rem 0; }
    .nav .on { color: #f0b429; }
    .card { background: #171a22; border-radius: 16px; padding: 1rem; margin: 0 0 1rem; }
    .narrow { max-width: 22rem; }
    .muted { color: #a39e93; font-size: 0.9rem; }
    .error { color: #ffb4a8; }
    .ok { color: #b7e4c7; }
    label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; color: #d9d3c7; }
    input, select, textarea { font: inherit; color: #f4f1ea; background: #101218; border: 1px solid #2c3140; border-radius: 10px; padding: 0.65rem 0.7rem; width: 100%; }
    button, .button { display: inline-block; background: #f0b429; color: #1a1408; border: 0; border-radius: 999px; padding: 0.7rem 1rem; font-weight: 650; text-decoration: none; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.7rem; margin-bottom: 1rem; }
    .stat { background: #171a22; border-radius: 16px; padding: 0.9rem; }
    .stat span { display: block; color: #a39e93; font-size: 0.85rem; }
    .stat strong { font-size: 1.35rem; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .funnel, .timeline { list-style: none; padding: 0; margin: 0; }
    .funnel li, .timeline li { display: flex; justify-content: space-between; gap: 1rem; padding: 0.45rem 0; border-bottom: 1px solid #2c3140; }
    .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.6rem; align-items: end; margin-bottom: 1rem; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.55rem 0.4rem; border-bottom: 1px solid #2c3140; vertical-align: top; }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.7rem; }
    .facts dt { color: #a39e93; font-size: 0.8rem; }
    .facts dd { margin: 0.15rem 0 0; }
    .wa { font-weight: 650; }
    .pager { display: flex; gap: 0.8rem; align-items: center; }
    @media (max-width: 800px) { .split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function nav(current: 'painel' | 'contatos'): string {
  return `<nav class="nav">
    <strong>Zapfig</strong>
    <a class="${current === 'painel' ? 'on' : ''}" href="/admin">Painel</a>
    <a class="${current === 'contatos' ? 'on' : ''}" href="/admin/leads">Contatos</a>
    <form method="post" action="/admin/logout"><button type="submit">Sair</button></form>
  </nav>`;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
