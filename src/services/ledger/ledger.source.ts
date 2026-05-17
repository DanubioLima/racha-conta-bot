import type { IncomingTransaction } from '../bills/bill.types.js';

// Contrato comum entre o source real (Cumbuca) e o mock. O scanner depende
// dessa interface, não dos módulos concretos.

export interface LedgerSource {
  // Retorna créditos PIX recebidos a partir de `sinceISO` (inclusivo).
  // O caller é responsável por filtrar duplicatas (dedup é externo).
  listRecentCredits(options: { sinceISO: string }): Promise<IncomingTransaction[]>;

  // Nome do source pra logs (ex: "cumbuca", "mock"). Não tem efeito funcional.
  readonly name: string;
}
