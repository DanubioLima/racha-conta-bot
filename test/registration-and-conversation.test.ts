import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sentMessages } = vi.hoisted(() => ({ sentMessages: [] as { to: string; text: string }[] }));

vi.mock('../src/services/whatsapp/whatsapp.js', () => ({
  sendText: vi.fn(async (to: string, text: string) => { sentMessages.push({ to, text }); }),
  sendImage: vi.fn(),
}));
vi.mock('../src/workers/payment-scanner.worker.js', () => ({ notifyNewBillCreated: vi.fn() }));
vi.mock('../src/services/llm/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llm/gemini.js')>();
  return { ...actual, extractIntent: vi.fn() };
});

import { extractIntent, GeminiUnavailableError } from '../src/services/llm/gemini.js';
import { dispatchIncomingMessage } from '../src/services/dispatch/dispatch-message.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { unknownIntentsRepository } from '../src/repositories/unknown-intents.repository.js';
import {
  welcomeNeedPix, welcomeReady, fallbackReply, instability,
} from '../src/services/messaging/voice.js';
import { resetDb, registerUser } from './setup.js';

const extractIntentMock = vi.mocked(extractIntent);
const PHONE = '558899990000';

beforeEach(() => {
  resetDb();
  sentMessages.length = 0;
  extractIntentMock.mockReset();
});

describe('register_account', () => {
  it('nome só (user novo) → insere sem PIX e pede a chave', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({ intent: 'register_account', profile: { name: 'João' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'sou o João');

    // ASSERT
    const user = await userRepository.findByPhone(PHONE);
    expect(user?.name).toBe('João');
    expect(user?.pix_key).toBe('');
    expect(sentMessages[0]!.text).toBe(welcomeNeedPix('João'));
  });

  it('nome + PIX (user novo) → insere completo e confirma pronto', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({
      intent: 'register_account', profile: { name: 'João', pix_key: 'joao@email.com' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'sou o João, pix joao@email.com');

    // ASSERT
    expect((await userRepository.findByPhone(PHONE))?.pix_key).toBe('joao@email.com');
    expect(sentMessages[0]!.text).toBe(welcomeReady('João'));
  });

  it('profile vazio (user já cadastrado) → fallback, sem silêncio', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana' });
    extractIntentMock.mockResolvedValue({ intent: 'register_account', profile: {} });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quero me registrar');

    // ASSERT
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toBe(fallbackReply({ registered: true }));
  });
});

describe('conversa / guarda-corpos', () => {
  it('unknown com reply válido → envia o reply e NÃO grava em unknown_intents', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({ intent: 'unknown', reply: 'Opa! 👋 Tudo bom?' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'oi');

    // ASSERT
    expect(sentMessages[0]!.text).toBe('Opa! 👋 Tudo bom?');
    expect(await unknownIntentsRepository.list()).toHaveLength(0);
  });

  it('unknown sem reply → fallback e grava em unknown_intents', async () => {
    // ARRANGE (sem user → fallback de não cadastrado)
    extractIntentMock.mockResolvedValue({ intent: 'unknown' });

    // ACT
    await dispatchIncomingMessage(PHONE, '???');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(fallbackReply({ registered: false }));
    expect(await unknownIntentsRepository.list()).toHaveLength(1);
  });

  it('Gemini indisponível → mensagem de instabilidade', async () => {
    // ARRANGE
    extractIntentMock.mockRejectedValue(new GeminiUnavailableError());

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 60 na pizza');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(instability());
  });
});
