import { readTokens } from '../cumbuca/cumbuca.tokens.js';
import { listAccountTransactions } from '../cumbuca/cumbuca.client.js';
import { isReceivedPix, toIncomingTransaction } from '../cumbuca/cumbuca.mapper.js';
import type { LedgerSource } from './ledger.source.js';

// Gera YYYY-MM-DD em fuso de Brasília. Cumbuca/Open Finance Brasil opera
// nesse fuso: pedir "2026-05-20" lá significa um dia BRT (entre 03:00 UTC
// daquele dia e 02:59:59 UTC do dia seguinte). Se a gente passar a data em
// UTC, transações feitas entre 21:00 BRT e 23:59 BRT (que em UTC já estão
// no dia seguinte) ficam fora da janela. Bug observado: PIX recebido em
// 19/maio 23:20 BRT → 20/maio 02:20 UTC; scanner pedia fromDate=toDate=
// 2026-05-20 e Cumbuca devolvia vazio porque a transação estava em "19/05 BRT".
const brasiliaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toYYYYMMDD(isoOrDate: string | Date): string {
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  return brasiliaDateFormatter.format(date);
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
