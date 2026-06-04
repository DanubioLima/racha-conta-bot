import { ulid } from 'ulid';
import { expenseRepository } from '../../repositories/expense.repository.js';
import { sendText } from '../whatsapp/whatsapp.js';
import { expenseLogged, expensesSummary } from '../messaging/voice.js';
import { coerceCategory } from './expense.types.js';
import type { User } from '../../repositories/user.repository.js';
import type { Expense, ExpensePeriod, ExpenseQueryInput, ExtractedExpense } from './expense.types.js';

// São Paulo é UTC-3 FIXO desde 2019 (horário de verão abolido); offset constante
// é mais simples e testável que Intl. O "hoje/semana/mês" do usuário é o
// calendário de São Paulo, não o de Greenwich — lição do bug de timezone da
// Cumbuca (pedir janela em UTC perdia PIX recebido à noite).
const SAO_PAULO_OFFSET_MS = 3 * 60 * 60 * 1000;

export function startOfPeriodInSaoPaulo(period: ExpensePeriod, now: Date): Date {
  // Relógio deslocado: os campos getUTC* abaixo são o wall clock de São Paulo.
  const wallClock = new Date(now.getTime() - SAO_PAULO_OFFSET_MS);
  const year = wallClock.getUTCFullYear();
  const month = wallClock.getUTCMonth();
  let day = wallClock.getUTCDate();
  if (period === 'month') day = 1;
  if (period === 'week') {
    const daysSinceMonday = (wallClock.getUTCDay() + 6) % 7; // semana começa na segunda
    day -= daysSinceMonday; // Date.UTC normaliza dia <= 0 pro mês anterior
  }
  return new Date(Date.UTC(year, month, day) + SAO_PAULO_OFFSET_MS);
}

// Sem período claro, o mês corrente é a leitura mais útil de "quanto gastei?".
function coercePeriod(raw: string | undefined): ExpensePeriod {
  return raw === 'today' || raw === 'week' || raw === 'month' ? raw : 'month';
}

async function totalSince(ownerPhone: string, since: Date): Promise<number> {
  const expenses = await expenseRepository.findSince(ownerPhone, since.toISOString());
  return expenses.reduce((total, expense) => total + expense.amount, 0);
}

export async function logExpense(owner: User, extracted: ExtractedExpense): Promise<string> {
  const expense: Expense = {
    id: ulid(),
    owner_phone: owner.phone,
    amount: Number(extracted.amount.toFixed(2)),
    description: extracted.description,
    category: coerceCategory(extracted.category),
    spent_at: new Date().toISOString(),
  };
  await expenseRepository.insert(expense);
  console.log('[expense] logged', { id: expense.id, category: expense.category, owner: owner.phone });

  const todayTotal = await totalSince(owner.phone, startOfPeriodInSaoPaulo('today', new Date()));
  const message = expenseLogged({ amount: expense.amount, category: expense.category, todayTotal });
  await sendText(owner.phone, message);
  return message;
}

export async function queryExpenses(ownerPhone: string, query: ExpenseQueryInput): Promise<string> {
  const period = coercePeriod(query.period);
  const since = startOfPeriodInSaoPaulo(period, new Date());
  const expenses = await expenseRepository.findSince(ownerPhone, since.toISOString());
  const message = expensesSummary({
    period,
    total: expenses.reduce((total, expense) => total + expense.amount, 0),
    items: expenses.map((expense) => ({
      spentAt: expense.spent_at,
      description: expense.description,
      amount: expense.amount,
    })),
  });
  await sendText(ownerPhone, message);
  return message;
}
