export type BillStatus = 'OPEN' | 'CLOSED' | 'EXPIRED';
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

export interface RegisterProfile {
  name?: string;
  pix_key?: string;
}

export interface MarkPaidInput {
  name?: string;
  amount?: number;
}

export type ExtractionResult =
  | { intent: 'create_bill'; bill: ExtractedBill }
  | { intent: 'register_account'; profile: RegisterProfile }
  | { intent: 'mark_paid'; payment: MarkPaidInput }
  | { intent: 'unknown'; reply?: string };

export interface IncomingTransaction {
  id: string;
  amount: number;
  payer_name: string;
  occurred_at: string;
}
