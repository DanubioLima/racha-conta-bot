// Tipos retornados pelo MCP server do Cumbuca (https://mcp.cumbuca.com/mcp).
// Espelha o shape de Open Finance — não é nosso domínio.

export interface CumbucaAccount {
  accountId: string;
  branchCode: string;
  brandName: string;
  checkDigit: string;
  companyCnpj: string;
  compeCode: string;
  number: string;
  type: string;
}

export interface CumbucaListAccountsResponse {
  accounts: CumbucaAccount[];
}

export interface CumbucaTransactionAmount {
  amount: string;   // ex: "1000.0000" — sempre string com 4 casas
  currency: string; // ex: "BRL"
}

export interface CumbucaTransaction {
  transactionId: string;
  transactionDateTime: string;          // ISO8601
  transactionName: string;              // ex: "Transferência Recebida|NOME"
  type: 'PIX' | 'BOLETO' | 'RESGATE_APLIC_FINANCEIRA' | string;
  creditDebitType: 'CREDITO' | 'DEBITO';
  completedAuthorisedPaymentType: string;
  transactionAmount: CumbucaTransactionAmount;
  partieBranchCode?: string;
  partieCheckDigit?: string;
  partieCnpjCpf?: string;
  partieCompeCode?: string;
  partieNumber?: string;
  partiePersonType?: 'PESSOA_NATURAL' | 'PESSOA_JURIDICA';
}

export interface CumbucaListTransactionsResponse {
  transactions: CumbucaTransaction[];
}

export interface CumbucaConsentStatus {
  status: 'active' | 'expired' | 'revoked' | string;
  institution_name: string | null;
  expires_at: string | null;
}
