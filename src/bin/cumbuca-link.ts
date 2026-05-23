import open from 'open';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { env } from '../config/env.js';
import {
  startAuthFlow,
  listAccounts,
} from '../services/cumbuca/cumbuca.client.js';
import {
  writeTokens,
  readTokens,
  hasTokens,
} from '../services/cumbuca/cumbuca.tokens.js';
import { writePendingPairing } from '../services/cumbuca/cumbuca.pending-pairing.js';
import { randomBytes } from 'node:crypto';
import type { CumbucaAccount } from '../services/cumbuca/cumbuca.types.js';

const REDIRECT_URI = `${env.publicBaseUrl}/oauth/cumbuca/callback`;
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

async function promptAccountChoice(accounts: CumbucaAccount[]): Promise<CumbucaAccount> {
  if (accounts.length === 1) {
    return accounts[0]!;
  }
  console.log('\n[oauth] Múltiplas contas disponíveis:');
  accounts.forEach((account, index) => {
    console.log(
      `  [${index + 1}] ${account.brandName} — agência ${account.branchCode} conta ${account.number}`,
    );
  });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await readline.question('\nEscolha o número da conta: ');
  readline.close();
  const choice = parseInt(answer.trim(), 10);
  if (!Number.isInteger(choice) || choice < 1 || choice > accounts.length) {
    throw new Error(`Escolha inválida: ${answer}`);
  }
  return accounts[choice - 1]!;
}

async function pollForTokens(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (await hasTokens()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Pareamento expirou após 10 min sem callback chegar.');
}

async function main(): Promise<void> {
  if (await hasTokens()) {
    console.log('[oauth] Já existe data/cumbuca-tokens.json. Apague-o antes de re-parear, se essa for a intenção.');
    process.exit(1);
  }

  console.log('[oauth] Registrando MCP client no Cumbuca (DCR)...');
  const flow = await startAuthFlow(REDIRECT_URI);
  console.log(`[oauth] client_id obtido: ${flow.state.clientId}`);

  // O state OAuth deve ser único por flow pra ligar callback ao pending file.
  // Cumbuca não devolve state — geramos um nosso e injetamos no authorize URL.
  const oauthState = randomBytes(24).toString('base64url');
  const authorizationUrlWithState = new URL(flow.authorizationUrl);
  authorizationUrlWithState.searchParams.set('state', oauthState);

  await writePendingPairing({
    state: oauthState,
    client_id: flow.state.clientId,
    client_secret: flow.state.clientSecret,
    code_verifier: flow.state.codeVerifier,
    redirect_uri: flow.state.redirectUri,
    created_at: new Date().toISOString(),
  });

  console.log('\n[oauth] Abra esta URL no browser pra autorizar:');
  console.log(`        ${authorizationUrlWithState.toString()}\n`);
  try {
    await open(authorizationUrlWithState.toString());
  } catch {
    console.log('[oauth] (não consegui abrir o browser automaticamente — copie a URL acima)');
  }

  console.log('[oauth] Aguardando callback do Cumbuca...');
  await pollForTokens();
  console.log('[oauth] Tokens recebidos pelo servidor. Listando contas...');

  const { accounts } = await listAccounts();
  if (accounts.length === 0) {
    throw new Error('Cumbuca não retornou contas. Consent está aprovado? Reveja no app do banco.');
  }
  const chosen = await promptAccountChoice(accounts);

  const current = await readTokens();
  await writeTokens({
    ...current,
    account_id: chosen.accountId,
  });

  console.log(
    `[oauth] ✅ Pareado com ${chosen.brandName} (account_id=${chosen.accountId}). Tokens em data/cumbuca-tokens.json.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[oauth] Falhou:', err);
  process.exit(1);
});
