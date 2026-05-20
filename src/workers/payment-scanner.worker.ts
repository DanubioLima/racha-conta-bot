import { billRepository } from '../repositories/bill.repository.js';
import { processedTransactionsRepository } from '../repositories/processed-transactions.repository.js';
import { tryReconcile } from '../services/bills/bill.service.js';
import { createLedgerSource } from '../services/ledger/factory.js';
import { notifyUser } from '../services/whatsapp/whatsapp.js';
import type { Bill } from '../services/bills/bill.types.js';
import type { LedgerSource } from '../services/ledger/ledger.source.js';

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

// Janela mínima de busca pra cobrir lag de propagação Open Finance.
const MIN_LOOKBACK_MS = ONE_HOUR_MS;

let scanTimer: NodeJS.Timeout | null = null;
let ledgerSource: LedgerSource | null = null;

// Re-entrancy guard. `scanInFlight` impede que dois ciclos de scan rodem
// concorrentemente (race no `scanTimer` + risco de duas refresh de token
// simultâneas marchando uma sobre a outra). `rerunRequested` significa que
// alguém pediu um scan imediato enquanto um já estava acontecendo; a próxima
// execução roda imediatamente sem cooldown.
let scanInFlight = false;
let rerunRequested = false;

async function getSource(): Promise<LedgerSource> {
  if (!ledgerSource) ledgerSource = await createLedgerSource();
  return ledgerSource;
}

function oldestCreatedAt(bills: Bill[]): string {
  return bills.reduce((oldest, bill) =>
    new Date(bill.created_at).getTime() < new Date(oldest).getTime() ? bill.created_at : oldest,
    bills[0]!.created_at,
  );
}

function ageMsOfMostRecentBill(bills: Bill[]): number {
  const newest = bills.reduce((mostRecent, bill) =>
    new Date(bill.created_at).getTime() > new Date(mostRecent).getTime() ? bill.created_at : mostRecent,
    bills[0]!.created_at,
  );
  return Date.now() - new Date(newest).getTime();
}

// Tabela de cadência (spec §5): quanto mais nova a bill mais recente, mais agressivo o polling.
export function computeNextScanDelay(openBills: Bill[]): number | null {
  if (openBills.length === 0) return null;
  const age = ageMsOfMostRecentBill(openBills);
  if (age <= ONE_HOUR_MS) return 5 * ONE_MINUTE_MS;
  if (age <= 6 * ONE_HOUR_MS) return 15 * ONE_MINUTE_MS;
  if (age <= ONE_DAY_MS) return ONE_HOUR_MS;
  return 6 * ONE_HOUR_MS;
}

async function expireBillsOlderThanSevenDays(openBills: Bill[]): Promise<void> {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  for (const bill of openBills) {
    if (new Date(bill.created_at).getTime() >= cutoff) continue;

    const expired = await billRepository.update(bill.id, (b) => {
      if (b.status === 'OPEN') b.status = 'EXPIRED';
    });
    if (!expired) continue;

    const pending = expired.participants.filter((p) => p.status === 'PENDING');
    const pendingNames = pending.map((p) => p.name).join(', ');
    console.log('[scanner] expired bill', { id: expired.id, description: expired.description });
    await notifyUser(
      pending.length > 0
        ? `⏱️ Bill "${expired.description}" expirou após 7 dias. Pendentes: ${pendingNames}.`
        : `⏱️ Bill "${expired.description}" expirou após 7 dias.`,
    );
  }
}

export async function scanForBillPayments(): Promise<void> {
  const openBills = await billRepository.findOpen();
  if (openBills.length === 0) {
    console.log('[scanner] idle — no open bills');
    return;
  }

  await expireBillsOlderThanSevenDays(openBills);

  // Re-leia após expirations — algumas bills podem ter virado EXPIRED.
  const stillOpen = await billRepository.findOpen();
  if (stillOpen.length === 0) {
    console.log('[scanner] all open bills expired this round');
    return;
  }

  const earliest = oldestCreatedAt(stillOpen);
  const sinceMs = Math.min(
    new Date(earliest).getTime(),
    Date.now() - MIN_LOOKBACK_MS,
  );
  const sinceISO = new Date(sinceMs).toISOString();

  const source = await getSource();
  console.log('[scanner] scanning', { source: source.name, sinceISO, openBills: stillOpen.length });

  let credits;
  try {
    credits = await source.listRecentCredits({ sinceISO });
  } catch (error) {
    console.error('[scanner] ledger source failed', error);
    return;
  }

  console.log(`[scanner] credits returned: ${credits.length}`);

  for (const transaction of credits) {
    if (await processedTransactionsRepository.wasAlreadyProcessed(transaction.id)) continue;
    const matched = await tryReconcile(transaction);
    // Só marca como processada quando bate com uma bill. Transações órfãs
    // (PIX recebido sem bill correspondente) ficam disponíveis pra retentativa
    // — se uma bill nova for criada cobrindo essa tx, o próximo scan reconcilia.
    if (matched) {
      await processedTransactionsRepository.markAsProcessed(transaction.id);
    }
  }
}

async function runScanAndReschedule(): Promise<void> {
  if (scanInFlight) {
    // Já tem scan rodando — sinaliza pra ele rodar mais uma vez assim que
    // terminar, em vez de empilhar concorrência. Cobre o caso de várias bills
    // criadas em rajada.
    rerunRequested = true;
    return;
  }
  scanInFlight = true;
  try {
    await scanForBillPayments();
  } catch (error) {
    console.error('[scanner] unexpected scan error', error);
  } finally {
    scanInFlight = false;
    if (rerunRequested) {
      rerunRequested = false;
      void runScanAndReschedule();
    } else {
      await scheduleNextScan();
    }
  }
}

async function scheduleNextScan(): Promise<void> {
  const openBills = await billRepository.findOpen();
  const delay = computeNextScanDelay(openBills);
  if (delay === null) {
    console.log('[scanner] going idle — will wake on next bill');
    scanTimer = null;
    return;
  }
  console.log(`[scanner] next scan in ${Math.round(delay / 1000)}s`);
  scanTimer = setTimeout(() => {
    void runScanAndReschedule();
  }, delay);
}

// Chamada pelo bill.service quando uma bill nova é criada. Cancela o cooldown
// atual e dispara um scan imediato — UX de "sob demanda".
export function notifyNewBillCreated(): void {
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  console.log('[scanner] new bill — triggering immediate scan');
  void runScanAndReschedule();
}

export async function startPaymentScanner(): Promise<void> {
  console.log('[scanner] starting payment scanner');
  // Roda um primeiro scan imediato (cobre bills criadas antes do boot).
  void runScanAndReschedule();
}
