import { env } from '../../config/env.js';
import { hasTokens } from '../cumbuca/cumbuca.tokens.js';
import type { LedgerSource } from './ledger.source.js';
import { mockLedgerSource } from './mock.source.js';

// Resolve o ledger source baseado em env + estado dos tokens. Quando o user
// configurou LEDGER_SOURCE=cumbuca mas ainda não rodou `cumbuca:link`, cai
// pro mock silenciosamente (com warning) — preserva a UX de "rodar o bot
// imediatamente" sem setup obrigatório.

export async function createLedgerSource(): Promise<LedgerSource> {
  if (env.ledgerSource === 'mock') {
    console.log('[ledger] using mock source (LEDGER_SOURCE=mock)');
    return mockLedgerSource;
  }

  if (!(await hasTokens())) {
    console.warn(
      '[ledger] LEDGER_SOURCE=cumbuca but no tokens found — falling back to mock. Run `npm run cumbuca:link` to connect.',
    );
    return mockLedgerSource;
  }

  // Dynamic import: mantém o SDK MCP fora do bundle quando o user está em
  // LEDGER_SOURCE=mock — evita carregar @modelcontextprotocol/sdk no boot.
  const { cumbucaLedgerSource } = await import('./cumbuca.source.js');
  return cumbucaLedgerSource;
}
