const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function zonedDayKey(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const bag: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  const hour = Number(bag.hour) % 24;
  const asUtc = Date.UTC(Number(bag.year), Number(bag.month) - 1, Number(bag.day), hour, Number(bag.minute), Number(bag.second));
  return asUtc - utcMs;
}

export function zonedMidnight(dateKey: string, timeZone: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = zoneOffsetMs(utcGuess, timeZone);
  let midnight = utcGuess - offset;
  const offsetAtMidnight = zoneOffsetMs(midnight, timeZone);
  if (offsetAtMidnight !== offset) midnight = utcGuess - offsetAtMidnight;
  return midnight;
}

export function zonedStartOfDay(nowMs: number, timeZone: string): number {
  return zonedMidnight(zonedDayKey(nowMs, timeZone), timeZone);
}

export function zonedStartOfMonth(nowMs: number, timeZone: string): number {
  const key = zonedDayKey(nowMs, timeZone);
  return zonedMidnight(`${key.slice(0, 8)}01`, timeZone);
}

export function zonedStartOfWeek(nowMs: number, timeZone: string): number {
  const dayStart = zonedStartOfDay(nowMs, timeZone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(nowMs));
  return dayStart - (WEEKDAY[weekday] ?? 0) * 86_400_000;
}

export function formatDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(ms));
}
