import { phoneFromJid } from './phone.js';

/** Pode ser admin via ADMIN_NUMBERS no deploy. Nunca o chip pareado. */
export const FORBIDDEN_BOT_CHIP = '5511976882096';

export function isForbiddenBotChip(value: string | undefined | null): boolean {
  if (!value) return false;
  const digits = value.includes('@') ? phoneFromJid(value) : value.replace(/\D/g, '');
  return digits === FORBIDDEN_BOT_CHIP;
}

export function assertPairingChipAllowed(pairingNumber: string | undefined): void {
  if (!isForbiddenBotChip(pairingNumber)) return;
  throw new Error(
    'Recusei iniciar: 5511976882096 não pode ser o chip do bot. Esse número pode estar em ADMIN_NUMBERS, nunca em PAIRING_NUMBER nem na sessão pareada.',
  );
}
