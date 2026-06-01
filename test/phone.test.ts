import { describe, it, expect } from 'vitest';
import { normalizeBrNumber, toBrazilWhatsAppAddress } from '../src/lib/phone.js';

describe('toBrazilWhatsAppAddress', () => {
  it('re-insere o nono dígito e prefixa whatsapp:+ na forma normalizada (12 dígitos)', () => {
    // 558894963067 = forma interna (9 dropado). Twilio quer o E.164 completo.
    expect(toBrazilWhatsAppAddress('558894963067')).toBe('whatsapp:+5588994963067');
  });

  it('faz round-trip com normalizeBrNumber (E.164 → normaliza → denormaliza → E.164)', () => {
    const e164 = '5588994963067';
    const normalized = normalizeBrNumber(e164);
    expect(normalized).toBe('558894963067');
    expect(toBrazilWhatsAppAddress(normalized)).toBe(`whatsapp:+${e164}`);
  });

  it('não duplica o 9 quando já recebe o E.164 completo (13 dígitos)', () => {
    expect(toBrazilWhatsAppAddress('5588994963067')).toBe('whatsapp:+5588994963067');
  });
});
