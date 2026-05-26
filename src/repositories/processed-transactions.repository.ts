import { db } from './db.js';

// Conjunto persistente de transactionIds já reconciliados pelo scanner.
// Cap em MAX_TRACKED_IDS (FIFO por ordem de inserção) — janela do Cumbuca é
// curta, não há risco de uma transação antiga sair do conjunto e ser
// reprocessada.
const MAX_TRACKED_IDS = 1000;

const exists = db.prepare<[string], { 1: number }>(
  'SELECT 1 FROM processed_transactions WHERE transaction_id = ?',
);
const insertId = db.prepare(
  'INSERT OR IGNORE INTO processed_transactions (transaction_id, processed_at) VALUES (?, ?)',
);
// rowid cresce monotonicamente na inserção, então descartar os menores remove
// os mais antigos.
const trim = db.prepare(
  `DELETE FROM processed_transactions WHERE rowid NOT IN (
     SELECT rowid FROM processed_transactions ORDER BY rowid DESC LIMIT ?
   )`,
);

const markTx = db.transaction((transactionId: string) => {
  insertId.run(transactionId, new Date().toISOString());
  trim.run(MAX_TRACKED_IDS);
});

export const processedTransactionsRepository = {
  async wasAlreadyProcessed(transactionId: string): Promise<boolean> {
    return exists.get(transactionId) !== undefined;
  },

  async markAsProcessed(transactionId: string): Promise<void> {
    markTx(transactionId);
  },
};
