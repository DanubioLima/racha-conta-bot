// Brazilian "nono dígito": carriers/WhatsApp installs vary on whether the
// leading 9 of a mobile number is present. 5588998082034 and 558898082034 are
// the same line. We key users by the normalized (9-dropped) form so the webhook
// sender and the seed resolve to ONE identity per phone.
export function normalizeBrNumber(num: string): string {
  const digits = num.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("55") && digits[4] === "9") {
    return digits.slice(0, 4) + digits.slice(5);
  }
  return digits;
}

// Endereço WhatsApp pra resposta. No Brasil o wa_id roteia SEM o nono dígito
// (+558898082034, não +5588998082034) — é a mesma razão de existir o
// normalizeBrNumber. Respondemos sempre ao wa_id normalizado; reconstruir o 9
// manda pra um endereço que não recebe (no Sandbox dá 63015 "número não entrou";
// em produção, não-entrega silenciosa). BR-only por design.
export function toBrazilWhatsAppAddress(num: string): string {
  return `whatsapp:+${normalizeBrNumber(num)}`;
}
