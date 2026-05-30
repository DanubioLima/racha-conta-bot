import { ulid } from "ulid";
import { billRepository } from "../../repositories/bill.repository.js";
import { buildPixPayload } from "../pix/pix.js";
import { sendText } from "../whatsapp/whatsapp.js";
import { notifyNewBillCreated } from "../../workers/payment-scanner.worker.js";
import {
  formatBRL,
  billCreatedHeadline,
  paymentReceived,
  billClosed,
} from "../messaging/voice.js";
import type { User } from "../../repositories/user.repository.js";
import type {
  Bill,
  ExtractedBill,
  IncomingTransaction,
  MarkPaidInput,
  Participant,
} from "./bill.types.js";

function buildParticipants(extracted: ExtractedBill, billId: string, owner: User): Participant[] {
  return extracted.participants.map((p, i) => ({
    name: p.name,
    amount_due: Number(p.amount_due.toFixed(2)),
    status: "PENDING" as const,
    pix_payload: buildPixPayload({
      amount: p.amount_due,
      txid: `${billId.slice(-10)}${i}`,
      message: `Racha: ${extracted.description}`.slice(0, 60),
      key: owner.pix_key,
      merchantName: owner.pix_merchant_name,
      merchantCity: owner.pix_merchant_city,
    }),
  }));
}

async function sendBillCreatedMessages(bill: Bill): Promise<void> {
  await sendText(
    bill.owner_phone,
    billCreatedHeadline({
      total: bill.total_amount,
      description: bill.description,
      amountPerPerson: bill.amount_per_person,
      participantNames: bill.participants.map((p) => p.name),
    }),
  );
  for (const participant of bill.participants) {
    await sendText(bill.owner_phone, participant.pix_payload);
  }
}

function renderPaidMessage(bill: Bill, paid: Participant): string {
  const remaining = bill.participants.filter((p) => p.status === "PENDING");
  if (remaining.length === 0) return "";
  return paymentReceived({
    paidName: paid.name,
    paidAmount: paid.amount_due,
    remainingNames: remaining.map((p) => p.name),
  });
}

function renderClosedMessage(bill: Bill): string {
  return billClosed(bill.description);
}

function pendingListText(prefix: string, openBills: Bill[]): string {
  const pend = openBills.flatMap((b) =>
    b.participants.filter((p) => p.status === "PENDING").map((p) => `${p.name} (${formatBRL(p.amount_due)})`),
  );
  if (pend.length === 0) return "Você não tem nenhuma conta em aberto.";
  return `${prefix}${pend.join(", ")}.`;
}

export async function createBillFromExtraction(extracted: ExtractedBill, owner: User): Promise<Bill> {
  console.log("[bill] createBill from extraction", { owner: owner.phone, extracted });
  const id = ulid();
  const divisor = Math.max(extracted.headcount, extracted.participants.length, 1);
  const amountPerPerson = Number((extracted.total_amount / divisor).toFixed(2));

  const bill: Bill = {
    id,
    owner_phone: owner.phone,
    description: extracted.description,
    total_amount: Number(extracted.total_amount.toFixed(2)),
    amount_per_person: amountPerPerson,
    status: "OPEN",
    created_at: new Date().toISOString(),
    participants: buildParticipants(extracted, id, owner),
  };

  await billRepository.insert(bill);
  console.log("[bill] inserted", { id: bill.id, owner: bill.owner_phone });
  try {
    await sendBillCreatedMessages(bill);
  } catch (sendError) {
    console.error("[bill] sendBillCreatedMessages failed", sendError);
  }
  notifyNewBillCreated();
  return bill;
}

// ---- mark_paid (manual) ----

interface PaidCandidate {
  billId: string;
  participantName: string;
  amountDue: number;
}

function collectCandidates(openBills: Bill[], input: MarkPaidInput): PaidCandidate[] {
  const out: PaidCandidate[] = [];
  const wantName = input.name?.trim().toLowerCase();
  for (const bill of openBills) {
    for (const p of bill.participants) {
      if (p.status !== "PENDING") continue;
      const nameOk = wantName
        ? p.name.toLowerCase().includes(wantName) || wantName.includes(p.name.toLowerCase())
        : true;
      const amountOk = input.amount != null ? Math.abs(p.amount_due - input.amount) < 0.005 : true;
      if (nameOk && amountOk) {
        out.push({ billId: bill.id, participantName: p.name, amountDue: p.amount_due });
      }
    }
  }
  return out;
}

export async function markPaid(ownerPhone: string, input: MarkPaidInput): Promise<void> {
  const openBills = await billRepository.findOpenForOwner(ownerPhone);

  if (!input.name?.trim() && input.amount == null) {
    await sendText(ownerPhone, pendingListText("Quem pagou? Em aberto: ", openBills));
    return;
  }

  const candidates = collectCandidates(openBills, input);
  if (candidates.length === 0) {
    await sendText(ownerPhone, `Não achei ninguém pendente com esse nome/valor. ${pendingListText("Em aberto: ", openBills)}`);
    return;
  }
  if (candidates.length > 1) {
    const list = candidates.map((c) => `${c.participantName} (${formatBRL(c.amountDue)})`).join(", ");
    await sendText(ownerPhone, `Quem pagou? Tenho em aberto: ${list}.`);
    return;
  }

  const match = candidates[0]!;
  const updated = await billRepository.update(match.billId, (b) => {
    const p = b.participants.find((x) => x.name === match.participantName);
    if (!p || p.status === "PAID") return;
    p.status = "PAID";
    p.paid_at = new Date().toISOString();
    if (b.participants.every((x) => x.status === "PAID")) b.status = "CLOSED";
  });
  if (!updated) return;

  if (updated.status === "CLOSED") {
    await sendText(ownerPhone, renderClosedMessage(updated));
    return;
  }
  const paid = updated.participants.find((x) => x.name === match.participantName);
  if (paid) {
    const msg = renderPaidMessage(updated, paid);
    if (msg) await sendText(ownerPhone, msg);
  }
}

// ---- reconcile (Cumbuca, owner-scoped) ----

interface MatchResult {
  billId: string;
  participantName: string;
}

async function findMatch(tx: IncomingTransaction, ownerPhone: string): Promise<MatchResult | null> {
  const openBills = await billRepository.findOpenForOwner(ownerPhone);
  for (const bill of openBills) {
    const candidates = bill.participants.filter(
      (p) => p.status === "PENDING" && Math.abs(p.amount_due - tx.amount) < 0.005,
    );
    if (candidates.length === 0) continue;
    const byName = candidates.find((p) => {
      const a = p.name.toLowerCase();
      const b = tx.payer_name.toLowerCase();
      return a.includes(b) || b.includes(a);
    });
    const winner = byName ?? candidates[0]!;
    return { billId: bill.id, participantName: winner.name };
  }
  return null;
}

export async function tryReconcile(tx: IncomingTransaction, ownerPhone: string): Promise<boolean> {
  const match = await findMatch(tx, ownerPhone);
  if (!match) {
    console.log("[bill] tryReconcile no match", { txId: tx.id, amount: tx.amount, payer: tx.payer_name });
    return false;
  }
  console.log("[bill] tryReconcile matched", { txId: tx.id, ...match });

  const updated = await billRepository.update(match.billId, (b) => {
    const p = b.participants.find((x) => x.name === match.participantName);
    if (!p || p.status === "PAID") return;
    p.status = "PAID";
    p.paid_at = new Date().toISOString();
    if (b.participants.every((x) => x.status === "PAID")) b.status = "CLOSED";
  });
  if (!updated) return false;

  const paid = updated.participants.find((x) => x.name === match.participantName);
  if (paid) {
    const msg = renderPaidMessage(updated, paid);
    if (msg) await sendText(updated.owner_phone, msg);
  }
  if (updated.status === "CLOSED") {
    console.log("[bill] bill closed", { id: updated.id });
    await sendText(updated.owner_phone, renderClosedMessage(updated));
  }
  return true;
}
