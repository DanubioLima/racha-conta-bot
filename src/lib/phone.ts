// Brazilian "nono dígito": carriers/WhatsApp installs vary on whether the
// leading 9 of a mobile number is present. 5588998082034 and 558898082034 are
// the same line. We key users by the normalized (9-dropped) form so the webhook
// sender, the seed, and the scanner all resolve to ONE identity per phone.
export function normalizeBrNumber(num: string): string {
  const digits = num.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("55") && digits[4] === "9") {
    return digits.slice(0, 4) + digits.slice(5);
  }
  return digits;
}
