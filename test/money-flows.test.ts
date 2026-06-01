import { describe, it, expect, beforeEach, vi } from 'vitest';

// Captura de mensagens enviadas (hoisted pra o factory do vi.mock alcançar).
const { sentMessages } = vi.hoisted(() => ({ sentMessages: [] as { to: string; text: string }[] }));

vi.mock('../src/services/whatsapp/whatsapp.js', () => ({
  sendText: vi.fn(async (to: string, text: string) => { sentMessages.push({ to, text }); }),
}));
// Neutraliza o worker de reconciliação (timers/cumbuca) que createBillFromExtraction aciona.
vi.mock('../src/workers/payment-scanner.worker.js', () => ({ notifyNewBillCreated: vi.fn() }));
// Stub só do extractIntent; mantém o resto real (GeminiUnavailableError etc.).
vi.mock('../src/services/llm/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llm/gemini.js')>();
  return { ...actual, extractIntent: vi.fn() };
});

import { extractIntent } from '../src/services/llm/gemini.js';
import { dispatchIncomingMessage } from '../src/services/dispatch/dispatch-message.js';
import { billRepository } from '../src/repositories/bill.repository.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { askToRegister, askForPix, formatBRL } from '../src/services/messaging/voice.js';
import { resetDb, registerUser, insertOpenBill } from './setup.js';

const extractIntentMock = vi.mocked(extractIntent);
const PHONE = '558899990000';

beforeEach(() => {
  resetDb();
  sentMessages.length = 0;
  extractIntentMock.mockReset();
});

describe('create_bill', () => {
  it('cria conta de 2 pessoas e gera 1 PIX por participante', async () => {
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
    const bills = await billRepository.findOpenForOwner(PHONE);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.participants).toHaveLength(2);
    expect(sentMessages[0]!.text).toContain(`Anotei: ${formatBRL(60)} em Pizza`);
    expect(sentMessages[0]!.text).toContain(`${formatBRL(20)} pra cada`);
    expect(sentMessages[0]!.text).toContain('Te mando o PIX de Beto e Carla');
    expect(sentMessages.filter((m) => /br\.gov\.bcb\.pix/i.test(m.text))).toHaveLength(2);
    expect(sentMessages[0]!.text).not.toMatch(/br\.gov\.bcb\.pix/i);
  });

  it('conta de 1 participante usa singular no headline (sem "(João)")', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Sorvete', total_amount: 10, headcount: 2,
        participants: [{ name: 'João', amount_due: 5 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 10 no sorvete, divide com o João');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Te mando o PIX de João');
    expect(sentMessages[0]!.text).not.toContain('(João)');
  });

  it('descrição vazia não gera " em " no headline', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: '', total_amount: 20, headcount: 2,
        participants: [{ name: 'João', amount_due: 10 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'divide uma conta de 20 com o joão');

    // ASSERT
    expect(sentMessages[0]!.text).not.toContain(' em ');
    expect(sentMessages[0]!.text).toContain(`Anotei: ${formatBRL(20)},`);
  });

  it('não cadastrado → pede cadastro, não cria conta', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Bar', total_amount: 40, headcount: 2,
        participants: [{ name: 'João', amount_due: 20 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 40 no bar, divide com o joão');

    // ASSERT
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toBe(askToRegister());
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });

  it('cadastrado sem PIX → pede a chave PIX', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: '' });
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Bar', total_amount: 40, headcount: 2,
        participants: [{ name: 'João', amount_due: 20 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 40 no bar, divide com o joão');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(askForPix('Ana'));
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });

  it('intent misto (nome embutido, sem PIX) → registra nome e pede PIX', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Sorvete', total_amount: 10, headcount: 2,
        participants: [{ name: 'João', amount_due: 5 }] },
      profile: { name: 'Daiane' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'Sou Daiane e paguei 10 no sorvete, divide com o joão');

    // ASSERT
    expect((await userRepository.findByPhone(PHONE))?.name).toBe('Daiane');
    expect(sentMessages.at(-1)!.text).toBe(askForPix('Daiane'));
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });
});

describe('mark_paid', () => {
  it('paga 1 de 2 pendentes → bill segue aberta', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40,
      participants: [{ name: 'Beto', amount_due: 20 }, { name: 'Carla', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'mark_paid', payment: { name: 'Beto' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'o Beto me pagou');

    // ASSERT
    const bills = await billRepository.findOpenForOwner(PHONE);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.participants.find((p) => p.name === 'Beto')!.status).toBe('PAID');
    expect(sentMessages[0]!.text).toContain(`Beto pagou ${formatBRL(20)}`);
  });

  it('paga o último pendente → fecha a conta', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40,
      participants: [{ name: 'Beto', amount_due: 20, status: 'PAID' }, { name: 'Carla', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'mark_paid', payment: { name: 'Carla' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'a Carla me pagou');

    // ASSERT
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
    expect(sentMessages[0]!.text).toContain('Fechou!');
    expect(sentMessages[0]!.text).toContain('Todo mundo pagou Pizza');
  });

  it('nome ambíguo (casa mais de um) → pergunta quem pagou', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Bar', total: 40,
      participants: [{ name: 'Ana', amount_due: 20 }, { name: 'Ana Paula', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'mark_paid', payment: { name: 'ana' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'a ana me pagou');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Quem pagou?');
  });
});

describe('list_bills', () => {
  it('lista contas abertas no formato compacto', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 60,
      participants: [{ name: 'Beto', amount_due: 20 }, { name: 'Carla', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'list_bills' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'liste contas em aberto');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Suas contas em aberto:');
    expect(sentMessages[0]!.text).toContain(`Pizza — ${formatBRL(60)}`);
    expect(sentMessages[0]!.text).toContain('(faltam 2: Beto, Carla)');
  });

  it('sem contas abertas → mensagem de vazio', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({ intent: 'list_bills' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'minhas contas');

    // ASSERT
    expect(sentMessages[0]!.text).toBe('Você não tem nenhuma conta em aberto 🎉');
  });

  it('não cadastrado → pede cadastro', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({ intent: 'list_bills' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'minhas contas');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(askToRegister());
  });
});
