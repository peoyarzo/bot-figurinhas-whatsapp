export function phoneFromJid(jid: string): string {
  const local = jid.split('@')[0] ?? '';
  const user = local.split(':')[0] ?? '';
  return user.replace(/\D/g, '');
}

export function toJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
}

export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}
