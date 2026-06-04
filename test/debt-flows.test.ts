import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sentMessages } = vi.hoisted(() => ({ sentMessages: [] as { to: string; text: string }[] }));

vi.mock('../src/services/whatsapp/whatsapp.js', () => ({
  sendText: vi.fn(async (to: string, text: string) => { sentMessages.push({ to, text }); }),
}));
// Stub só do extractIntent; mantém o resto real (GeminiUnavailableError etc.).
vi.mock('../src/services/llm/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llm/gemini.js')>();
  return { ...actual, extractIntent: vi.fn() };
});

import { extractIntent } from '../src/services/llm/gemini.js';
import { dispatchIncomingMessage } from '../src/services/dispatch/dispatch-message.js';
import { billRepository } from '../src/repositories/bill.repository.js';
import { askToRegister, askForPix, formatBRL } from '../src/services/messaging/voice.js';
import { resetDb, registerUser, insertOpenBill } from './setup.js';

const extractIntentMock = vi.mocked(extractIntent);
const PHONE = '558899990000';

beforeEach(() => {
  resetDb();
  sentMessages.length = 0;
  extractIntentMock.mockReset();
});

describe('register_debt', () => {
  it('cria bill kind=debt com 1 participante e manda o PIX da cobrança', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    extractIntentMock.mockResolvedValue({
      intent: 'register_debt',
      debt: { debtor_name: 'Roberto', amount: 100 },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'o Roberto me deve 100');

    // ASSERT
    const bills = await billRepository.findOpenForOwner(PHONE);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.kind).toBe('debt');
    expect(bills[0]!.total_amount).toBe(100);
    expect(bills[0]!.participants).toHaveLength(1);
    expect(bills[0]!.participants[0]!.name).toBe('Roberto');
    expect(sentMessages[0]!.text).toContain(`Roberto te deve ${formatBRL(100)}`);
    expect(sentMessages.filter((m) => /br\.gov\.bcb\.pix/i.test(m.text))).toHaveLength(1);
  });

  it('com descrição → contexto aparece na confirmação', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    extractIntentMock.mockResolvedValue({
      intent: 'register_debt',
      debt: { debtor_name: 'Maria', amount: 50, description: 'jantar' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'a Maria ficou me devendo 50 do jantar');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('jantar');
    expect((await billRepository.findOpenForOwner(PHONE))[0]!.description).toBe('jantar');
  });

  it('não cadastrado → pede cadastro, não cria dívida', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({
      intent: 'register_debt',
      debt: { debtor_name: 'Roberto', amount: 100 },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'o Roberto me deve 100');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(askToRegister());
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });

  it('cadastrado sem PIX → pede a chave (cobrança sai no nome do dono)', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: '' });
    extractIntentMock.mockResolvedValue({
      intent: 'register_debt',
      debt: { debtor_name: 'Roberto', amount: 100 },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'o Roberto me deve 100');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(askForPix('Ana'));
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });
});

describe('dívida quitada (mark_paid reusa o modelo)', () => {
  it('"Roberto me pagou" fecha a dívida com mensagem de quitação', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    extractIntentMock.mockResolvedValueOnce({
      intent: 'register_debt',
      debt: { debtor_name: 'Roberto', amount: 100, description: 'jantar' },
    });
    await dispatchIncomingMessage(PHONE, 'o Roberto me deve 100 do jantar');
    sentMessages.length = 0;
    extractIntentMock.mockResolvedValueOnce({ intent: 'mark_paid', payment: { name: 'Roberto' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'o Roberto me pagou');

    // ASSERT
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
    expect(sentMessages[0]!.text).toContain('Roberto quitou');
    expect(sentMessages[0]!.text).not.toContain('Todo mundo pagou');
  });

  it('"me pagaram o jantar" (por nome da conta) quita a dívida inteira', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    extractIntentMock.mockResolvedValueOnce({
      intent: 'register_debt',
      debt: { debtor_name: 'Roberto', amount: 100, description: 'jantar' },
    });
    await dispatchIncomingMessage(PHONE, 'o Roberto me deve 100 do jantar');
    sentMessages.length = 0;
    extractIntentMock.mockResolvedValueOnce({ intent: 'mark_paid', payment: { bill: 'jantar' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'me pagaram o jantar');

    // ASSERT
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
    expect(sentMessages[0]!.text).toContain('Roberto quitou');
  });
});

describe('list_bills agrupado por tipo', () => {
  it('racha + dívida → seções "Suas contas em aberto" e "Te devem"', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 60,
      participants: [{ name: 'Beto', amount_due: 20 }] });
    extractIntentMock.mockResolvedValueOnce({
      intent: 'register_debt',
      debt: { debtor_name: 'Roberto', amount: 100, description: 'jantar' },
    });
    await dispatchIncomingMessage(PHONE, 'o Roberto me deve 100 do jantar');
    sentMessages.length = 0;
    extractIntentMock.mockResolvedValueOnce({ intent: 'list_bills' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quem me deve?');

    // ASSERT
    const text = sentMessages[0]!.text;
    expect(text).toContain('Suas contas em aberto:');
    expect(text).toContain(`Pizza — ${formatBRL(60)}`);
    expect(text).toContain('Te devem:');
    expect(text).toContain(`Roberto — ${formatBRL(100)} (jantar)`);
  });

  it('só dívidas → só a seção "Te devem"', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    extractIntentMock.mockResolvedValueOnce({
      intent: 'register_debt',
      debt: { debtor_name: 'Roberto', amount: 100 },
    });
    await dispatchIncomingMessage(PHONE, 'o Roberto me deve 100');
    sentMessages.length = 0;
    extractIntentMock.mockResolvedValueOnce({ intent: 'list_bills' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quem me deve?');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Te devem:');
    expect(sentMessages[0]!.text).not.toContain('Suas contas em aberto:');
  });

  it('nada em aberto → mensagem de vazio inalterada', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({ intent: 'list_bills' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'minhas contas');

    // ASSERT
    expect(sentMessages[0]!.text).toBe('Você não tem nenhuma conta em aberto 🎉');
  });
});
