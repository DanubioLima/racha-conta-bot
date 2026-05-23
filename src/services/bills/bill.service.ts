import { ulid } from "ulid";
import { billRepository } from "../../repositories/bill.repository.js";
import { buildPixPayload } from "../pix/pix.js";
import { notifyUser } from "../whatsapp/whatsapp.js";
import { notifyNewBillCreated } from "../../workers/payment-scanner.worker.js";
import type {
  Bill,
  ExtractedBill,
  IncomingTransaction,
  Participant,
} from "./bill.types.js";

function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function buildParticipants(
  extracted: ExtractedBill,
  billId: string,
): Participant[] {
  return extracted.participants.map((p, i) => ({
    name: p.name,
    amount_due: Number(p.amount_due.toFixed(2)),
    status: "PENDING" as const,
    pix_payload: buildPixPayload({
      amount: p.amount_due,
      txid: `${billId.slice(-10)}${i}`,
      message: `Racha: ${extracted.description}`.slice(0, 60),
    }),
  }));
}

async function sendBillCreatedMessages(bill: Bill): Promise<void> {
  // Por participante mandamos uma mensagem de texto isolada contendo só a
  // string Copia-e-Cola — bubble minimática, long-press copia exatamente
  // o BR Code sem cruft. O QR PNG (`buildPixQrPngBase64`) está dormente em
  // `pix.ts` caso a gente queira voltar a enviar imagem no futuro.
  const names = bill.participants.map((p) => p.name).join(" e ");
  await notifyUser(
    `Anotei sua conta de ${formatBRL(bill.total_amount)} em "${bill.description}". ` +
      `Cabe ${formatBRL(bill.amount_per_person)} pra cada um. ` +
      `Mando o PIX de cada um (${names}) a seguir.`,
  );

  for (const participant of bill.participants) {
    await notifyUser(participant.pix_payload);
  }
}

function renderPaidMessage(bill: Bill, paid: Participant): string {
  const remaining = bill.participants.filter((p) => p.status === "PENDING");
  if (remaining.length === 0) {
    return "";
  }
  const names = remaining.map((p) => p.name).join(", ");
  return `${paid.name} acabou de pagar! ${formatBRL(paid.amount_due)} caíram aqui. Ainda falta: ${names}.`;
}

function renderClosedMessage(bill: Bill): string {
  return `Fechou! Todo mundo pagou a conta de "${bill.description}". Saldo zerado 💸`;
}

export async function createBillFromExtraction(
  extracted: ExtractedBill,
): Promise<Bill> {
  console.log("[bill] createBill from extraction", extracted);
  const id = ulid();
  // Divide by headcount (includes the user when they're in the split), not by
  // participants.length (those are only the ones who owe PIX back).
  const divisor = Math.max(
    extracted.headcount,
    extracted.participants.length,
    1,
  );
  const amountPerPerson = Number((extracted.total_amount / divisor).toFixed(2));

  const bill: Bill = {
    id,
    description: extracted.description,
    total_amount: Number(extracted.total_amount.toFixed(2)),
    amount_per_person: amountPerPerson,
    status: "OPEN",
    created_at: new Date().toISOString(),
    participants: buildParticipants(extracted, id),
  };

  await billRepository.insert(bill);
  console.log("[bill] inserted", {
    id: bill.id,
    description: bill.description,
    total: bill.total_amount,
    participants: bill.participants.map((p) => ({
      name: p.name,
      due: p.amount_due,
    })),
  });
  // Falha de envio de WhatsApp não pode bloquear o agendamento do scan. A
  // bill já está persistida; o usuário pode não receber o PIX nesse momento,
  // mas o scanner ainda vai reconciliar pagamentos quando chegarem.
  try {
    await sendBillCreatedMessages(bill);
  } catch (sendError) {
    console.error("[bill] sendBillCreatedMessages failed", sendError);
  }
  notifyNewBillCreated();
  return bill;
}

interface MatchResult {
  billId: string;
  participantName: string;
}

// Returns the bill+participant that matches, or null if no candidate found.
// Match rules:
//   1. Find an OPEN bill with a PENDING participant whose amount_due === tx.amount.
//   2. If multiple participants match by amount, prefer the one whose name matches
//      (case-insensitive substring) tx.payer_name.
//   3. If still multiple, pick the first PENDING in order.
async function findMatch(tx: IncomingTransaction): Promise<MatchResult | null> {
  const openBills = await billRepository.findOpen();
  for (const bill of openBills) {
    const candidates = bill.participants.filter(
      (p) =>
        p.status === "PENDING" && Math.abs(p.amount_due - tx.amount) < 0.005,
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

export async function tryReconcile(tx: IncomingTransaction): Promise<boolean> {
  const match = await findMatch(tx);
  if (!match) {
    console.log("[bill] tryReconcile no match", {
      txId: tx.id,
      amount: tx.amount,
      payer: tx.payer_name,
    });
    return false;
  }
  console.log("[bill] tryReconcile matched", { txId: tx.id, ...match });

  const updated = await billRepository.update(match.billId, (b) => {
    const p = b.participants.find((x) => x.name === match.participantName);
    if (!p || p.status === "PAID") return;
    p.status = "PAID";
    p.paid_at = new Date().toISOString();
    if (b.participants.every((x) => x.status === "PAID")) {
      b.status = "CLOSED";
    }
  });
  if (!updated) return false;

  const paidParticipant = updated.participants.find(
    (x) => x.name === match.participantName,
  );
  if (paidParticipant) {
    const msg = renderPaidMessage(updated, paidParticipant);
    if (msg) await notifyUser(msg);
  }
  if (updated.status === "CLOSED") {
    console.log("[bill] bill closed", { id: updated.id });
    await notifyUser(renderClosedMessage(updated));
  }
  return true;
}

export async function notifyUnknown(): Promise<void> {
  await notifyUser(
    'Não consegui entender essa mensagem como uma conta pra dividir. Pode reformular? Ex: "Paguei 60 na pizzaria, dividir com João e Maria, 20 cada."',
  );
}
