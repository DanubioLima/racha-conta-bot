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

  // O cumbuca source é criado na Task 6. Até lá, só fallback pra mock.
  // Este branch só executa quando há tokens persistidos — o que só acontece
  // após Task 8 (cumbuca:link). Portanto está logicamente inacessível enquanto
  // a Task 6 não estiver concluída.
  throw new Error(
    'cumbuca ledger source not yet wired — finish Task 6 to enable',
  );
}
