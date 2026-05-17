import Fastify from 'fastify';
import open from 'open';
import { createInterface } from 'node:readline/promises';
import { env } from '../config/env.js';
import {
  startAuthFlow,
  exchangeCodeForTokens,
  listAccounts,
} from '../services/cumbuca/cumbuca.client.js';
import { writeTokens, hasTokens } from '../services/cumbuca/cumbuca.tokens.js';
import {
  registerCumbucaOAuthRoutes,
  registerCallbackListener,
  clearCallbackListener,
} from '../routes/cumbuca.oauth.js';
import type { CumbucaAccount } from '../services/cumbuca/cumbuca.types.js';

const REDIRECT_URI = `http://localhost:${env.port}/oauth/cumbuca/callback`;

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

async function main(): Promise<void> {
  if (await hasTokens()) {
    console.log('[oauth] Já existe data/cumbuca-tokens.json. Apague-o antes de re-parear, se essa for a intenção.');
    process.exit(1);
  }

  console.log('[oauth] Registrando MCP client no Cumbuca (DCR)...');
  const flow = await startAuthFlow(REDIRECT_URI);
  console.log(`[oauth] client_id obtido: ${flow.state.clientId}`);

  const app = Fastify({ logger: false });
  registerCumbucaOAuthRoutes(app);

  const codeReceived: Promise<string> = new Promise((resolve) => {
    registerCallbackListener((code) => resolve(code));
  });

  await app.listen({ port: env.port, host: '127.0.0.1' });
  console.log(`[oauth] Callback escutando em ${REDIRECT_URI}`);

  console.log('\n[oauth] Abra esta URL no browser pra autorizar:');
  console.log(`        ${flow.authorizationUrl}\n`);
  try {
    await open(flow.authorizationUrl);
  } catch {
    console.log('[oauth] (não consegui abrir o browser automaticamente — copie a URL acima)');
  }

  const authorizationCode = await codeReceived;
  clearCallbackListener();
  console.log('[oauth] Code recebido, trocando por access_token...');
  const tokens = await exchangeCodeForTokens(authorizationCode, flow.state);

  // Salva tokens preliminares (sem account_id ainda) pro client conseguir
  // chamar list_accounts logo abaixo.
  await writeTokens({
    client_id: flow.state.clientId,
    client_secret: flow.state.clientSecret,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    account_id: '',
  });

  console.log('[oauth] Listando contas...');
  const { accounts } = await listAccounts();
  if (accounts.length === 0) {
    throw new Error('Cumbuca não retornou contas. Consent está aprovado? Reveja no app do banco.');
  }
  const chosen = await promptAccountChoice(accounts);

  await writeTokens({
    client_id: flow.state.clientId,
    client_secret: flow.state.clientSecret,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    account_id: chosen.accountId,
  });

  console.log(
    `[oauth] ✅ Pareado com ${chosen.brandName} (account_id=${chosen.accountId}). Tokens em data/cumbuca-tokens.json.`,
  );
  console.log('[oauth] Inicie o bot com `npm run dev`.');

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[oauth] Falhou:', err);
  process.exit(1);
});
