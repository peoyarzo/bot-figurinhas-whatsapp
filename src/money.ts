export function formatBrl(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const reais = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}R$ ${grouped},${frac}`;
}

export function parseBrl(input: string): number | null {
  const cleaned = input.trim().replace(/^r\$\s*/i, '').replace(/\s/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}
