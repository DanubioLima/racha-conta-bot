import { readTokens } from '../cumbuca/cumbuca.tokens.js';
import { listAccountTransactions } from '../cumbuca/cumbuca.client.js';
import { isReceivedPix, toIncomingTransaction } from '../cumbuca/cumbuca.mapper.js';
import type { LedgerSource } from './ledger.source.js';

function toYYYYMMDD(isoOrDate: string | Date): string {
  // Usa data UTC, não a local. Pode "perder" o início do dia local quando
  // chamado perto da meia-noite, mas o scanner aplica MIN_LOOKBACK_MS (1h)
  // sobre o `sinceISO`, então a janela fica garantida com folga.
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  return date.toISOString().slice(0, 10);
}

export const cumbucaLedgerSource: LedgerSource = {
  name: 'cumbuca',

  async listRecentCredits({ sinceISO }) {
    const tokens = await readTokens();
    const fromDate = toYYYYMMDD(sinceISO);
    const toDate = toYYYYMMDD(new Date());

    const response = await listAccountTransactions({
      accountId: tokens.account_id,
      fromDate,
      toDate,
    });

    return response.transactions
      .filter(isReceivedPix)
      .map(toIncomingTransaction);
  },
};
