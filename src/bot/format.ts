export type StickerFit = 'cover' | 'fill' | 'contain';
export type StickerFormat = 'perguntar' | 'recortar' | 'esticar';

/** A mídia fica esperando a escolha. Depois disso o bot esquece o arquivo. */
export const PENDING_MEDIA_MS = 5 * 60 * 1000;

export function normalizeToken(text: string): string {
  return text.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

export function parseFormatChoice(text: string): Exclude<StickerFit, 'contain'> | null {
  const token = normalizeToken(text);
  if (token === '1' || token === 'recortar') return 'cover';
  if (token === '2' || token === 'esticar') return 'fill';
  return null;
}

export function parseFormatCommand(arg: string | undefined): StickerFormat | null {
  const token = normalizeToken(arg ?? '');
  if (token === 'perguntar') return 'perguntar';
  if (token === 'recortar') return 'recortar';
  if (token === 'esticar') return 'esticar';
  return null;
}

export function fitForFormat(format: Exclude<StickerFormat, 'perguntar'>): Exclude<StickerFit, 'contain'> {
  return format === 'recortar' ? 'cover' : 'fill';
}

export function storedFormat(value: unknown): StickerFormat {
  if (value === 'recortar' || value === 'esticar' || value === 'perguntar') return value;
  return 'perguntar';
}
