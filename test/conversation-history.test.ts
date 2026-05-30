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
import { conversationRepository } from '../src/repositories/conversation.repository.js';
import { billRepository } from '../src/repositories/bill.repository.js';
import { resetDb, registerUser, insertOpenBill } from './setup.js';

const extractIntentMock = vi.mocked(extractIntent);
const PHONE = '558899990000';

beforeEach(() => {
  resetDb();
  sentMessages.length = 0;
  extractIntentMock.mockReset();
});

describe('histórico de conversa', () => {
  it('após criar conta, grava turno user + resumo do bot SEM PIX', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Pizza', total_amount: 60, headcount: 3,
        participants: [{ name: 'Beto', amount_due: 20 }, { name: 'Carla', amount_due: 20 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 60 na pizza, divide com Beto e Carla');

    // ASSERT
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ role: 'user', text: 'paguei 60 na pizza, divide com Beto e Carla' });
    expect(turns[1]!.role).toBe('bot');
    expect(turns[1]!.text).not.toMatch(/br\.gov\.bcb\.pix/i);
  });

  it('após unknown com reply, grava o reply verbatim no turno do bot', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({ intent: 'unknown', reply: 'Opa! 👋 Tudo bom?' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'oi');

    // ASSERT
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns[1]).toEqual({ role: 'bot', text: 'Opa! 👋 Tudo bom?' });
  });

  it('passa o histórico recente pro extractIntent', async () => {
    // ARRANGE — semeia histórico (ex: bot perguntou "quanto foi?")
    await registerUser(PHONE);
    await conversationRepository.append(PHONE, 'user', 'paguei na pizza');
    await conversationRepository.append(PHONE, 'bot', 'quanto foi?');
    extractIntentMock.mockResolvedValue({ intent: 'unknown', reply: 'beleza' });

    // ACT
    await dispatchIncomingMessage(PHONE, '60, com a Ana');

    // ASSERT — 3º argumento do extractIntent traz o histórico semeado
    expect(extractIntentMock).toHaveBeenCalledTimes(1);
    expect(extractIntentMock.mock.calls[0]![2]).toEqual([
      { role: 'user', text: 'paguei na pizza' },
      { role: 'bot', text: 'quanto foi?' },
    ]);
  });

  it('mark_paid ambíguo grava a pergunta real no histórico (não um resumo)', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Bar', total: 40,
      participants: [{ name: 'Ana', amount_due: 20 }, { name: 'Ana Paula', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'mark_paid', payment: { name: 'ana' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'a ana me pagou');

    // ASSERT — o turno do bot é a pergunta de verdade, não um resumo genérico
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns[1]!.role).toBe('bot');
    expect(turns[1]!.text).toContain('Quem pagou?');
    expect(turns[1]!.text).not.toContain('[registrei');
    // guarda-corpo: texto de mark_paid no histórico nunca carrega PIX
    expect(turns[1]!.text).not.toMatch(/br\.gov\.bcb\.pix/i);
  });

  it('instabilidade do Gemini não grava histórico', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockRejectedValue(new GeminiUnavailableError());

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 60 na pizza');

    // ASSERT
    expect(await conversationRepository.recent(PHONE, 8)).toHaveLength(0);
  });

  it('close_bill (confirmado) encerra a conta e grava no histórico', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40,
      participants: [{ name: 'João', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'close_bill', close: { reference: 'pizza', confirmed: true } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'sim, pode fechar a pizza');

    // ASSERT
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns[1]!.text).toContain('Encerrei a conta Pizza');
  });
});
