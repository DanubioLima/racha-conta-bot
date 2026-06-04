// Categorias armazenadas em INGLÊS (decisão de spec); o usuário vê rótulos em
// português via voice.ts. O Gemini extrai a categoria restrita a este enum no
// structured output; coerceCategory é a segunda linha de defesa.
export const EXPENSE_CATEGORIES = [
  'groceries',
  'food',
  'transport',
  'home',
  'leisure',
  'health',
  'bills',
  'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface Expense {
  id: string; // ULID gerado na aplicação (mesmo gerador das bills)
  owner_phone: string; // E.164 sem +, normalizado (ver lib/phone.ts)
  amount: number;
  description: string;
  category: ExpenseCategory;
  spent_at: string; // ISO UTC; fronteiras de consulta são convertidas pra BRT
}

// Shape cru vindo da extração do Gemini — category ainda não validada.
export interface ExtractedExpense {
  amount: number;
  description: string;
  category: string;
}

export type ExpensePeriod = 'today' | 'week' | 'month';

// O LLM pode devolver período fora do enum; quem consome coage (coercePeriod).
export interface ExpenseQueryInput {
  period?: string;
}

export function coerceCategory(raw: string | undefined): ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(raw ?? '')
    ? (raw as ExpenseCategory)
    : 'other';
}
