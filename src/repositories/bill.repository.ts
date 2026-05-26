import { db } from './db.js';
import type { Bill, Participant } from '../services/bills/bill.types.js';

interface BillRow {
  id: string;
  owner_phone: string;
  description: string;
  total_amount: number;
  amount_per_person: number;
  status: Bill['status'];
  created_at: string;
}

interface ParticipantRow {
  name: string;
  amount_due: number;
  status: Participant['status'];
  pix_payload: string;
  paid_at: string | null;
}

const selectAllBills = db.prepare<[], BillRow>('SELECT * FROM bills');
const selectBill = db.prepare<[string], BillRow>('SELECT * FROM bills WHERE id = ?');
const selectOpen = db.prepare<[], BillRow>("SELECT * FROM bills WHERE status = 'OPEN'");
const selectOpenForOwner = db.prepare<[string], BillRow>(
  "SELECT * FROM bills WHERE status = 'OPEN' AND owner_phone = ?",
);
const selectParticipants = db.prepare<[string], ParticipantRow>(
  'SELECT name, amount_due, status, pix_payload, paid_at FROM participants WHERE bill_id = ? ORDER BY position',
);

const insertBill = db.prepare(
  `INSERT INTO bills (id, owner_phone, description, total_amount, amount_per_person, status, created_at)
   VALUES (@id, @owner_phone, @description, @total_amount, @amount_per_person, @status, @created_at)`,
);
const updateBill = db.prepare(
  `UPDATE bills SET owner_phone = @owner_phone, description = @description, total_amount = @total_amount,
   amount_per_person = @amount_per_person, status = @status, created_at = @created_at WHERE id = @id`,
);
const deleteParticipants = db.prepare('DELETE FROM participants WHERE bill_id = ?');
const insertParticipant = db.prepare(
  `INSERT INTO participants (bill_id, position, name, amount_due, status, pix_payload, paid_at)
   VALUES (@bill_id, @position, @name, @amount_due, @status, @pix_payload, @paid_at)`,
);

function hydrate(row: BillRow): Bill {
  const participants = selectParticipants.all(row.id).map(
    (p): Participant => ({
      name: p.name,
      amount_due: p.amount_due,
      status: p.status,
      pix_payload: p.pix_payload,
      // paid_at é opcional no tipo; só inclui quando existe pra não emitir
      // "paid_at": null e bater com o shape do JSON antigo.
      ...(p.paid_at !== null ? { paid_at: p.paid_at } : {}),
    }),
  );
  return {
    id: row.id,
    owner_phone: row.owner_phone,
    description: row.description,
    total_amount: row.total_amount,
    amount_per_person: row.amount_per_person,
    status: row.status,
    created_at: row.created_at,
    participants,
  };
}

// Participantes não têm id estável vindo de fora; o caminho mais simples e
// correto é reescrever o conjunto inteiro da bill a cada mutação.
function writeParticipants(billId: string, participants: Participant[]): void {
  deleteParticipants.run(billId);
  participants.forEach((p, position) =>
    insertParticipant.run({
      bill_id: billId,
      position,
      name: p.name,
      amount_due: p.amount_due,
      status: p.status,
      pix_payload: p.pix_payload,
      paid_at: p.paid_at ?? null,
    }),
  );
}

const insertTx = db.transaction((bill: Bill) => {
  insertBill.run({
    id: bill.id,
    owner_phone: bill.owner_phone,
    description: bill.description,
    total_amount: bill.total_amount,
    amount_per_person: bill.amount_per_person,
    status: bill.status,
    created_at: bill.created_at,
  });
  writeParticipants(bill.id, bill.participants);
});

const updateTx = db.transaction((billId: string, mutator: (b: Bill) => void): Bill | null => {
  const row = selectBill.get(billId);
  if (!row) return null;
  const bill = hydrate(row);
  mutator(bill);
  updateBill.run({
    id: bill.id,
    owner_phone: bill.owner_phone,
    description: bill.description,
    total_amount: bill.total_amount,
    amount_per_person: bill.amount_per_person,
    status: bill.status,
    created_at: bill.created_at,
  });
  writeParticipants(bill.id, bill.participants);
  return bill;
});

export const billRepository = {
  async list(): Promise<Bill[]> {
    return selectAllBills.all().map(hydrate);
  },

  async insert(bill: Bill): Promise<void> {
    insertTx(bill);
  },

  async update(billId: string, mutator: (b: Bill) => void): Promise<Bill | null> {
    return updateTx(billId, mutator);
  },

  async findOpen(): Promise<Bill[]> {
    return selectOpen.all().map(hydrate);
  },

  async findOpenForOwner(ownerPhone: string): Promise<Bill[]> {
    return selectOpenForOwner.all(ownerPhone).map(hydrate);
  },
};
