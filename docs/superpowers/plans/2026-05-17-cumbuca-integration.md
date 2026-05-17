# Cumbuca Real Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o mock ledger por uma integração nativa com o MCP server do Cumbuca (`https://mcp.cumbuca.com/mcp`), com OAuth/DCR, polling adaptativo e fallback gracioso pra mock.

**Architecture:** O bot Node vira um MCP client direto via `@modelcontextprotocol/sdk`. Setup OAuth uma vez via `npm run cumbuca:link`. Em runtime, um payment scanner com `setTimeout` recursivo varre `list_account_transactions` quando há bills OPEN, filtra créditos PIX, e dedupa por `processed-transaction-ids.json`.

**Tech Stack:** Node 24, TypeScript, Fastify, `@modelcontextprotocol/sdk`, `open` (pra abrir browser no link flow).

**Convenção de checkpoint:** Esse projeto explicitamente não usa testes automatizados (lab de validação rápida). Cada task termina com `npm run typecheck` (= `tsc --noEmit`) e commit. Smoke test manual ao final do plano.

**Reference spec:** `docs/superpowers/specs/2026-05-17-cumbuca-integration-design.md`. Leia antes de começar.

---

## Task 1: Setup base — deps, env, tipos do Cumbuca

**Files:**
- Modify: `package.json` (add deps + script)
- Modify: `.env.example` (add `LEDGER_SOURCE`)
- Modify: `.env` (add `LEDGER_SOURCE`)
- Modify: `src/config/env.ts`
- Modify: `src/services/bills/bill.types.ts` (add `EXPIRED` status)
- Create: `src/services/cumbuca/cumbuca.types.ts`

- [ ] **Step 1: Instalar dependências**

```bash
npm install @modelcontextprotocol/sdk open
```

- [ ] **Step 2: Adicionar script `cumbuca:link` em `package.json`**

```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "start": "tsx src/server.ts",
  "typecheck": "tsc --noEmit",
  "cumbuca:link": "tsx src/bin/cumbuca-link.ts"
}
```

- [ ] **Step 3: Adicionar `LEDGER_SOURCE` em `.env.example` e `.env`**

```env
# Ledger source: 'cumbuca' (default) usa o MCP do Cumbuca; 'mock' lê src/mock/incoming-transactions.json
LEDGER_SOURCE=cumbuca
```

- [ ] **Step 4: Atualizar `src/config/env.ts`**

```ts
import 'dotenv/config';

const required = [
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'USER_WHATSAPP_NUMBER',
  'GEMINI_API_KEY',
  'PIX_KEY',
  'PIX_MERCHANT_NAME',
  'PIX_MERCHANT_CITY',
] as const;

const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const ledgerSourceRaw = (process.env.LEDGER_SOURCE ?? 'cumbuca').toLowerCase();
if (ledgerSourceRaw !== 'cumbuca' && ledgerSourceRaw !== 'mock') {
  console.error(`Invalid LEDGER_SOURCE "${ledgerSourceRaw}". Expected "cumbuca" or "mock".`);
  process.exit(1);
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  evolutionApiUrl: process.env.EVOLUTION_API_URL!,
  evolutionApiKey: process.env.EVOLUTION_API_KEY!,
  evolutionInstance: process.env.EVOLUTION_INSTANCE!,
  userWhatsappNumber: process.env.USER_WHATSAPP_NUMBER!,
  geminiApiKey: process.env.GEMINI_API_KEY!,
  pixKey: process.env.PIX_KEY!,
  pixMerchantName: process.env.PIX_MERCHANT_NAME!,
  pixMerchantCity: process.env.PIX_MERCHANT_CITY!,
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 30000),
  ledgerSource: ledgerSourceRaw as 'cumbuca' | 'mock',
};
```

- [ ] **Step 5: Adicionar `EXPIRED` em `BillStatus`**

Em `src/services/bills/bill.types.ts`, trocar:

```ts
export type BillStatus = 'OPEN' | 'CLOSED';
```

por:

```ts
export type BillStatus = 'OPEN' | 'CLOSED' | 'EXPIRED';
```

- [ ] **Step 6: Criar `src/services/cumbuca/cumbuca.types.ts`**

```ts
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
```

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .env.example src/config/env.ts src/services/bills/bill.types.ts src/services/cumbuca/cumbuca.types.ts
git commit -m "feat(cumbuca): add deps, env LEDGER_SOURCE, EXPIRED status, MCP payload types

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(`.env` ficou fora porque está gitignored.)

---

## Task 2: Mapper Cumbuca → IncomingTransaction

**Files:**
- Create: `src/services/cumbuca/cumbuca.mapper.ts`

- [ ] **Step 1: Criar o mapper**

```ts
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
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros.

- [ ] **Step 3: Smoke check manual (opcional, REPL)**

```bash
node --input-type=module -e "
import('./src/services/cumbuca/cumbuca.mapper.ts').then(m => {
  console.log(m.extractPayerName('Transferência Recebida|ANA SELIA VIEIRA'));
  // Esperado: 'ANA SELIA VIEIRA'
});
" 2>/dev/null || echo 'ok pular — tsx só roda no runtime do app'
```

(Esse smoke check é opcional; `tsx` precisa do contexto da app pra resolver imports.)

- [ ] **Step 4: Commit**

```bash
git add src/services/cumbuca/cumbuca.mapper.ts
git commit -m "feat(cumbuca): mapper from Cumbuca payload to IncomingTransaction

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Processed transactions repository (dedup persistente)

**Files:**
- Create: `src/repositories/processed-transactions.repository.ts`

- [ ] **Step 1: Criar o repositório**

```ts
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

// Conjunto persistente de transactionIds já reconciliados pelo scanner.
// Cap em MAX_TRACKED_IDS (FIFO) — janela do Cumbuca é curta, não há risco
// de uma transação antiga sair do conjunto e ser reprocessada.

const STORE_PATH = path.resolve('data/processed-transaction-ids.json');
const MAX_TRACKED_IDS = 1000;

interface StoreShape {
  ids: string[];
}

let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function ensureFile(): Promise<void> {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  try {
    await access(STORE_PATH);
  } catch {
    const empty: StoreShape = { ids: [] };
    await writeFile(STORE_PATH, JSON.stringify(empty, null, 2), 'utf8');
  }
}

async function read(): Promise<StoreShape> {
  await ensureFile();
  const raw = await readFile(STORE_PATH, 'utf8');
  return JSON.parse(raw) as StoreShape;
}

async function write(store: StoreShape): Promise<void> {
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

export const processedTransactionsRepository = {
  wasAlreadyProcessed(transactionId: string): Promise<boolean> {
    return serialize(async () => {
      const store = await read();
      return store.ids.includes(transactionId);
    });
  },

  markAsProcessed(transactionId: string): Promise<void> {
    return serialize(async () => {
      const store = await read();
      if (store.ids.includes(transactionId)) return;
      store.ids.push(transactionId);
      if (store.ids.length > MAX_TRACKED_IDS) {
        store.ids = store.ids.slice(-MAX_TRACKED_IDS);
      }
      await write(store);
    });
  },
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/processed-transactions.repository.ts
git commit -m "feat(cumbuca): processed-transactions repository for scanner dedup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Token store (persistência OAuth)

**Files:**
- Create: `src/services/cumbuca/cumbuca.tokens.ts`

- [ ] **Step 1: Criar o token store**

```ts
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

const TOKENS_PATH = path.resolve('data/cumbuca-tokens.json');

export interface CumbucaTokens {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;   // ISO8601
  account_id: string;
}

async function ensureDir(): Promise<void> {
  await mkdir(path.dirname(TOKENS_PATH), { recursive: true });
}

export async function hasTokens(): Promise<boolean> {
  try {
    await access(TOKENS_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function readTokens(): Promise<CumbucaTokens> {
  const raw = await readFile(TOKENS_PATH, 'utf8');
  return JSON.parse(raw) as CumbucaTokens;
}

export async function writeTokens(tokens: CumbucaTokens): Promise<void> {
  await ensureDir();
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
}

export function isAccessTokenExpired(tokens: CumbucaTokens, skewMs = 30_000): boolean {
  // skewMs: refresh um pouco antes da expiração real pra evitar race conditions.
  return new Date(tokens.expires_at).getTime() - skewMs <= Date.now();
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/services/cumbuca/cumbuca.tokens.ts
git commit -m "feat(cumbuca): token store with expiry check

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Ledger source abstraction + mock implementation

**Files:**
- Create: `src/services/ledger/ledger.source.ts`
- Create: `src/services/ledger/mock.source.ts`
- Create: `src/services/ledger/factory.ts`

- [ ] **Step 1: Criar a interface**

`src/services/ledger/ledger.source.ts`:

```ts
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
```

- [ ] **Step 2: Criar o mock source**

`src/services/ledger/mock.source.ts`:

```ts
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingTransaction } from '../bills/bill.types.js';
import type { LedgerSource } from './ledger.source.js';

const MOCK_PATH = path.resolve('src/mock/incoming-transactions.json');

interface MockTransaction extends IncomingTransaction {
  consumed?: boolean;
}

async function loadFromDisk(): Promise<MockTransaction[]> {
  try {
    await access(MOCK_PATH);
  } catch {
    return [];
  }
  const raw = await readFile(MOCK_PATH, 'utf8');
  return JSON.parse(raw) as MockTransaction[];
}

async function persistConsumed(updated: MockTransaction[]): Promise<void> {
  await mkdir(path.dirname(MOCK_PATH), { recursive: true });
  await writeFile(MOCK_PATH, JSON.stringify(updated, null, 2), 'utf8');
}

export const mockLedgerSource: LedgerSource = {
  name: 'mock',

  async listRecentCredits({ sinceISO }) {
    const all = await loadFromDisk();
    const cutoff = new Date(sinceISO).getTime();

    // Comportamento legacy do worker antigo: o mock marca cada tx como
    // `consumed: true` depois de reportada uma vez. Mantemos isso pra
    // preservar a UX de demos antigas (rodar mock duas vezes não duplica).
    // Em produção (cumbuca source), dedup é por processed-transaction-ids.
    const fresh = all.filter(
      (transaction) =>
        !transaction.consumed &&
        new Date(transaction.occurred_at).getTime() >= cutoff,
    );

    if (fresh.length > 0) {
      const updated = all.map((transaction) =>
        fresh.find((f) => f.id === transaction.id)
          ? { ...transaction, consumed: true }
          : transaction,
      );
      await persistConsumed(updated);
    }

    return fresh.map(({ consumed: _, ...rest }) => rest);
  },
};
```

- [ ] **Step 3: Criar a factory (com stub temporário pro caso cumbuca)**

`src/services/ledger/factory.ts`:

```ts
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
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros.

- [ ] **Step 5: Commit**

```bash
git add src/services/ledger/ledger.source.ts src/services/ledger/mock.source.ts src/services/ledger/factory.ts
git commit -m "feat(ledger): introduce LedgerSource interface, mock impl, factory

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Cumbuca MCP client

> **ATENÇÃO ENGENHEIRO:** A API do `@modelcontextprotocol/sdk` evoluiu rápido. As assinaturas abaixo refletem padrões conhecidos do final de 2025/início de 2026 (auth provider com DCR, StreamableHTTPClientTransport). **Antes de implementar, valide contra a versão instalada:**
>
> 1. `cat node_modules/@modelcontextprotocol/sdk/package.json | grep version`
> 2. Leia `node_modules/@modelcontextprotocol/sdk/README.md` ou consulte https://github.com/modelcontextprotocol/typescript-sdk para a versão exata.
> 3. Procure especificamente as seções **OAuth client** e **Streamable HTTP transport**.
>
> Se as APIs divergirem, **adapte os imports e assinaturas** mantendo a mesma divisão de responsabilidades (DCR + auth flow + listRecentCredits + refresh). Não invente comportamento — se algo não bater, pause e pergunte.

**Files:**
- Create: `src/services/cumbuca/cumbuca.client.ts`
- Create: `src/services/ledger/cumbuca.source.ts`

- [ ] **Step 1: Criar `cumbuca.client.ts`**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  hasTokens,
  readTokens,
  writeTokens,
  isAccessTokenExpired,
  type CumbucaTokens,
} from './cumbuca.tokens.js';
import type {
  CumbucaListAccountsResponse,
  CumbucaListTransactionsResponse,
  CumbucaConsentStatus,
} from './cumbuca.types.js';

const MCP_SERVER_URL = 'https://mcp.cumbuca.com/mcp';

// Estado de conectividade em memória — não persiste. Refletido pelo último
// resultado de uma operação contra o MCP.
let connected = true;

function markConnected(): void {
  connected = true;
}

function markDisconnected(reason: string): void {
  if (connected) {
    console.error('[cumbuca] disconnected:', reason);
  }
  connected = false;
}

export function isConnected(): boolean {
  return connected;
}

// -------------- OAuth / DCR --------------

interface DcrRegistrationResult {
  client_id: string;
  client_secret: string;
  // (Cumbuca retorna outros campos; só guardamos os essenciais.)
}

export interface AuthFlowStart {
  authorizationUrl: string;
  // Mantém o state codeVerifier in-memory durante o link flow; é trocado
  // junto com o `code` no callback.
  state: {
    clientId: string;
    clientSecret: string;
    codeVerifier: string;
    redirectUri: string;
  };
}

// Registra o bot como novo MCP client via Dynamic Client Registration.
// Endpoint padrão OAuth2 DCR: POST {server}/register. Confirme contra a doc.
async function registerClient(redirectUri: string): Promise<DcrRegistrationResult> {
  const response = await fetch(`${MCP_SERVER_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'racha-conta-bot',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  if (!response.ok) {
    throw new Error(`DCR failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as DcrRegistrationResult;
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(hash).toString('base64url');
}

export async function startAuthFlow(redirectUri: string): Promise<AuthFlowStart> {
  const registration = await registerClient(redirectUri);
  const codeVerifier = generateCodeVerifier();
  const challenge = await pkceChallenge(codeVerifier);

  const url = new URL(`${MCP_SERVER_URL}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', registration.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return {
    authorizationUrl: url.toString(),
    state: {
      clientId: registration.client_id,
      clientSecret: registration.client_secret,
      codeVerifier,
      redirectUri,
    },
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
}

export async function exchangeCodeForTokens(
  authorizationCode: string,
  state: AuthFlowStart['state'],
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: state.redirectUri,
    client_id: state.clientId,
    client_secret: state.clientSecret,
    code_verifier: state.codeVerifier,
  });
  const response = await fetch(`${MCP_SERVER_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

async function refreshAccessToken(tokens: CumbucaTokens): Promise<CumbucaTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id,
    client_secret: tokens.client_secret,
  });
  const response = await fetch(`${MCP_SERVER_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    markDisconnected(`refresh failed: ${response.status}`);
    throw new Error(`Refresh failed: ${response.status} ${await response.text()}`);
  }
  const refreshed = (await response.json()) as TokenResponse;
  const updated: CumbucaTokens = {
    ...tokens,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
  };
  await writeTokens(updated);
  return updated;
}

// -------------- MCP tool calls --------------

async function getCurrentTokens(): Promise<CumbucaTokens> {
  if (!(await hasTokens())) {
    throw new Error('No Cumbuca tokens present. Run `npm run cumbuca:link`.');
  }
  let tokens = await readTokens();
  if (isAccessTokenExpired(tokens)) {
    tokens = await refreshAccessToken(tokens);
  }
  return tokens;
}

async function openMcpClient(tokens: CumbucaTokens): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  });
  const client = new Client({ name: 'racha-conta-bot', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

async function callMcpTool<TResult>(
  toolName: string,
  args: Record<string, unknown>,
): Promise<TResult> {
  const tokens = await getCurrentTokens();
  const { client, close } = await openMcpClient(tokens);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    markConnected();
    // MCP tool results have a `content` array with type 'text' items containing JSON.
    const textBlock = (result.content as Array<{ type: string; text?: string }>).find(
      (block) => block.type === 'text' && typeof block.text === 'string',
    );
    if (!textBlock?.text) {
      throw new Error(`Unexpected MCP response shape for ${toolName}: ${JSON.stringify(result)}`);
    }
    return JSON.parse(textBlock.text) as TResult;
  } finally {
    await close();
  }
}

// -------------- Public surface --------------

export async function getConsentStatus(): Promise<CumbucaConsentStatus> {
  return callMcpTool<CumbucaConsentStatus>('get_consent_status', {});
}

export async function listAccounts(): Promise<CumbucaListAccountsResponse> {
  return callMcpTool<CumbucaListAccountsResponse>('list_accounts', {});
}

export async function listAccountTransactions(args: {
  accountId: string;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
}): Promise<CumbucaListTransactionsResponse> {
  return callMcpTool<CumbucaListTransactionsResponse>('list_account_transactions', {
    account_id: args.accountId,
    from_date: args.fromDate,
    to_date: args.toDate,
  });
}
```

- [ ] **Step 2: Criar o ledger source baseado em Cumbuca**

`src/services/ledger/cumbuca.source.ts`:

```ts
import { readTokens } from '../cumbuca/cumbuca.tokens.js';
import { listAccountTransactions } from '../cumbuca/cumbuca.client.js';
import { isReceivedPix, toIncomingTransaction } from '../cumbuca/cumbuca.mapper.js';
import type { LedgerSource } from './ledger.source.js';

function toYYYYMMDD(isoOrDate: string | Date): string {
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
```

- [ ] **Step 3: Wire o cumbuca source na factory**

Em `src/services/ledger/factory.ts`, trocar:

```ts
  // O cumbuca source é criado na Task 6. Até lá, só fallback pra mock.
  // Este branch só executa quando há tokens persistidos — o que só acontece
  // após Task 8 (cumbuca:link). Portanto está logicamente inacessível enquanto
  // a Task 6 não estiver concluída.
  throw new Error(
    'cumbuca ledger source not yet wired — finish Task 6 to enable',
  );
```

por:

```ts
  const { cumbucaLedgerSource } = await import('./cumbuca.source.js');
  return cumbucaLedgerSource;
```

(Import dinâmico mantém o lazy-load do SDK MCP quando o user só usa mock.)

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros.

Se aparecer erro sobre `crypto.subtle` ou `Buffer.from(...).toString('base64url')`, confirme que o `tsconfig.json` tem `lib: ["ES2022"]` ou superior, e `target: ES2022`. Node 24 suporta tudo isso nativamente.

- [ ] **Step 5: Commit**

```bash
git add src/services/cumbuca/cumbuca.client.ts src/services/ledger/cumbuca.source.ts src/services/ledger/factory.ts
git commit -m "feat(cumbuca): MCP client with DCR + OAuth + refresh + wire factory

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: OAuth callback route

**Files:**
- Create: `src/routes/cumbuca.oauth.ts`

- [ ] **Step 1: Criar a rota de callback**

`src/routes/cumbuca.oauth.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// O state in-memory é registrado pelo script `cumbuca:link` quando ele inicia
// o flow. Quando o user autoriza no banco, o redirect vem aqui com `code` e
// `state` (este último ignorado — usamos in-memory).

type OnCodeReceived = (code: string) => void;
let onCodeReceived: OnCodeReceived | null = null;

export function registerCallbackListener(handler: OnCodeReceived): void {
  onCodeReceived = handler;
}

export function clearCallbackListener(): void {
  onCodeReceived = null;
}

export function registerCumbucaOAuthRoutes(app: FastifyInstance): void {
  app.get(
    '/oauth/cumbuca/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { code, error } = request.query as { code?: string; error?: string };

      if (error) {
        reply.type('text/html').send(
          `<h1>❌ Autorização cancelada</h1><p>${error}</p><p>Pode fechar esta aba.</p>`,
        );
        return;
      }
      if (!code) {
        reply.code(400).type('text/html').send(
          '<h1>⚠️ Faltou o code no callback.</h1>',
        );
        return;
      }
      if (!onCodeReceived) {
        reply.code(409).type('text/html').send(
          '<h1>⚠️ Nenhum flow de pareamento ativo.</h1><p>Rode `npm run cumbuca:link` antes.</p>',
        );
        return;
      }

      onCodeReceived(code);
      reply.type('text/html').send(
        '<h1>✅ Pareamento concluído</h1><p>Pode fechar esta aba e voltar pro terminal.</p>',
      );
    },
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/routes/cumbuca.oauth.ts
git commit -m "feat(cumbuca): OAuth callback route with in-memory listener

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: CLI script `cumbuca:link`

**Files:**
- Create: `src/bin/cumbuca-link.ts`

- [ ] **Step 1: Criar o script**

```ts
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
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/bin/cumbuca-link.ts
git commit -m "feat(cumbuca): CLI script for OAuth/DCR pairing flow

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Payment scanner worker

**Files:**
- Create: `src/workers/payment-scanner.worker.ts`

- [ ] **Step 1: Criar o scanner**

```ts
import { billRepository } from '../repositories/bill.repository.js';
import { processedTransactionsRepository } from '../repositories/processed-transactions.repository.js';
import { tryReconcile } from '../services/bills/bill.service.js';
import { createLedgerSource } from '../services/ledger/factory.js';
import { notifyUser } from '../services/whatsapp/whatsapp.js';
import type { Bill } from '../services/bills/bill.types.js';
import type { LedgerSource } from '../services/ledger/ledger.source.js';

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

// Janela mínima de busca pra cobrir lag de propagação Open Finance.
const MIN_LOOKBACK_MS = ONE_HOUR_MS;

let scanTimer: NodeJS.Timeout | null = null;
let ledgerSource: LedgerSource | null = null;

async function getSource(): Promise<LedgerSource> {
  if (!ledgerSource) ledgerSource = await createLedgerSource();
  return ledgerSource;
}

function oldestCreatedAt(bills: Bill[]): string {
  return bills.reduce((oldest, bill) =>
    new Date(bill.created_at).getTime() < new Date(oldest).getTime() ? bill.created_at : oldest,
    bills[0]!.created_at,
  );
}

function ageMsOfMostRecentBill(bills: Bill[]): number {
  const newest = bills.reduce((mostRecent, bill) =>
    new Date(bill.created_at).getTime() > new Date(mostRecent).getTime() ? bill.created_at : mostRecent,
    bills[0]!.created_at,
  );
  return Date.now() - new Date(newest).getTime();
}

// Tabela de cadência (spec §5): quanto mais nova a bill mais recente, mais agressivo o polling.
export function computeNextScanDelay(openBills: Bill[]): number | null {
  if (openBills.length === 0) return null;
  const age = ageMsOfMostRecentBill(openBills);
  if (age <= ONE_HOUR_MS) return 5 * ONE_MINUTE_MS;
  if (age <= 6 * ONE_HOUR_MS) return 15 * ONE_MINUTE_MS;
  if (age <= ONE_DAY_MS) return ONE_HOUR_MS;
  return 6 * ONE_HOUR_MS;
}

async function expireBillsOlderThanSevenDays(openBills: Bill[]): Promise<void> {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  for (const bill of openBills) {
    if (new Date(bill.created_at).getTime() >= cutoff) continue;

    const expired = await billRepository.update(bill.id, (b) => {
      if (b.status === 'OPEN') b.status = 'EXPIRED';
    });
    if (!expired) continue;

    const pending = expired.participants.filter((p) => p.status === 'PENDING');
    const pendingNames = pending.map((p) => p.name).join(', ');
    console.log('[scanner] expired bill', { id: expired.id, description: expired.description });
    await notifyUser(
      pending.length > 0
        ? `⏱️ Bill "${expired.description}" expirou após 7 dias. Pendentes: ${pendingNames}.`
        : `⏱️ Bill "${expired.description}" expirou após 7 dias.`,
    );
  }
}

export async function scanForBillPayments(): Promise<void> {
  const openBills = await billRepository.findOpen();
  if (openBills.length === 0) {
    console.log('[scanner] idle — no open bills');
    return;
  }

  await expireBillsOlderThanSevenDays(openBills);

  // Re-leia após expirations — algumas bills podem ter virado EXPIRED.
  const stillOpen = await billRepository.findOpen();
  if (stillOpen.length === 0) {
    console.log('[scanner] all open bills expired this round');
    return;
  }

  const earliest = oldestCreatedAt(stillOpen);
  const sinceMs = Math.min(
    new Date(earliest).getTime(),
    Date.now() - MIN_LOOKBACK_MS,
  );
  const sinceISO = new Date(sinceMs).toISOString();

  const source = await getSource();
  console.log('[scanner] scanning', { source: source.name, sinceISO, openBills: stillOpen.length });

  let credits;
  try {
    credits = await source.listRecentCredits({ sinceISO });
  } catch (error) {
    console.error('[scanner] ledger source failed', error);
    return;
  }

  for (const transaction of credits) {
    if (await processedTransactionsRepository.wasAlreadyProcessed(transaction.id)) continue;
    await tryReconcile(transaction);
    await processedTransactionsRepository.markAsProcessed(transaction.id);
  }
}

async function runScanAndReschedule(): Promise<void> {
  try {
    await scanForBillPayments();
  } catch (error) {
    console.error('[scanner] unexpected scan error', error);
  } finally {
    await scheduleNextScan();
  }
}

async function scheduleNextScan(): Promise<void> {
  const openBills = await billRepository.findOpen();
  const delay = computeNextScanDelay(openBills);
  if (delay === null) {
    console.log('[scanner] going idle — will wake on next bill');
    scanTimer = null;
    return;
  }
  console.log(`[scanner] next scan in ${Math.round(delay / 1000)}s`);
  scanTimer = setTimeout(() => {
    void runScanAndReschedule();
  }, delay);
}

// Chamada pelo bill.service quando uma bill nova é criada. Cancela o cooldown
// atual e dispara um scan imediato — UX de "sob demanda".
export function notifyNewBillCreated(): void {
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  console.log('[scanner] new bill — triggering immediate scan');
  void runScanAndReschedule();
}

export async function startPaymentScanner(): Promise<void> {
  console.log('[scanner] starting payment scanner');
  // Roda um primeiro scan imediato (cobre bills criadas antes do boot).
  void runScanAndReschedule();
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/workers/payment-scanner.worker.ts
git commit -m "feat(scanner): payment scanner with adaptive scheduling and bill expiry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire-up — bill.service trigger, server.ts, delete old worker, bill.repository

**Files:**
- Modify: `src/services/bills/bill.service.ts`
- Modify: `src/server.ts`
- Modify: `src/repositories/bill.repository.ts`
- Delete: `src/workers/ledger.worker.ts`

- [ ] **Step 1: Trigger imediato em `bill.service.ts`**

Em `src/services/bills/bill.service.ts`, adicionar import:

```ts
import { notifyNewBillCreated } from '../../workers/payment-scanner.worker.js';
```

(Coloca junto com os outros imports do topo.)

E ao final de `createBillFromExtraction`, **antes** do `return bill;`, adicionar:

```ts
  notifyNewBillCreated();
  return bill;
```

(Linha 111 do arquivo atual — depois de `await sendBillCreatedMessages(bill);`.)

- [ ] **Step 2: Garantir que `findOpen` retorna só status OPEN (não EXPIRED)**

`src/repositories/bill.repository.ts` linha 65-67 já filtra por `b.status === 'OPEN'`, então não precisa mudar nada — confirma só.

Se o engineer estiver lendo isso e o filtro for diferente do esperado, ajustar pra `b.status === 'OPEN'` explicitamente.

- [ ] **Step 3: Trocar worker import em `src/server.ts`**

```ts
import Fastify from 'fastify';
import { env } from './config/env.js';
import { registerWhatsAppWebhook } from './routes/whatsapp.webhook.js';
import { registerCumbucaOAuthRoutes } from './routes/cumbuca.oauth.js';
import { startPaymentScanner } from './workers/payment-scanner.worker.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ ok: true }));
  registerWhatsAppWebhook(app);
  registerCumbucaOAuthRoutes(app);

  await app.listen({ port: env.port, host: '0.0.0.0' });
  await startPaymentScanner();
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
```

- [ ] **Step 4: Deletar o worker antigo**

```bash
rm src/workers/ledger.worker.ts
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Esperado: zero erros. Se aparecer erro de import em outro lugar referenciando `ledger.worker.ts`, ajustar.

- [ ] **Step 6: Commit**

```bash
git add src/services/bills/bill.service.ts src/server.ts src/workers/ledger.worker.ts
git commit -m "feat(cumbuca): wire payment scanner — trigger on new bill, register OAuth route, drop old ledger worker

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Smoke test end-to-end (manual)

> **Não há código nessa task — só um checklist de validação manual.** Marque cada item conforme valida.

- [ ] **Step 1: Typecheck final**

```bash
npm run typecheck
```

Esperado: zero erros.

- [ ] **Step 2: Bot sobe com fallback pra mock (sem tokens configurados)**

```bash
# Garantir que não há tokens persistidos (fresh state)
rm -f data/cumbuca-tokens.json
npm run dev
```

Esperado nos logs:
- `[ledger] LEDGER_SOURCE=cumbuca but no tokens found — falling back to mock`
- `[scanner] starting payment scanner`
- `[scanner] idle — no open bills` (se não há bills abertas no `db.json`)

Pare o servidor (`Ctrl+C`).

- [ ] **Step 3: Pareamento OAuth**

```bash
npm run cumbuca:link
```

Esperado:
1. Log `[oauth] Registrando MCP client no Cumbuca (DCR)...`
2. Browser abre na URL de autorização do Cumbuca.
3. Autoriza com app do banco (Nubank).
4. Redirect pro `localhost:3000/oauth/cumbuca/callback`, página com "✅ Pareamento concluído".
5. Terminal mostra contas disponíveis e pede escolha (se >1).
6. Log final: `[oauth] ✅ Pareado com ...`
7. Arquivo `data/cumbuca-tokens.json` existe e tem `account_id` preenchido.

> **Se falhar no passo 1 (DCR):** plano B do spec — abrir devtools no claude.ai durante uma chamada Cumbuca pra ver como ele faz o handshake. Reportar a divergência pra ajustar `registerClient`.

- [ ] **Step 4: Bot consome do Cumbuca real**

```bash
npm run dev
```

Esperado:
- `[scanner] starting payment scanner`
- Se há bills OPEN: `[scanner] scanning { source: 'cumbuca', sinceISO: '...', openBills: N }`
- Se não há bills OPEN: `[scanner] idle — no open bills`

- [ ] **Step 5: Fluxo completo — criar bill e reconciliar**

1. Manda mensagem no WhatsApp pro próprio número: `"Paguei 30 na pizzaria, divide com Maria e João, 10 cada"`.
2. Bot responde com 2 mensagens PIX (Maria + João).
3. Logs mostram `[scanner] new bill — triggering immediate scan`.
4. Faz um PIX real de R$ 10 da sua conta-teste com o nome "Maria" (ou pede pra alguém).
5. Em até 5 minutos, scanner identifica e bot manda: `"Maria acabou de pagar! ..."`.
6. Repete pra João.
7. Quando ambos pagaram, bot manda mensagem de fechamento.

- [ ] **Step 6: Auto-CLOSE após 7 dias (não dá pra validar agora — registrar como follow-up)**

Validação real requer 7 dias passados. Pode forçar um teste editando manualmente `data/db.json` pra colocar `created_at` 8 dias atrás numa bill, e checar se o próximo scan a marca como `EXPIRED` e manda a mensagem WhatsApp.

- [ ] **Step 7: Atualizar memórias do projeto**

Após validar tudo, atualizar memorias relacionadas:
- `racha-conta-overview.md` — substituir menção a "mock JSON" pela integração Cumbuca real.
- `racha-conta-next-steps.md` — remover item 1 (Cumbuca real) e item 4 (resiliência LLM continua aberto, mas Cumbuca tem o seu próprio).

---

## Cobertura do spec — checklist

- [x] §2 (Approach A — Bot como MCP client direto) → Task 6
- [x] §3.1 (componentes novos) → Tasks 2-9
- [x] §3.2 (componentes modificados) → Task 10
- [x] §3.3 (delete `ledger.worker.ts`) → Task 10
- [x] §4 (Setup OAuth UX) → Tasks 7-8
- [x] §4.1 (shape de tokens) → Task 4 + Task 8
- [x] §4.2 (múltiplas contas) → Task 8 (`promptAccountChoice`)
- [x] §4.3 (reconnect alert) → Task 6 (`markDisconnected`); aviso WhatsApp explícito é melhoria pós-MVP (logged, não notificado — deliberadamente simplificado pra v1)
- [x] §5 (polling adaptativo) → Task 9
- [x] §6 (mapper, dedup, scanner loop) → Tasks 2, 3, 9
- [x] §7.1 (erros) → Tasks 6 (refresh), 9 (try/catch source); resto é log-only conforme spec
- [x] §7.2 (toggle LEDGER_SOURCE) → Tasks 1, 5
- [x] §7.3 (logs prefixed) → Tasks 5, 6, 9 (prefixes `[ledger]`, `[cumbuca]`, `[scanner]`, `[oauth]`)

**Gap conhecido:** o spec §4.3 fala em mensagem WhatsApp "🔒 Cumbuca desconectado" quando refresh falha. Implementação atual só loga. Pode ser adicionado em uma task #12 se você quiser ainda nessa rodada, ou virar follow-up. Recomendo follow-up — o caso é raro e a complicação adicional (evitar spam de mensagens em retry loop, persistir flag "já alertei") não vale travar o MVP.
