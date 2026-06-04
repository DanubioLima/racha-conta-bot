import { db } from './db.js';
import type { Expense } from '../services/expenses/expense.types.js';

const insertExpense = db.prepare(
  `INSERT INTO expenses (id, owner_phone, amount, description, category, spent_at)
   VALUES (@id, @owner_phone, @amount, @description, @category, @spent_at)`,
);

// spent_at é ISO UTC de largura fixa: comparação lexicográfica == temporal.
const selectSince = db.prepare<[string, string], Expense>(
  'SELECT * FROM expenses WHERE owner_phone = ? AND spent_at >= ? ORDER BY spent_at, id',
);

export const expenseRepository = {
  async insert(expense: Expense): Promise<void> {
    insertExpense.run(expense);
  },

  async findSince(ownerPhone: string, sinceISO: string): Promise<Expense[]> {
    return selectSince.all(ownerPhone, sinceISO);
  },
};
