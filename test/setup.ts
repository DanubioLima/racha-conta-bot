import { db } from '../src/repositories/db.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { billRepository } from '../src/repositories/bill.repository.js';
import type { Bill } from '../src/services/bills/bill.types.js';

// Ordem respeita FK: participants → bills → users.
export function resetDb(): void {
  db.exec(
    'DELETE FROM participants; DELETE FROM bills; DELETE FROM users; ' +
      'DELETE FROM processed_transactions; DELETE FROM unknown_intents; ' +
      'DELETE FROM conversation_turns;',
  );
}

export async function registerUser(
  phone: string,
  opts: { name?: string; pixKey?: string } = {},
): Promise<void> {
  const name = opts.name ?? 'Ana';
  const pixKey = opts.pixKey ?? 'ana@email.com';
  await userRepository.insert({
    phone,
    name,
    pix_key: pixKey,
    pix_merchant_name: pixKey ? name.slice(0, 25) : '',
    pix_merchant_city: 'BRASIL',
    created_at: '2026-05-30T00:00:00Z',
  });
}

// Insere uma bill OPEN direto (sem service/worker). pix_payload é placeholder.
export async function insertOpenBill(
  ownerPhone: string,
  opts: {
    id: string;
    description: string;
    total: number;
    participants: { name: string; amount_due: number; status?: 'PENDING' | 'PAID' }[];
  },
): Promise<void> {
  const bill: Bill = {
    id: opts.id,
    owner_phone: ownerPhone,
    description: opts.description,
    total_amount: opts.total,
    amount_per_person: opts.participants[0]?.amount_due ?? 0,
    status: 'OPEN',
    created_at: '2026-05-30T00:00:00Z',
    participants: opts.participants.map((p) => ({
      name: p.name,
      amount_due: p.amount_due,
      status: p.status ?? 'PENDING',
      pix_payload: `pix-${p.name}`,
    })),
  };
  await billRepository.insert(bill);
}
