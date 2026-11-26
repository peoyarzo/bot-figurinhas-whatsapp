import { describe, expect, it } from 'vitest';
import { startDemo } from '../src/demo-flow.js';

describe('demo mock', () => {
  it('compra simulada, webhook idempotente e figurinha sem WhatsApp real', async () => {
    const report = await startDemo();
    expect(report.webhookStatuses).toEqual([200, 200]);
    expect(report.balance).toBe(14);
    expect(report.transcript).toContain('R$ 5,50');
    expect(report.transcript).toContain('R$ 7,90');
    expect(report.transcript).toContain('R$ 14,90');
    expect(report.transcript).toContain('R$ 19,90');
    expect(report.transcript).toContain('valem 30 dias');
    expect(report.transcript).not.toMatch(/figurinha de teste|teste grátis/);
    expect(report.stickerBytes).toBeGreaterThan(100);
    expect(report.stickerBytes).toBeLessThanOrEqual(100 * 1024);
    expect(report.cardBytes).toBeGreaterThan(1000);
    expect(report.transcript).toContain('Pix simulado');
    expect(report.transcript).toContain('Pagamento aprovado');
    expect(report.transcript).toContain('sem abrir socket');
    expect(report.salesText).toContain('R$ 3,50');
  }, 30_000);
});
