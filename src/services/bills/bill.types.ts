import type { ExtractedExpense, ExpenseQueryInput } from '../expenses/expense.types.js';

export type BillStatus = 'OPEN' | 'CLOSED' | 'EXPIRED';
// 'split' = conta rachada entre pessoas; 'debt' = fiado (alguém deve ao dono,
// sem evento de divisão). Dívida reusa o modelo de bill com 1 participante.
export type BillKind = 'split' | 'debt';
export type ParticipantStatus = 'PENDING' | 'PAID';

export interface Participant {
  name: string;
  amount_due: number;
  status: ParticipantStatus;
  pix_payload: string;
  paid_at?: string;
}

export interface Bill {
  id: string;
  owner_phone: string;
  kind: BillKind;
  description: string;
  total_amount: number;
  amount_per_person: number;
  status: BillStatus;
  created_at: string;
  participants: Participant[];
}

export interface ExtractedBill {
  description: string;
  total_amount: number;
  // Total people sharing the bill — INCLUDING the user, if they belong in the
  // split. Used to compute amount_per_person.
  headcount: number;
  // Only the OTHER people who need to send PIX. Never includes the user.
  participants: { name: string; amount_due: number }[];
}

export interface ExtractedDebt {
  debtor_name: string;
  amount: number;
  description?: string; // motivo/contexto ("jantar"); ausente quando não dito
}

export interface RegisterProfile {
  name?: string;
  pix_key?: string;
}

export interface MarkPaidInput {
  name?: string;
  amount?: number;
  // Nome/descrição da CONTA dada como paga ("me pagaram a conta da Netflix") —
  // diferente de `name`, que é a pessoa.
  bill?: string;
}

export interface CloseInput {
  all?: boolean;
  reference?: string; // descrição/menção da conta ("ela", "a pizza")
  // true só quando o usuário confirma um "fecho assim mesmo?" anterior (via histórico).
  confirmed?: boolean;
}

export type ExtractionResult =
  | { intent: 'create_bill'; bill: ExtractedBill; profile?: RegisterProfile }
  | { intent: 'register_account'; profile: RegisterProfile }
  | { intent: 'mark_paid'; payment: MarkPaidInput }
  | { intent: 'list_bills' }
  | { intent: 'close_bill'; close: CloseInput }
  | { intent: 'register_debt'; debt: ExtractedDebt; profile?: RegisterProfile }
  | { intent: 'log_expense'; expense: ExtractedExpense; profile?: RegisterProfile }
  | { intent: 'query_expenses'; query: ExpenseQueryInput }
  | { intent: 'unknown'; reply?: string };
