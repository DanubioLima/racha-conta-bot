import { describe, it, expect, beforeEach, vi } from 'vitest';

// Boundary do SDK Twilio mockado (não dá pra chamar a API real em CI). O que
// importa testar é o nosso contrato: from configurado, to em E.164 (whatsapp:+),
// body verbatim.
const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(async () => ({ sid: 'SM_test' })),
}));
vi.mock('twilio', () => ({
  default: vi.fn(() => ({ messages: { create: createMock } })),
}));

import { sendText } from '../src/services/whatsapp/whatsapp.js';

beforeEach(() => {
  createMock.mockClear();
});

describe('sendText (Twilio)', () => {
  it('chama messages.create com from configurado, to em E.164 e body', async () => {
    await sendText('558899990000', 'oi');
    expect(createMock).toHaveBeenCalledWith({
      from: 'whatsapp:+5588994963067',
      to: 'whatsapp:+558899990000', // wa_id BR sem o nono dígito
      body: 'oi',
    });
  });
});
