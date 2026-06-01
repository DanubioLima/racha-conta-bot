import { describe, it, expect } from 'vitest';
import { normalizeBrNumber, toBrazilWhatsAppAddress } from '../src/lib/phone.js';

describe('toBrazilWhatsAppAddress', () => {
  it('responde ao wa_id SEM o nono dígito (forma BR roteável)', () => {
    // WhatsApp BR roteia pelo wa_id sem o 9 — mandar pro +9 cai em número que
    // "não existe"/não entrou no Sandbox (erro 63015).
    expect(toBrazilWhatsAppAddress('558898082034')).toBe('whatsapp:+558898082034');
  });

  it('dropa o 9 antes de montar o endereço, se vier o E.164 completo (com 9)', () => {
    expect(toBrazilWhatsAppAddress('5588998082034')).toBe('whatsapp:+558898082034');
  });

  it('usa a MESMA forma da identidade interna (normalizeBrNumber)', () => {
    const e164ComNove = '5588998082034';
    const identidade = normalizeBrNumber(e164ComNove); // 558898082034
    expect(toBrazilWhatsAppAddress(identidade)).toBe(`whatsapp:+${identidade}`);
  });
});
