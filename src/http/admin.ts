import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { safeEqual } from '../security.js';
import { SlidingWindowLimiter } from '../safety/limiter.js';
import { zonedMidnight } from '../time.js';
import {
  exportLeads,
  getLeadByPhone,
  leadTotals,
  listLeadEvents,
  listPaymentsForJid,
  queryLeads,
  stageCounts,
  updateLeadNotes,
  type LeadQuery,
  type LeadRow,
} from '../crm/repository.js';
import { LEAD_STAGES, STAGE_LABEL, isLeadStage } from '../crm/stage.js';
import { clearSessionCookie, openSession, readCookie, sealSession, sessionCookie } from './session.js';
import { dashboardPage, leadDetailPage, leadsCsv, leadsPage, loginPage } from './admin-pages.js';

const SESSION_MS = 12 * 60 * 60 * 1000;

export function registerAdmin(app: FastifyInstance, ctx: AppContext): void {
  const loginLimiter = new SlidingWindowLimiter(() => ctx.now(), 15 * 60 * 1000);
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    const params = new URLSearchParams(String(body));
    const form: Record<string, string> = {};
    for (const [key, value] of params) form[key] = value;
    done(null, form);
  });

  app.get('/admin/login', async (request, reply) => {
    if (!enabled(ctx)) return notFound(reply);
    if (authed(request, ctx)) return reply.redirect('/admin');
    return html(reply, loginPage(''));
  });

  app.post('/admin/login', async (request, reply) => {
    if (!enabled(ctx)) return notFound(reply);
    const ip = request.ip || 'local';
    if (!loginLimiter.tryTake(`login:${ip}`, 8)) {
      reply.header('retry-after', '60');
      return html(reply.code(429), loginPage('Muitas tentativas. Espera um pouco.'));
    }
    const password = formValue(request, 'password');
    const expected = ctx.env.ADMIN_PASSWORD ?? '';
    if (!safeEqual(password, expected)) return html(reply.code(401), loginPage('Senha incorreta.'));
    const token = sealSession(ctx.env.ADMIN_SESSION_SECRET ?? '', ctx.now() + SESSION_MS);
    reply.header('set-cookie', sessionCookie(token, SESSION_MS / 1000));
    return reply.redirect('/admin');
  });

  app.post('/admin/logout', async (request, reply) => {
    if (!enabled(ctx)) return notFound(reply);
    reply.header('set-cookie', clearSessionCookie());
    return reply.redirect('/admin/login');
  });

  app.get('/admin', async (request, reply) => {
    if (!enabled(ctx)) return notFound(reply);
    if (!authed(request, ctx)) return reply.redirect('/admin/login');
    const now = ctx.now();
    const zone = ctx.config.timeZone;
    const day = zonedMidnight(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)), zone);
    const [totals, counts, today, week, month, plans] = await Promise.all([
      leadTotals(ctx.db.client),
      stageCounts(ctx.db.client),
      ctx.db.salesSince(day),
      ctx.db.salesSince(now - 7 * 86_400_000),
      ctx.db.salesSince(now - 30 * 86_400_000),
      ctx.db.salesSince(0),
    ]);
    const byStage = new Map(counts.map((item) => [item.stage, item.count]));
    return html(
      reply,
      dashboardPage({
        leads: totals.leads,
        buyers: totals.buyers,
        revenue: { today: today.amountCents, week: week.amountCents, month: month.amountCents },
        stages: LEAD_STAGES.map((stage) => ({ stage, label: STAGE_LABEL[stage], count: byStage.get(stage) ?? 0 })),
        plans: plans.byPlan,
      }),
    );
  });

  app.get('/admin/leads', async (request, reply) => {
    if (!enabled(ctx)) return notFound(reply);
    if (!authed(request, ctx)) return reply.redirect('/admin/login');
    const query = queryBag(request);
    const filter = leadFilter(query, ctx.config.timeZone);
    const [{ rows, total }, plans] = await Promise.all([queryLeads(ctx.db.client, filter), ctx.db.listPlans()]);
    const pages = Math.max(1, Math.ceil(total / (filter.pageSize ?? 20)));
    return html(
      reply,
      leadsPage({
        rows,
        total,
        page: filter.page ?? 1,
        pages,
        query,
        plans: plans.map((plan) => ({ id: plan.id, name: plan.name })),
        timeZone: ctx.config.timeZone,
      }),
    );
  });

  app.get('/admin/leads.csv', async (request, reply) => {
    if (!enabled(ctx)) return notFound(reply);
    if (!authed(request, ctx)) return reply.redirect('/admin/login');
    const rows = await exportLeads(ctx.db.client, leadFilter(queryBag(request), ctx.config.timeZone));
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="zapfig-contatos.csv"')
      .send(leadsCsv(rows, ctx.config.timeZone));
  });

  app.get('/admin/leads/:phone', async (request, reply) => {
    if (!enabled(ctx)) return notFound(reply);
    if (!authed(request, ctx)) return reply.redirect('/admin/login');
    const phone = (request.params as { phone: string }).phone.replace(/\D/g, '');
    const lead = await getLeadByPhone(ctx.db.client, phone);
    if (!lead) return notFound(reply);
    return html(reply, await detail(ctx, lead, false));
  });

  app.post('/admin/leads/:phone', async (request, reply) => {
    if (!enabled(ctx)) return notFound(reply);
    if (!authed(request, ctx)) return reply.redirect('/admin/login');
    const phone = (request.params as { phone: string }).phone.replace(/\D/g, '');
    const lead = await getLeadByPhone(ctx.db.client, phone);
    if (!lead) return notFound(reply);
    await updateLeadNotes(ctx.db.client, phone, formValue(request, 'notes'), formValue(request, 'tags'), ctx.now());
    const fresh = await getLeadByPhone(ctx.db.client, phone);
    return html(reply, await detail(ctx, fresh ?? lead, true));
  });
}

async function detail(ctx: AppContext, lead: LeadRow, saved: boolean): Promise<string> {
  const [events, payments] = await Promise.all([listLeadEvents(ctx.db.client, lead.jid), listPaymentsForJid(ctx.db.client, lead.jid)]);
  return leadDetailPage({
    lead,
    events,
    saved,
    timeZone: ctx.config.timeZone,
    payments: payments.map((payment) => ({
      when: Number(payment.created_at ?? 0),
      planName: String(payment.plan_name ?? ''),
      amountCents: Number(payment.amount_cents ?? 0),
      status: String(payment.status ?? ''),
    })),
  });
}

function enabled(ctx: AppContext): boolean {
  return Boolean(ctx.env.ADMIN_PASSWORD && ctx.env.ADMIN_SESSION_SECRET);
}

function authed(request: FastifyRequest, ctx: AppContext): boolean {
  const token = readCookie(request.headers.cookie);
  return openSession(ctx.env.ADMIN_SESSION_SECRET ?? '', token, ctx.now());
}

function html(reply: FastifyReply, body: string): FastifyReply {
  return reply.type('text/html; charset=utf-8').header('x-robots-tag', 'noindex, nofollow').header('cache-control', 'no-store').send(body);
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ ok: false, error: 'não encontrado' });
}

function formValue(request: FastifyRequest, key: string): string {
  const body = request.body;
  if (!body || typeof body !== 'object' || !(key in body)) return '';
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function queryBag(request: FastifyRequest): Record<string, string> {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const bag: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') bag[key] = value;
  }
  return bag;
}

function leadFilter(query: Record<string, string>, timeZone: string): LeadQuery {
  const sort = query.sort;
  const allowed = ['last_seen', 'first_seen', 'name', 'spent', 'stickers', 'stage'] as const;
  const picked = allowed.find((item) => item === sort) ?? 'last_seen';
  const stage = query.stage && isLeadStage(query.stage) ? query.stage : '';
  return {
    q: query.q ?? '',
    stage,
    bought: query.bought === 'yes' || query.bought === 'no' ? query.bought : '',
    planId: query.plan ?? '',
    fromMs: query.from ? zonedMidnight(query.from, timeZone) : null,
    toMs: query.to ? zonedMidnight(query.to, timeZone) + 86_400_000 : null,
    sort: picked,
    dir: query.dir === 'asc' ? 'asc' : 'desc',
    page: Math.max(1, Number(query.page) || 1),
    pageSize: 20,
  };
}
