import { ulid } from "ulid";
import { billRepository } from "../../repositories/bill.repository.js";
import { buildPixPayload } from "../pix/pix.js";
import { sendText } from "../whatsapp/whatsapp.js";
import {
  formatBRL,
  billCreatedHeadline,
  paymentReceived,
  billClosed,
  debtRegistered,
  debtSettled,
  openOverview,
  noOpenBillsToClose,
  askWhichBill,
  billNotFound,
  billClosedManually,
  billsClosedAll,
  confirmCloseWithPending,
  confirmCloseAllWithPending,
  billPaidWhole,
} from "../messaging/voice.js";
import type { User } from "../../repositories/user.repository.js";
import type {
  Bill,
  CloseInput,
  ExtractedBill,
  ExtractedDebt,
  MarkPaidInput,
  Participant,
} from "./bill.types.js";

// Manda a mensagem e devolve ela (pro histórico). DRY pros caminhos de 1 mensagem.
async function sendAndReturn(ownerPhone: string, message: string): Promise<string> {
  await sendText(ownerPhone, message);
  return message;
}

function describeOpen(bills: Bill[]): string[] {
  return bills.map((b) => b.description || "conta sem nome");
}

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

// Dívida fecha com voz própria: "todo mundo pagou" não faz sentido pra fiado.
function renderClosedMessage(bill: Bill): string {
  if (bill.kind === "debt") {
    return debtSettled({
      debtorName: bill.participants[0]?.name ?? "",
      description: bill.description,
    });
  }
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
    kind: "split",
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
  return bill;
}

// Fiado é uma bill kind='debt' com 1 participante: PIX da cobrança, mark_paid
// e encerramento funcionam pelo mesmo caminho do racha — só a voz muda.
export async function createDebtFromExtraction(extracted: ExtractedDebt, owner: User): Promise<Bill> {
  console.log("[bill] createDebt from extraction", { owner: owner.phone, debtor: extracted.debtor_name });
  const id = ulid();
  const amount = Number(extracted.amount.toFixed(2));
  const description = extracted.description?.trim() ?? "";

  const bill: Bill = {
    id,
    owner_phone: owner.phone,
    kind: "debt",
    description,
    total_amount: amount,
    amount_per_person: amount,
    status: "OPEN",
    created_at: new Date().toISOString(),
    participants: [
      {
        name: extracted.debtor_name,
        amount_due: amount,
        status: "PENDING",
        pix_payload: buildPixPayload({
          amount,
          txid: `${id.slice(-10)}0`,
          message: `Cobrança: ${description || extracted.debtor_name}`.slice(0, 60),
          key: owner.pix_key,
          merchantName: owner.pix_merchant_name,
          merchantCity: owner.pix_merchant_city,
        }),
      },
    ],
  };

  await billRepository.insert(bill);
  console.log("[bill] debt inserted", { id: bill.id, owner: bill.owner_phone });
  try {
    await sendText(owner.phone, debtRegistered({ debtorName: extracted.debtor_name, amount, description }));
    await sendText(owner.phone, bill.participants[0]!.pix_payload);
  } catch (sendError) {
    console.error("[bill] debt messages failed", sendError);
  }
  return bill;
}

export async function listOpenBills(ownerPhone: string): Promise<string> {
  const bills = await billRepository.findOpenForOwner(ownerPhone);
  const splits = bills
    .filter((bill) => bill.kind === "split")
    .map((bill) => ({
      description: bill.description,
      total: bill.total_amount,
      pending: bill.participants.filter((p) => p.status === "PENDING").map((p) => p.name),
    }));
  const debts = bills
    .filter((bill) => bill.kind === "debt")
    .map((bill) => ({
      debtorName: bill.participants[0]?.name ?? "",
      amount: bill.total_amount,
      description: bill.description,
    }));
  const message = openOverview({ splits, debts });
  await sendText(ownerPhone, message);
  return message;
}

// ---- close_bill (encerrar manualmente; não finge pagamento) ----

export async function closeBills(ownerPhone: string, input: CloseInput): Promise<string> {
  const open = await billRepository.findOpenForOwner(ownerPhone);
  if (open.length === 0) return sendAndReturn(ownerPhone, noOpenBillsToClose());

  // Resolve os alvos: todas, ou a(s) que casam a referência, ou a única aberta.
  let targets: Bill[];
  if (input.all) {
    targets = open;
  } else {
    const reference = input.reference?.trim();
    if (!reference) {
      if (open.length > 1) return sendAndReturn(ownerPhone, askWhichBill(describeOpen(open)));
      targets = open;
    } else {
      const matches = open.filter((b) => b.description.toLowerCase().includes(reference.toLowerCase()));
      if (matches.length === 0) return sendAndReturn(ownerPhone, billNotFound(reference, describeOpen(open)));
      if (matches.length > 1) return sendAndReturn(ownerPhone, askWhichBill(describeOpen(matches)));
      targets = matches;
    }
  }

  // Tem pendente e ainda não confirmou? Pede confirmação (encerrar é sticky).
  const withPending = targets.filter((b) => b.participants.some((p) => p.status === "PENDING"));
  if (withPending.length > 0 && !input.confirmed) {
    if (targets.length === 1) {
      const pendingNames = withPending[0]!.participants.filter((p) => p.status === "PENDING").map((p) => p.name);
      return sendAndReturn(ownerPhone, confirmCloseWithPending(withPending[0]!.description, pendingNames));
    }
    return sendAndReturn(ownerPhone, confirmCloseAllWithPending());
  }

  for (const bill of targets) {
    await billRepository.update(bill.id, (b) => {
      b.status = "CLOSED";
    });
  }
  return sendAndReturn(
    ownerPhone,
    targets.length === 1 ? billClosedManually(targets[0]!.description) : billsClosedAll(targets.length),
  );
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

export async function markPaid(ownerPhone: string, input: MarkPaidInput): Promise<string> {
  const openBills = await billRepository.findOpenForOwner(ownerPhone);

  // "me pagaram a conta da Netflix" → a CONTA inteira foi paga: quita todos os
  // pendentes dela (a conta fecha). Diferente de "a Maria me pagou" (pessoa).
  const billRef = input.bill?.trim();
  if (billRef) {
    const matches = openBills.filter((b) => b.description.toLowerCase().includes(billRef.toLowerCase()));
    if (matches.length === 0) return sendAndReturn(ownerPhone, billNotFound(billRef, describeOpen(openBills)));
    if (matches.length > 1) return sendAndReturn(ownerPhone, askWhichBill(describeOpen(matches)));
    const target = matches[0]!;
    await billRepository.update(target.id, (b) => {
      for (const p of b.participants) {
        if (p.status === "PENDING") {
          p.status = "PAID";
          p.paid_at = new Date().toISOString();
        }
      }
      if (b.participants.every((x) => x.status === "PAID")) b.status = "CLOSED";
    });
    if (target.kind === "debt") {
      return sendAndReturn(
        ownerPhone,
        debtSettled({ debtorName: target.participants[0]?.name ?? "", description: target.description }),
      );
    }
    return sendAndReturn(ownerPhone, billPaidWhole(target.description));
  }

  if (!input.name?.trim() && input.amount == null) {
    const message = pendingListText("Quem pagou? Em aberto: ", openBills);
    await sendText(ownerPhone, message);
    return message;
  }

  const candidates = collectCandidates(openBills, input);
  if (candidates.length === 0) {
    const message = `Não achei ninguém pendente com esse nome/valor. ${pendingListText("Em aberto: ", openBills)}`;
    await sendText(ownerPhone, message);
    return message;
  }
  if (candidates.length > 1) {
    const list = candidates.map((c) => `${c.participantName} (${formatBRL(c.amountDue)})`).join(", ");
    const message = `Quem pagou? Tenho em aberto: ${list}.`;
    await sendText(ownerPhone, message);
    return message;
  }

  const match = candidates[0]!;
  const updated = await billRepository.update(match.billId, (b) => {
    const p = b.participants.find((x) => x.name === match.participantName);
    if (!p || p.status === "PAID") return;
    p.status = "PAID";
    p.paid_at = new Date().toISOString();
    if (b.participants.every((x) => x.status === "PAID")) b.status = "CLOSED";
  });
  if (!updated) return "";

  if (updated.status === "CLOSED") {
    const message = renderClosedMessage(updated);
    await sendText(ownerPhone, message);
    return message;
  }
  const paid = updated.participants.find((x) => x.name === match.participantName);
  if (paid) {
    const message = renderPaidMessage(updated, paid);
    if (message) {
      await sendText(ownerPhone, message);
      return message;
    }
  }
  return "";
}
