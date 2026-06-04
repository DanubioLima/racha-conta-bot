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
import { expenseRepository } from '../src/repositories/expense.repository.js';
import { billRepository } from '../src/repositories/bill.repository.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { startOfPeriodInSaoPaulo } from '../src/services/expenses/expense.service.js';
import { askForNameToTrack, formatBRL } from '../src/services/messaging/voice.js';
import { resetDb, registerUser } from './setup.js';

const extractIntentMock = vi.mocked(extractIntent);
const PHONE = '558899990000';

const EPOCH = '1970-01-01T00:00:00.000Z';

async function allExpenses(phone: string) {
  return expenseRepository.findSince(phone, EPOCH);
}

beforeEach(() => {
  resetDb();
  sentMessages.length = 0;
  extractIntentMock.mockReset();
});

// Fronteiras de período são wall-clock de São Paulo (UTC-3 fixo), não UTC.
// 2026-06-01 é uma segunda-feira.
describe('startOfPeriodInSaoPaulo', () => {
  it('today: 01:00Z ainda é o dia ANTERIOR em BRT (22:00)', () => {
    const start = startOfPeriodInSaoPaulo('today', new Date('2026-06-04T01:00:00Z'));
    expect(start.toISOString()).toBe('2026-06-03T03:00:00.000Z');
  });

  it('today: meio-dia BRT cai no próprio dia', () => {
    const start = startOfPeriodInSaoPaulo('today', new Date('2026-06-04T15:00:00Z'));
    expect(start.toISOString()).toBe('2026-06-04T03:00:00.000Z');
  });

  it('week: quinta-feira volta pra segunda da mesma semana', () => {
    const start = startOfPeriodInSaoPaulo('week', new Date('2026-06-04T15:00:00Z'));
    expect(start.toISOString()).toBe('2026-06-01T03:00:00.000Z');
  });

  it('week: domingo em BRT volta pra segunda ANTERIOR (semana começa na segunda)', () => {
    // 2026-06-01T01:00Z = domingo 2026-05-31 22:00 em BRT
    const start = startOfPeriodInSaoPaulo('week', new Date('2026-06-01T01:00:00Z'));
    expect(start.toISOString()).toBe('2026-05-25T03:00:00.000Z');
  });

  it('month: volta pro dia 1 do mês corrente em BRT', () => {
    const start = startOfPeriodInSaoPaulo('month', new Date('2026-06-04T01:00:00Z'));
    expect(start.toISOString()).toBe('2026-06-01T03:00:00.000Z');
  });

  it('month: virada de mês em UTC mas não em BRT fica no mês anterior', () => {
    // 2026-06-01T01:00Z = 2026-05-31 22:00 em BRT → mês corrente BRT é MAIO
    const start = startOfPeriodInSaoPaulo('month', new Date('2026-06-01T01:00:00Z'));
    expect(start.toISOString()).toBe('2026-05-01T03:00:00.000Z');
  });
});

describe('log_expense', () => {
  it('registrado → grava o gasto com categoria e confirma com o total do dia', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    extractIntentMock.mockResolvedValue({
      intent: 'log_expense',
      expense: { amount: 25, description: 'mercado', category: 'groceries' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'gastei 25 no mercado');

    // ASSERT
    const expenses = await allExpenses(PHONE);
    expect(expenses).toHaveLength(1);
    expect(expenses[0]!.amount).toBe(25);
    expect(expenses[0]!.category).toBe('groceries');
    expect(expenses[0]!.description).toBe('mercado');
    expect(expenses[0]!.id).toBeTruthy();
    expect(sentMessages[0]!.text).toBe(
      `Anotado: ${formatBRL(25)} — mercado. Hoje já foram ${formatBRL(25)}.`,
    );
  });

  it('segundo gasto no dia acumula no total da confirmação', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValueOnce({
      intent: 'log_expense',
      expense: { amount: 25, description: 'mercado', category: 'groceries' },
    });
    extractIntentMock.mockResolvedValueOnce({
      intent: 'log_expense',
      expense: { amount: 15, description: 'lanche', category: 'food' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'gastei 25 no mercado');
    await dispatchIncomingMessage(PHONE, 'lanche de 15');

    // ASSERT
    expect(sentMessages[1]!.text).toBe(
      `Anotado: ${formatBRL(15)} — comida. Hoje já foram ${formatBRL(40)}.`,
    );
  });

  it('categoria fora do enum é coagida pra other (label "outros")', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({
      intent: 'log_expense',
      expense: { amount: 10, description: 'coisa', category: 'banana' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'gastei 10 numa coisa');

    // ASSERT
    expect((await allExpenses(PHONE))[0]!.category).toBe('other');
    expect(sentMessages[0]!.text).toContain('— outros.');
  });

  it('não cadastrado → pede só o NOME, não grava', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({
      intent: 'log_expense',
      expense: { amount: 25, description: 'mercado', category: 'groceries' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'gastei 25 no mercado');

    // ASSERT
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toBe(askForNameToTrack());
    expect(await allExpenses(PHONE)).toHaveLength(0);
  });

  it('intent misto (nome embutido) → registra e anota na mesma mensagem', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({
      intent: 'log_expense',
      expense: { amount: 25, description: 'mercado', category: 'groceries' },
      profile: { name: 'João' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'Sou João, gastei 25 no mercado');

    // ASSERT
    expect((await userRepository.findByPhone(PHONE))?.name).toBe('João');
    expect(await allExpenses(PHONE)).toHaveLength(1);
    expect(sentMessages.at(-1)!.text).toContain('Anotado:');
  });

  it('cadastrado SEM chave PIX anota normalmente (gasto não exige PIX)', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: '' });
    extractIntentMock.mockResolvedValue({
      intent: 'log_expense',
      expense: { amount: 25, description: 'mercado', category: 'groceries' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'gastei 25 no mercado');

    // ASSERT
    expect(await allExpenses(PHONE)).toHaveLength(1);
    expect(sentMessages[0]!.text).toContain('Anotado:');
  });
});

describe('query_expenses', () => {
  // Fixtures ancoradas na própria fronteira: 1s pra dentro/fora do início do
  // período — determinístico em qualquer dia em que a suite rode. A correção da
  // fronteira em si é pinada pelos testes unitários de startOfPeriodInSaoPaulo.
  async function insertAround(period: 'today' | 'week' | 'month', insideDesc: string, outsideDesc: string) {
    const boundary = startOfPeriodInSaoPaulo(period, new Date());
    await expenseRepository.insert({
      id: `in-${period}`, owner_phone: PHONE, amount: 30, description: insideDesc,
      category: 'food', spent_at: new Date(boundary.getTime() + 1000).toISOString(),
    });
    await expenseRepository.insert({
      id: `out-${period}`, owner_phone: PHONE, amount: 99, description: outsideDesc,
      category: 'other', spent_at: new Date(boundary.getTime() - 1000).toISOString(),
    });
  }

  it('today: soma e lista só o que é de hoje (fronteira BRT)', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertAround('today', 'almoço', 'jantar de ontem');
    extractIntentMock.mockResolvedValue({ intent: 'query_expenses', query: { period: 'today' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quanto gastei hoje?');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Gastos de hoje');
    expect(sentMessages[0]!.text).toContain(formatBRL(30));
    expect(sentMessages[0]!.text).toContain('almoço');
    expect(sentMessages[0]!.text).not.toContain('jantar de ontem');
  });

  it('week: exclui gasto anterior à segunda-feira', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertAround('week', 'feira', 'domingo passado');
    extractIntentMock.mockResolvedValue({ intent: 'query_expenses', query: { period: 'week' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quanto gastei essa semana?');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Gastos da semana');
    expect(sentMessages[0]!.text).toContain('feira');
    expect(sentMessages[0]!.text).not.toContain('domingo passado');
  });

  it('month: exclui gasto do mês anterior', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertAround('month', 'aluguel', 'mês passado');
    extractIntentMock.mockResolvedValue({ intent: 'query_expenses', query: { period: 'month' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quanto gastei esse mês?');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Gastos do mês');
    expect(sentMessages[0]!.text).toContain('aluguel');
    expect(sentMessages[0]!.text).not.toContain('mês passado');
  });

  it('período inválido do LLM cai no mês (mais abrangente)', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({ intent: 'query_expenses', query: { period: 'banana' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quanto gastei?');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Nenhum gasto anotado neste mês');
  });

  it('sem gastos no período → mensagem de vazio', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({ intent: 'query_expenses', query: { period: 'today' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quanto gastei hoje?');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Nenhum gasto anotado hoje');
  });

  it('não cadastrado → pede o nome', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({ intent: 'query_expenses', query: { period: 'month' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quanto gastei?');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(askForNameToTrack());
  });
});

describe('create_bill sem participantes vira gasto (fecha o bug da conta vazia)', () => {
  it('grava expense em vez de bill e não manda PIX', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'pizzaria', total_amount: 60, headcount: 1, participants: [] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 60 na pizzaria');

    // ASSERT
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
    const expenses = await allExpenses(PHONE);
    expect(expenses).toHaveLength(1);
    expect(expenses[0]!.amount).toBe(60);
    expect(expenses[0]!.category).toBe('other');
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toContain('Anotado:');
    expect(sentMessages[0]!.text).not.toMatch(/br\.gov\.bcb\.pix/i);
  });
});
