import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingTransaction } from '../bills/bill.types.js';
import type { LedgerSource } from './ledger.source.js';

const MOCK_PATH = path.resolve('src/mock/incoming-transactions.json');

interface MockTransaction extends IncomingTransaction {
  consumed?: boolean;
}

async function loadFromDisk(): Promise<MockTransaction[]> {
  try {
    await access(MOCK_PATH);
  } catch {
    return [];
  }
  const raw = await readFile(MOCK_PATH, 'utf8');
  return JSON.parse(raw) as MockTransaction[];
}

async function persistConsumed(updated: MockTransaction[]): Promise<void> {
  await mkdir(path.dirname(MOCK_PATH), { recursive: true });
  await writeFile(MOCK_PATH, JSON.stringify(updated, null, 2), 'utf8');
}

export const mockLedgerSource: LedgerSource = {
  name: 'mock',

  async listRecentCredits({ sinceISO }) {
    const all = await loadFromDisk();
    const cutoff = new Date(sinceISO).getTime();

    // Comportamento legacy do worker antigo: o mock marca cada tx como
    // `consumed: true` depois de reportada uma vez. Mantemos isso pra
    // preservar a UX de demos antigas (rodar mock duas vezes não duplica).
    // Em produção (cumbuca source), dedup é por processed-transaction-ids.
    const fresh = all.filter(
      (transaction) =>
        !transaction.consumed &&
        new Date(transaction.occurred_at).getTime() >= cutoff,
    );

    if (fresh.length > 0) {
      const updated = all.map((transaction) =>
        fresh.find((f) => f.id === transaction.id)
          ? { ...transaction, consumed: true }
          : transaction,
      );
      await persistConsumed(updated);
    }

    return fresh.map(({ consumed: _, ...rest }) => rest);
  },
};
