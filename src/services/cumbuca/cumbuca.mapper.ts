import type { IncomingTransaction } from '../bills/bill.types.js';
import type { CumbucaTransaction } from './cumbuca.types.js';

// Mapper puro: traduz payloads Open Finance pro tipo doméstico
// IncomingTransaction. Não conhece regras de negócio (reconciliação, dedup).

export function isReceivedPix(transaction: CumbucaTransaction): boolean {
  return transaction.creditDebitType === 'CREDITO'
      && transaction.type === 'PIX';
}

export function extractPayerName(transactionName: string): string {
  // Formato Open Finance: "Transferência Recebida|NOME DO PAGADOR"
  // Quando vier sem pipe (ex: tipos não-PIX que escaparam do filtro), devolve
  // a string inteira após trim — caller decide se aceita.
  const pipeIndex = transactionName.indexOf('|');
  if (pipeIndex === -1) return transactionName.trim();
  return transactionName.slice(pipeIndex + 1).trim();
}

export function toIncomingTransaction(
  transaction: CumbucaTransaction,
): IncomingTransaction {
  return {
    id: transaction.transactionId,
    amount: parseFloat(transaction.transactionAmount.amount),
    payer_name: extractPayerName(transaction.transactionName),
    occurred_at: transaction.transactionDateTime,
  };
}
