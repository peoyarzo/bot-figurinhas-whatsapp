import type { SafetyConfig } from '../config.js';

export function warmupDay(birthdayMs: number, now: number): number {
  if (now <= birthdayMs) return 1;
  return Math.floor((now - birthdayMs) / 86_400_000) + 1;
}

export function dailyLimitFor(birthdayMs: number, now: number, safety: SafetyConfig): number {
  const day = warmupDay(birthdayMs, now);
  const exact = safety.warmup.find((step) => step.day === day);
  if (exact) return exact.dailyLimit;
  const maxDefined = safety.warmup.reduce((max, step) => Math.max(max, step.day), 0);
  if (day <= maxDefined) {
    const past = safety.warmup.filter((step) => step.day <= day).sort((a, b) => b.day - a.day);
    if (past[0]) return past[0].dailyLimit;
    const first = [...safety.warmup].sort((a, b) => a.day - b.day)[0];
    if (first) return first.dailyLimit;
  }
  return safety.dailyLimitAfterWarmup;
}
