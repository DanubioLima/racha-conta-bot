# Slice Cloud Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrar a stack do bot (atualmente local com Evolution+Baileys) pra VPS Hetzner gerenciada por Dokploy, usando WhatsApp Cloud API oficial pareada com o chip Vivo secundário.

**Architecture:** Bot Node 24 + Fastify rodando num container Docker, atrás de Traefik (gerenciado pelo Dokploy) com TLS automático via Let's Encrypt. WhatsApp via Cloud API REST do Meta + webhook entrante com HMAC. Cumbuca MCP preservado com refactor da rota OAuth pra viver no servidor principal (não mais num Fastify isolado do CLI). Dados em JSON files num volume persistente do Dokploy.

**Tech Stack:** Node 24, TypeScript, Fastify, axios, @modelcontextprotocol/sdk, Hetzner CPX11, Dokploy, Traefik, Docker, WhatsApp Cloud API v21, Meta Business Manager.

**Project convention reminder:** Sem testes automatizados (já decidido pelo user em sessões anteriores). Cada task tem `npx tsc --noEmit` + commit como checkpoint, igual ao plano da integração Cumbuca. Smoke ponta-a-ponta validado manualmente na Task 15.

---

## File structure overview

**Created:**
- `src/services/whatsapp/cloudapi.types.ts` — shapes do webhook + payloads outbound
- `src/services/whatsapp/cloudapi.client.ts` — cliente REST do graph.facebook.com
- `src/services/whatsapp/window.ts` — tracker da janela de 24h
- `Dockerfile` (na raiz) — imagem pra Dokploy
- `docs/superpowers/runbooks/2026-05-23-meta-setup.md` — runbook manual de setup no Meta Business
- `docs/superpowers/runbooks/2026-05-23-vps-setup.md` — runbook manual de provisionamento Hetzner+Dokploy

**Modified:**
- `src/config/env.ts` — drop EVOLUTION_*+WORKER_INTERVAL_MS; add WHATSAPP_*+PUBLIC_BASE_URL
- `src/services/whatsapp/whatsapp.ts` — interface pública preservada, internals reescritos
- `src/routes/whatsapp.webhook.ts` — shape Meta + HMAC + GET verify
- `src/routes/cumbuca.oauth.ts` — file-based pending-pairing em vez de listener in-memory
- `src/bin/cumbuca-link.ts` — sem Fastify próprio; escreve pending file + poll por tokens
- `src/server.ts` — registra rota OAuth Cumbuca + healthz + raw body parser pra HMAC
- `.env.example` — nova lista de vars
- `package.json` — `tsx` movido pra dependencies (precisa em runtime no Dockerfile)

**Deleted:**
- `docker-compose.yml` — stack Evolution+Postgres+Redis morre

**Tasks são commitadas em sequência na branch `feat/cloud-deployment` (já criada).**

---

## Task 1: Add new env vars to `src/config/env.ts` (sem remover os antigos)

**Why staged:** Outros arquivos (`whatsapp.ts`, `whatsapp.webhook.ts`, `cumbuca-link.ts`) ainda referenciam `env.evolutionApiUrl` etc. Removo no Task 10, depois de reescrever esses arquivos.

**Files:**
- Modify: `src/config/env.ts`

- [ ] **Step 1: Adicionar novas envs ao arquivo, mantendo as antigas**

Substituir o arquivo inteiro por:

```typescript
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
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
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
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
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
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET!,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
};
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. (Você precisa ter as novas vars no seu `.env` local; pode setar com valores placeholder pra esse passo.)

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "chore(env): add WHATSAPP_* and PUBLIC_BASE_URL env vars"
```

---

## Task 2: Cloud API types

**Files:**
- Create: `src/services/whatsapp/cloudapi.types.ts`

- [ ] **Step 1: Criar o arquivo de tipos**

```typescript
// Shapes do WhatsApp Cloud API (v21).
// Source: https://developers.facebook.com/docs/whatsapp/cloud-api/

// -------- Webhook entrante --------

export interface MetaWebhookBody {
  object: 'whatsapp_business_account';
  entry: MetaWebhookEntry[];
}

export interface MetaWebhookEntry {
  id: string;
  changes: MetaWebhookChange[];
}

export interface MetaWebhookChange {
  value: MetaWebhookValue;
  field: 'messages';
}

export interface MetaWebhookValue {
  messaging_product: 'whatsapp';
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: Array<{
    profile: { name?: string };
    wa_id: string;
  }>;
  messages?: MetaWebhookMessage[];
  statuses?: MetaWebhookStatus[];
}

export interface MetaWebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contacts' | 'interactive' | 'button' | 'reaction' | 'unknown';
  text?: { body: string };
  // Outros campos por tipo existem mas não usamos no MVP.
}

export interface MetaWebhookStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
}

// -------- Outbound payloads --------

export interface SendTextPayload {
  messaging_product: 'whatsapp';
  to: string;
  type: 'text';
  text: { body: string; preview_url?: boolean };
}

export interface SendTemplatePayload {
  messaging_product: 'whatsapp';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components?: Array<{
      type: 'body' | 'header' | 'button';
      parameters: Array<{ type: 'text'; text: string }>;
    }>;
  };
}

export interface SendMessageResponse {
  messaging_product: 'whatsapp';
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/whatsapp/cloudapi.types.ts
git commit -m "feat(whatsapp): add Cloud API webhook and payload types"
```

---

## Task 3: Cloud API REST client

**Files:**
- Create: `src/services/whatsapp/cloudapi.client.ts`

- [ ] **Step 1: Criar o cliente REST**

```typescript
import axios from 'axios';
import { env } from '../../config/env.js';
import type {
  SendTextPayload,
  SendTemplatePayload,
  SendMessageResponse,
} from './cloudapi.types.js';

const META_API_BASE = 'https://graph.facebook.com/v21.0';
const HTTP_TIMEOUT_MS = 30_000;

const client = axios.create({
  baseURL: META_API_BASE,
  timeout: HTTP_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
  },
});

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${env.whatsappAccessToken}` };
}

function messagesEndpoint(): string {
  return `/${env.whatsappPhoneNumberId}/messages`;
}

export async function sendText(to: string, body: string): Promise<string> {
  const payload: SendTextPayload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  };
  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
  console.log('[whatsapp] sendText →', { to, preview });
  try {
    const response = await client.post<SendMessageResponse>(messagesEndpoint(), payload, {
      headers: authHeader(),
    });
    const id = response.data.messages?.[0]?.id ?? '';
    console.log('[whatsapp] sendText ok', { id });
    return id;
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? (err.response?.data ?? err.message)
      : err;
    console.error('[whatsapp] sendText failed', detail);
    throw err;
  }
}

export interface TemplateBodyArgs {
  templateName: string;
  languageCode?: string;
  bodyParameters: string[];
}

export async function sendTemplate(to: string, args: TemplateBodyArgs): Promise<string> {
  const payload: SendTemplatePayload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: args.templateName,
      language: { code: args.languageCode ?? 'pt_BR' },
      components: args.bodyParameters.length > 0 ? [{
        type: 'body',
        parameters: args.bodyParameters.map((text) => ({ type: 'text', text })),
      }] : undefined,
    },
  };
  console.log('[whatsapp] sendTemplate →', {
    to,
    template: args.templateName,
    parameters: args.bodyParameters.length,
  });
  try {
    const response = await client.post<SendMessageResponse>(messagesEndpoint(), payload, {
      headers: authHeader(),
    });
    const id = response.data.messages?.[0]?.id ?? '';
    console.log('[whatsapp] sendTemplate ok', { id, template: args.templateName });
    return id;
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? (err.response?.data ?? err.message)
      : err;
    console.error('[whatsapp] sendTemplate failed', detail);
    throw err;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/whatsapp/cloudapi.client.ts
git commit -m "feat(whatsapp): Cloud API REST client (sendText, sendTemplate)"
```

---

## Task 4: Window state (24h tracking)

**Files:**
- Create: `src/services/whatsapp/window.ts`

- [ ] **Step 1: Criar o módulo de janela**

```typescript
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

// Janela de 24h da WhatsApp Cloud API: cada inbound do user reseta. Dentro da
// janela, outbound é livre-forma e gratuito; fora dela, precisa template
// pré-aprovado. Persiste `last_inbound_at` por user (multi-user friendly,
// embora o MVP seja single-user).

const STORE_PATH = path.resolve('data/whatsapp-window.json');
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface StoreShape {
  // wa_id (E.164 sem +) → ISO8601 do último inbound
  lastInboundByUser: Record<string, string>;
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
    const empty: StoreShape = { lastInboundByUser: {} };
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

export function recordInboundFromUser(userNumber: string): Promise<void> {
  return serialize(async () => {
    const store = await read();
    store.lastInboundByUser[userNumber] = new Date().toISOString();
    await write(store);
  });
}

export function isWindowOpen(userNumber: string): Promise<boolean> {
  return serialize(async () => {
    const store = await read();
    const lastInbound = store.lastInboundByUser[userNumber];
    if (!lastInbound) return false;
    const diffMs = Date.now() - new Date(lastInbound).getTime();
    return diffMs < WINDOW_MS;
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/whatsapp/window.ts
git commit -m "feat(whatsapp): persistent 24h window tracker"
```

---

## Task 5: Reescrever `src/services/whatsapp/whatsapp.ts` preservando interface pública

**Files:**
- Modify: `src/services/whatsapp/whatsapp.ts`

A interface pública atual usada pelo resto do código: `notifyUser(text)`, `notifyUserImage(...)`, `wasSentByBot(id, text)`.

**Decisões importantes:**
- `wasSentByBot` é desnecessário com Cloud API (webhook só entrega inbound do user, nunca echoes do bot). Vou **manter a função exportada como stub `() => false`** pra evitar mudar `whatsapp.webhook.ts` neste task (Task 6 reescreve a webhook e some com a chamada).
- `notifyUserImage` está dormente (sem callers ativos depois do PR #2). Mantenho a função exportada mas a impl vira "não implementado" — Cloud API suporta image, mas como não usamos, evito código sem caller.
- `notifyUser` agora consulta a janela de 24h. Se aberta, manda texto livre; se fechada, abort com erro (caller é quem decide qual template usar — não inferimos).
- Adiciono `notifyUserViaTemplate(name, bodyParameters)` pra outbound fora da janela.

- [ ] **Step 1: Substituir o arquivo inteiro**

```typescript
import { sendText, sendTemplate, type TemplateBodyArgs } from './cloudapi.client.js';
import { isWindowOpen } from './window.js';
import { env } from '../../config/env.js';

// Public surface preservada pra callers existentes:
// - notifyUser(text)        — manda texto livre se a janela está aberta;
//                             erro descritivo se fechada (caller deve usar template).
// - notifyUserViaTemplate   — manda template aprovado pelo Meta.
// - notifyUserImage         — stub; image não usado no MVP atual (dormente desde PR #2).
// - wasSentByBot            — stub; Cloud API não entrega echoes do bot pelo webhook.

export class WindowClosedError extends Error {
  constructor(userNumber: string) {
    super(`24h window closed for ${userNumber} — use notifyUserViaTemplate with an approved template`);
    this.name = 'WindowClosedError';
  }
}

export async function notifyUser(text: string): Promise<void> {
  const userNumber = env.userWhatsappNumber;
  const open = await isWindowOpen(userNumber);
  if (!open) {
    throw new WindowClosedError(userNumber);
  }
  await sendText(userNumber, text);
}

export async function notifyUserViaTemplate(args: TemplateBodyArgs): Promise<void> {
  await sendTemplate(env.userWhatsappNumber, args);
}

// Stubs preservados pra calling code existente continuar a tipcheckar.
// Image não é usado pós-PR #2; webhook (Task 6) deixa de chamar wasSentByBot.

export async function notifyUserImage(_base64: string, _caption?: string): Promise<void> {
  throw new Error('notifyUserImage não implementado no path Cloud API — uso reservado pra futuro');
}

export function wasSentByBot(_id?: string | null, _text?: string | null): boolean {
  return false;
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. (A rota webhook ainda chama `wasSentByBot` mas com a stub `() => false` o comportamento fica: nunca filtra. Será corrigido completamente na Task 6 ao reescrever a webhook.)

- [ ] **Step 3: Commit**

```bash
git add src/services/whatsapp/whatsapp.ts
git commit -m "refactor(whatsapp): switch internals to Cloud API; keep public surface"
```

---

## Task 6: Reescrever a webhook do WhatsApp pra shape Meta

**Files:**
- Modify: `src/routes/whatsapp.webhook.ts`

Mudanças vs. versão Evolution:
1. **GET** route nova pra verificação inicial do Meta (`hub.mode`, `hub.verify_token`, `hub.challenge`)
2. **POST** route: novo shape (Meta `entry[].changes[].value.messages[]`), HMAC obrigatório, sem mais `wasSentByBot` (Cloud API não envia echoes)
3. Chama `recordInboundFromUser` ao receber inbound válido (alimenta o window tracker)
4. Normalização BR (nono dígito) e allowlist permanecem iguais

**HMAC raw body:** Fastify por default consome o body e descarta o raw. Configurar um content type parser custom pra preservar o raw body. Isso é feito no `server.ts` (Task 9). Aqui assumimos que `(request as any).rawBody` está disponível.

- [ ] **Step 1: Substituir o arquivo inteiro**

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { extractBillFromText } from '../services/llm/gemini.js';
import {
  createBillFromExtraction,
  notifyUnknown,
} from '../services/bills/bill.service.js';
import { recordInboundFromUser } from '../services/whatsapp/window.js';
import type {
  MetaWebhookBody,
  MetaWebhookMessage,
} from '../services/whatsapp/cloudapi.types.js';

function normalizeBrNumber(num: string): string {
  const digits = num.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') {
    return digits.slice(0, 4) + digits.slice(5);
  }
  return digits;
}

function numbersMatch(a: string, b: string): boolean {
  return normalizeBrNumber(a) === normalizeBrNumber(b);
}

function verifyMetaSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', env.whatsappAppSecret)
    .update(rawBody, 'utf8')
    .digest('hex');
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader),
  );
}

function collectMessages(body: MetaWebhookBody): MetaWebhookMessage[] {
  const messages: MetaWebhookMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) {
        messages.push(message);
      }
    }
  }
  return messages;
}

function extractText(message: MetaWebhookMessage): string | null {
  if (message.type === 'text' && message.text?.body) return message.text.body;
  return null;
}

export function registerWhatsAppWebhook(app: FastifyInstance): void {
  // -------- GET: verificação inicial pelo Meta --------
  app.get(
    '/webhooks/whatsapp',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, string | undefined>;
      const mode = query['hub.mode'];
      const token = query['hub.verify_token'];
      const challenge = query['hub.challenge'];
      if (mode === 'subscribe' && token === env.whatsappVerifyToken && challenge) {
        console.log('[webhook] verification ok');
        reply.type('text/plain').send(challenge);
        return;
      }
      console.warn('[webhook] verification failed', { mode, tokenMatches: token === env.whatsappVerifyToken });
      reply.code(403).send();
    },
  );

  // -------- POST: entrega de mensagens --------
  app.post(
    '/webhooks/whatsapp',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = (request as { rawBody?: string }).rawBody;
      if (!rawBody) {
        console.error('[webhook] missing rawBody — parser misconfigured');
        return reply.code(500).send();
      }
      const signature = request.headers['x-hub-signature-256'];
      const signatureValue = Array.isArray(signature) ? signature[0] : signature;
      if (!verifyMetaSignature(rawBody, signatureValue)) {
        console.warn('[webhook] HMAC verification failed');
        return reply.code(401).send();
      }

      const body = request.body as MetaWebhookBody;
      if (body.object !== 'whatsapp_business_account') {
        console.log('[webhook] ignored: wrong object type', { object: body.object });
        return reply.code(200).send({ ok: true, ignored: 'wrong-object' });
      }

      const messages = collectMessages(body);
      if (messages.length === 0) {
        // Status updates ou events sem `messages` — log e ignora.
        console.log('[webhook] no messages in batch');
        return reply.code(200).send({ ok: true });
      }

      // Reply 200 imediato; processa async pra Meta não retentar em chamadas
      // longas (Gemini, scanner).
      void (async () => {
        for (const message of messages) {
          if (!numbersMatch(message.from, env.userWhatsappNumber)) {
            console.log('[webhook] ignored: unauthorized-sender', {
              from: message.from,
              expected: env.userWhatsappNumber,
            });
            continue;
          }
          await recordInboundFromUser(message.from);
          const text = extractText(message);
          if (!text) {
            console.log('[webhook] ignored: non-text', { type: message.type });
            continue;
          }
          console.log('[webhook] processing', { messageId: message.id, text });
          try {
            const result = await extractBillFromText(text);
            if (result.intent !== 'create_bill' || !result.bill) {
              console.log('[webhook] intent unknown, notifying user');
              await notifyUnknown();
              continue;
            }
            await createBillFromExtraction(result.bill);
            console.log('[webhook] flow finished ok', { messageId: message.id });
          } catch (err) {
            console.error('[webhook] flow failed', err);
            try {
              await notifyUnknown();
            } catch {
              // already logged
            }
          }
        }
      })();

      return reply.code(200).send({ ok: true });
    },
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/routes/whatsapp.webhook.ts
git commit -m "refactor(webhook): switch to Meta Cloud API shape with HMAC verify"
```

---

## Task 7: Refactor da rota OAuth do Cumbuca (file-based pending pairing)

**Files:**
- Modify: `src/routes/cumbuca.oauth.ts`
- Create: `src/services/cumbuca/cumbuca.pending-pairing.ts`

**Comportamento novo:**
- Pending pairing state vive em `data/cumbuca-pending-pairing.json`
- Rota recebe callback, valida `state` query param + TTL, troca `code` por tokens, persiste tokens preliminares (sem `account_id`), apaga pending file, responde text/plain
- CLI (Task 8) escreve o pending file antes do flow e poll por tokens.json

- [ ] **Step 1: Criar o módulo de pending pairing**

```typescript
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import path from 'node:path';

const STORE_PATH = path.resolve('data/cumbuca-pending-pairing.json');
const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutos

export interface PendingPairing {
  state: string;
  client_id: string;
  client_secret: string;
  code_verifier: string;
  redirect_uri: string;
  created_at: string; // ISO8601
}

async function ensureDir(): Promise<void> {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
}

export async function writePendingPairing(pending: PendingPairing): Promise<void> {
  await ensureDir();
  await writeFile(STORE_PATH, JSON.stringify(pending, null, 2), 'utf8');
}

export async function readPendingPairing(): Promise<PendingPairing | null> {
  try {
    await access(STORE_PATH);
  } catch {
    return null;
  }
  const raw = await readFile(STORE_PATH, 'utf8');
  return JSON.parse(raw) as PendingPairing;
}

export async function deletePendingPairing(): Promise<void> {
  try {
    await unlink(STORE_PATH);
  } catch {
    // ok se não existe
  }
}

export function isPairingExpired(pending: PendingPairing): boolean {
  return Date.now() - new Date(pending.created_at).getTime() > PAIRING_TTL_MS;
}
```

- [ ] **Step 2: Reescrever `src/routes/cumbuca.oauth.ts`**

```typescript
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { exchangeCodeForTokens } from '../services/cumbuca/cumbuca.client.js';
import { writeTokens } from '../services/cumbuca/cumbuca.tokens.js';
import {
  readPendingPairing,
  deletePendingPairing,
  isPairingExpired,
} from '../services/cumbuca/cumbuca.pending-pairing.js';

export function registerCumbucaOAuthRoutes(app: FastifyInstance): void {
  app.get(
    '/oauth/cumbuca/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { code, state, error } = request.query as {
        code?: string;
        state?: string;
        error?: string;
      };

      if (error) {
        reply.type('text/plain; charset=utf-8').send(
          `Autorização cancelada: ${error}\nPode fechar esta aba.`,
        );
        return;
      }
      if (!code || !state) {
        reply.code(400).type('text/plain; charset=utf-8').send(
          'Faltou code ou state no callback.',
        );
        return;
      }

      const pending = await readPendingPairing();
      if (!pending) {
        reply.code(409).type('text/plain; charset=utf-8').send(
          'Nenhum pareamento ativo. Rode `npm run cumbuca:link` antes.',
        );
        return;
      }
      if (pending.state !== state) {
        console.warn('[cumbuca-oauth] state mismatch');
        reply.code(401).type('text/plain; charset=utf-8').send(
          'State mismatch. Tente parear de novo.',
        );
        return;
      }
      if (isPairingExpired(pending)) {
        await deletePendingPairing();
        reply.code(410).type('text/plain; charset=utf-8').send(
          'Pareamento expirou (>10min). Rode `npm run cumbuca:link` de novo.',
        );
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(code, {
          clientId: pending.client_id,
          clientSecret: pending.client_secret,
          codeVerifier: pending.code_verifier,
          redirectUri: pending.redirect_uri,
        });
        // Tokens preliminares — sem account_id. CLI completa o flow.
        await writeTokens({
          client_id: pending.client_id,
          client_secret: pending.client_secret,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          account_id: '',
        });
        await deletePendingPairing();
        console.log('[cumbuca-oauth] tokens persisted, account selection pending');
        reply.type('text/plain; charset=utf-8').send(
          '✅ Tokens recebidos. Volte ao terminal pra escolher a conta.',
        );
      } catch (err) {
        console.error('[cumbuca-oauth] code exchange failed', err);
        reply.code(500).type('text/plain; charset=utf-8').send(
          'Falhou trocar code por tokens. Veja logs do servidor.',
        );
      }
    },
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean (`bin/cumbuca-link.ts` ainda referencia `registerCallbackListener`/`clearCallbackListener` que removi — vai falhar nesse passo. Resolver agora cortando essas duas exports e ignorando o erro do CLI temporariamente, OU reescrever o CLI já neste task. Resposta: deixar o erro pra Task 8 fazer numa só vez.)

**Workaround**: a Task 8 reescreve o CLI completamente, então o erro de typecheck aqui é esperado. Pular o typecheck deste task, ou rodar `npx tsc --noEmit 2>&1 | grep -v cumbuca-link.ts` pra confirmar que o único erro é no CLI.

- [ ] **Step 4: Commit (typecheck full vem na Task 8)**

```bash
git add src/routes/cumbuca.oauth.ts src/services/cumbuca/cumbuca.pending-pairing.ts
git commit -m "refactor(cumbuca-oauth): file-based pending pairing for callback route"
```

---

## Task 8: Reescrever o CLI de pareamento Cumbuca

**Files:**
- Modify: `src/bin/cumbuca-link.ts`

**Comportamento novo:**
- Não sobe Fastify
- Escreve `data/cumbuca-pending-pairing.json` antes de abrir o browser
- Abre browser
- Poll por `data/cumbuca-tokens.json` aparecer (timeout 10min)
- Quando tokens aparecem com `account_id` vazio, lista contas, pede escolha, atualiza tokens com account_id
- Sai

- [ ] **Step 1: Substituir o arquivo**

```typescript
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
```

- [ ] **Step 2: Atualizar `src/services/cumbuca/cumbuca.client.ts` pra aceitar parâmetros nomeados no `exchangeCodeForTokens`**

O Task 7 chama `exchangeCodeForTokens(code, { clientId, clientSecret, codeVerifier, redirectUri })`. A versão atual recebe `(code, state: AuthFlowStart['state'])`. As assinaturas batem se mantermos `state` com as mesmas keys. Conferir:

Olhar `src/services/cumbuca/cumbuca.client.ts:196-218` — `exchangeCodeForTokens(authorizationCode, state)` onde `state` é `AuthFlowStart['state']` que já tem `{ clientId, clientSecret, codeVerifier, redirectUri }`. **Bate exatamente.** Nada a modificar nesse arquivo.

- [ ] **Step 3: Typecheck completo**

```bash
npx tsc --noEmit
```

Expected: clean. (Resolve o erro deixado pendente na Task 7.)

- [ ] **Step 4: Commit**

```bash
git add src/bin/cumbuca-link.ts
git commit -m "refactor(cumbuca-link): drop standalone Fastify; poll for tokens"
```

---

## Task 9: server.ts — registra rota OAuth Cumbuca + /healthz + raw body parser pra HMAC

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Substituir o arquivo**

```typescript
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { env } from './config/env.js';
import { registerWhatsAppWebhook } from './routes/whatsapp.webhook.js';
import { registerCumbucaOAuthRoutes } from './routes/cumbuca.oauth.js';
import { startPaymentScanner } from './workers/payment-scanner.worker.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  // Preserva o rawBody pra verificação HMAC do webhook do WhatsApp. Default do
  // Fastify descarta. Solução: parser custom que armazena rawBody no request
  // antes de devolver o JSON parseado pra rota.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request: FastifyRequest, body: string, done) => {
      try {
        const json = body.length > 0 ? JSON.parse(body) : {};
        (request as { rawBody?: string }).rawBody = body;
        done(null, json);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.get('/healthz', async () => ({
    ok: true,
    ts: new Date().toISOString(),
  }));

  registerWhatsAppWebhook(app);
  registerCumbucaOAuthRoutes(app);

  // Inicia o scanner antes do listen pra evitar a janela em que o webhook
  // do WhatsApp poderia chegar e chamar `notifyNewBillCreated` antes do
  // scanner estar pronto.
  await startPaymentScanner();
  await app.listen({ port: env.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): register OAuth + /healthz; preserve rawBody for HMAC"
```

---

## Task 10: env.ts — drop EVOLUTION_* e WORKER_INTERVAL_MS

**Files:**
- Modify: `src/config/env.ts`

Agora que nenhum código referencia mais `env.evolutionApiUrl`/etc nem `env.workerIntervalMs`, removo.

- [ ] **Step 1: Substituir `src/config/env.ts`**

```typescript
import 'dotenv/config';

const required = [
  'USER_WHATSAPP_NUMBER',
  'GEMINI_API_KEY',
  'PIX_KEY',
  'PIX_MERCHANT_NAME',
  'PIX_MERCHANT_CITY',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
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
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
  userWhatsappNumber: process.env.USER_WHATSAPP_NUMBER!,
  geminiApiKey: process.env.GEMINI_API_KEY!,
  pixKey: process.env.PIX_KEY!,
  pixMerchantName: process.env.PIX_MERCHANT_NAME!,
  pixMerchantCity: process.env.PIX_MERCHANT_CITY!,
  ledgerSource: ledgerSourceRaw as 'cumbuca' | 'mock',
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET!,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
};
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "chore(env): drop EVOLUTION_* and dead WORKER_INTERVAL_MS"
```

---

## Task 11: `.env.example` — refletir nova config

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Substituir o arquivo**

```ini
PORT=3000

# Public base URL onde o bot está exposto. Local dev: http://localhost:3000.
# Produção: https://bot.appslice.com.br. Usado pelo CLI cumbuca:link pra
# montar o redirect URI registrado via DCR.
PUBLIC_BASE_URL=http://localhost:3000

# Seu número (E.164 sem +, ex: 5511999999999) — destinatário das mensagens do bot
USER_WHATSAPP_NUMBER=

# Gemini (https://aistudio.google.com/app/apikey)
GEMINI_API_KEY=

# PIX (static Copia-e-Cola)
PIX_KEY=
PIX_MERCHANT_NAME=
PIX_MERCHANT_CITY=

# Ledger source: 'cumbuca' (default) usa o MCP do Cumbuca; 'mock' lê src/mock/incoming-transactions.json
LEDGER_SOURCE=cumbuca

# WhatsApp Cloud API (Meta Business)
# - PHONE_NUMBER_ID: ID do número do bot (não o número em si)
# - ACCESS_TOKEN: System User token long-lived
# - APP_SECRET: do App no Meta — pra verificar HMAC dos webhooks
# - VERIFY_TOKEN: random gerado por você, ecoado no GET de verificação
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
```

- [ ] **Step 2: Commit (sem código TS pra typechecar)**

```bash
git add .env.example
git commit -m "chore(env): update .env.example for Cloud API config"
```

---

## Task 12: Dockerfile + drop docker-compose.yml; promove tsx pra dependencies

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Delete: `docker-compose.yml`
- Modify: `package.json`

- [ ] **Step 1: Promover `tsx` pra dependencies em `package.json`**

`tsx` é usado em runtime pelo `npm start` (e pelo CMD do Dockerfile). Está em `devDependencies` hoje, o que quebraria `npm ci --omit=dev`. Mover.

Edit em `package.json` — remover de `devDependencies` e adicionar em `dependencies`:

```json
"dependencies": {
  "@google/genai": "^2.3.0",
  "@modelcontextprotocol/sdk": "^1.29.0",
  "axios": "^1.16.0",
  "dotenv": "^17.0.0",
  "fastify": "^5.8.0",
  "open": "^11.0.0",
  "qrcode-pix": "^5.0.0",
  "tsx": "^4.22.0",
  "ulid": "^3.0.0"
},
"devDependencies": {
  "@types/node": "^22.0.0",
  "typescript": "^5.9.0"
}
```

Rodar `npm install` pra atualizar o lockfile:

```bash
npm install
```

- [ ] **Step 2: Criar `Dockerfile` na raiz**

```dockerfile
FROM node:24-alpine

WORKDIR /app

# Install dependencies (camada cacheável)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Volume mount-point pro data dir; Dokploy mapeia volume persistente aqui
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["npm", "start"]
```

- [ ] **Step 3: Criar `.dockerignore` na raiz**

```
node_modules
.git
.gitignore
.env
data
docs
*.log
.DS_Store
.vscode
.idea
README.md
```

- [ ] **Step 4: Deletar `docker-compose.yml`**

```bash
git rm docker-compose.yml
```

- [ ] **Step 5: Typecheck + dry-build da imagem (opcional, se Docker estiver instalado)**

```bash
npx tsc --noEmit
docker build -t slice-bot:test .
```

Expected: typecheck clean; build de imagem OK se Docker presente.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore package.json package-lock.json
git commit -m "chore(deploy): add Dockerfile + .dockerignore; drop docker-compose; promote tsx"
```

---

## Task 13: Runbook manual — setup Meta Business + templates

**Files:**
- Create: `docs/superpowers/runbooks/2026-05-23-meta-setup.md`

Esse runbook é interativo e tem dependências externas (Meta UI, approval de templates). Não tem código pra commit além do próprio runbook, mas as ações descritas são pré-requisito do deploy (Task 15).

- [ ] **Step 1: Criar o runbook**

```markdown
# Meta Business / WhatsApp Cloud API — Setup Runbook

**Pré-requisito:** chip Vivo secundário disponível, NÃO registrado em
WhatsApp consumer nem WhatsApp Business app.

## 1. Criar Meta Business Manager

1. Acesse https://business.facebook.com
2. "Create Account" — usar nome pessoal (Slice) já que é uso individual
3. Confirmar email

## 2. Criar Meta App

1. Acesse https://developers.facebook.com/apps
2. "Create App" → tipo "Business"
3. Vincular ao Business Manager criado acima
4. Em "Add products to your app", adicionar "WhatsApp"

## 3. Registrar o número Vivo no Cloud API

1. WhatsApp → "API Setup"
2. "Add phone number" → digitar o número Vivo (com código do país)
3. Receber código OTP via SMS ou ligação → confirmar
4. **Anotar o `Phone number ID`** (não é o número em si — é um UUID-like
   gerado pelo Meta). Vai no `WHATSAPP_PHONE_NUMBER_ID`.

## 4. Pegar Access Token long-lived

Token temporário (24h) aparece na tela do "API Setup". **Não usar em
produção.** Pra long-lived:

1. Business Settings → System Users → "Add"
2. Criar System User com role Admin
3. Generate token → escolher o App + permissões `whatsapp_business_messaging`
   e `whatsapp_business_management`
4. Token "Never" (permanent) — anotar. Vai no `WHATSAPP_ACCESS_TOKEN`.

## 5. App Secret

1. App → Settings → Basic
2. Copiar "App Secret". Vai no `WHATSAPP_APP_SECRET`.

## 6. Verify Token (você define)

Gerar uma string random — `openssl rand -hex 32` por ex. Vai no
`WHATSAPP_VERIFY_TOKEN`. Vai ser usado também na configuração do webhook
no Meta (passo 8).

## 7. Submeter templates

Acessar Meta Business → WhatsApp Manager → Message Templates → Create.

### Template 1: `bill_partial_paid`
- Category: Utility
- Language: Portuguese (BR)
- Body:
  ```
  💸 {{1}} pagou R$ {{2}} da conta {{3}}. Ainda falta: {{4}}.
  ```
- Example parameters (Meta exige exemplo):
  - {{1}} = Maria
  - {{2}} = 10,00
  - {{3}} = Pizza
  - {{4}} = João

### Template 2: `bill_settled`
- Category: Utility
- Language: Portuguese (BR)
- Body:
  ```
  💸 Fechou a conta {{1}}! Todo mundo já pagou.
  ```
- Example:
  - {{1}} = Pizza

### Template 3: `bill_expired`
- Category: Utility
- Language: Portuguese (BR)
- Body:
  ```
  ⏱️ A conta {{1}} expirou após 7 dias. Pendentes: {{2}}.
  ```
- Example:
  - {{1}} = Pizza
  - {{2}} = Maria, João

Submeter os 3. Aprovação típica: minutos a algumas horas. **Status fica
"In review" → "Approved" ou "Rejected".** Se rejeitado, simplificar copy
(sem markdown, sem emoji) e resubmeter.

## 8. Configurar webhook no Meta

**Após o deploy estar de pé** (Task 15), com a URL pública conhecida:

1. App → WhatsApp → Configuration → Webhook
2. "Callback URL": `https://bot.appslice.com.br/webhooks/whatsapp`
3. "Verify Token": o que você setou no `WHATSAPP_VERIFY_TOKEN`
4. Subscribe to: `messages` (pelo menos)
5. Click "Verify and save" — Meta vai fazer um GET no callback, que deve
   responder com o `hub.challenge` (rota nossa em `whatsapp.webhook.ts`).
   Se a verificação falhar:
   - Webhook URL inalcançável (DNS? Caddy/Traefik?)
   - VERIFY_TOKEN diferente no Meta vs. servidor → conferir env
   - 403 do servidor: checar logs em Dokploy

## 9. Pronto pro deploy

Vars que você deve ter coletado:
- `WHATSAPP_PHONE_NUMBER_ID` — passo 3
- `WHATSAPP_ACCESS_TOKEN` — passo 4
- `WHATSAPP_APP_SECRET` — passo 5
- `WHATSAPP_VERIFY_TOKEN` — passo 6 (você definiu)

Templates aprovados:
- bill_partial_paid
- bill_settled
- bill_expired

Próxima coisa: provisionar VPS (runbook em
`docs/superpowers/runbooks/2026-05-23-vps-setup.md`).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/2026-05-23-meta-setup.md
git commit -m "docs(runbooks): Meta Business and Cloud API setup steps"
```

---

## Task 14: Runbook manual — provisionamento Hetzner + Dokploy

**Files:**
- Create: `docs/superpowers/runbooks/2026-05-23-vps-setup.md`

- [ ] **Step 1: Criar o runbook**

```markdown
# Hetzner VPS + Dokploy Setup Runbook

**Pré-requisito:** conta Hetzner Cloud (`accounts.hetzner.com`), domínio
appslice.com.br já registrado no Registro.br.

## 1. Provisionar VPS

1. Hetzner Cloud Console → Projects → New project "slice"
2. Servers → Add Server:
   - Location: Falkenstein (FSN1) ou Helsinki (HEL1) — ambos têm boa
     latência pra BR
   - Image: Ubuntu 24.04
   - Type: CPX11 (€4,50/mês — 2 vCPU AMD, 2GB RAM, 40GB SSD)
   - SSH key: cole sua public key (`~/.ssh/id_ed25519.pub`)
   - Cloud Firewall: criar novo, abrir só 22/tcp + 80/tcp + 443/tcp
3. Wait 30s → server provisionado. **Anote o IP público.**

## 2. Configurar DNS no Registro.br

Painel do Registro.br → DNS → Edit zone do appslice.com.br:

| Type | Name | Value |
|---|---|---|
| A | bot | `<IP>` |
| A | dokploy | `<IP>` |

Save. Propagação típica 5-30min. Confirme com:
```bash
dig +short bot.appslice.com.br
dig +short dokploy.appslice.com.br
```
Ambos devem retornar o IP.

## 3. Hardening básico

SSH como root inicial:
```bash
ssh root@<IP>
```

Dentro do server:
```bash
# Cria user
adduser slice
usermod -aG sudo slice

# Copia SSH key pro user
mkdir -p /home/slice/.ssh
cp /root/.ssh/authorized_keys /home/slice/.ssh/
chown -R slice:slice /home/slice/.ssh
chmod 700 /home/slice/.ssh
chmod 600 /home/slice/.ssh/authorized_keys

# Desabilita SSH password + root
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# UFW
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Logout do root. Daqui pra frente: `ssh slice@bot.appslice.com.br`.

## 4. Instalar Dokploy

Como user `slice` (com sudo):

```bash
ssh slice@bot.appslice.com.br
# Pegar o comando exato em https://docs.dokploy.com/docs/core (uma linha
# do tipo: curl -sSL https://dokploy.com/install.sh | sh)
curl -sSL https://dokploy.com/install.sh | sudo sh
```

Tempo: ~3min. Instalador sobe Docker + Traefik + Dokploy.

UI fica em `http://<IP>:3000`. Primeiro acesso: criar conta admin (email +
senha forte).

## 5. Amarrar Dokploy admin atrás de domínio TLS

UI Dokploy → Settings → Server → Domains:
- "Add domain": `dokploy.appslice.com.br`
- Save. Traefik vai pegar cert Let's Encrypt automaticamente (~1min)

Testar `https://dokploy.appslice.com.br` — deve carregar UI com TLS válido.

Agora **fechar a porta 3000 no host** (já que UI tá disponível via 443):

```bash
sudo ufw delete allow 3000/tcp 2>/dev/null  # ok se erro (regra não existia)
# Conferir
sudo ufw status
```

## 6. Criar app no Dokploy

UI → Projects → New Project "slice" → Create.
Dentro do projeto: Applications → Add → tipo "Application":

1. Source:
   - Provider: GitHub
   - Conectar conta (OAuth Dokploy ↔ GitHub) se for primeira vez
   - Repo: `DanubioLima/racha-conta-bot`
   - Branch: `main` (vamos mergeear `feat/cloud-deployment` antes do deploy)
2. Build:
   - Type: Dockerfile (Dokploy detecta o arquivo na raiz)
3. Domains:
   - Add: `bot.appslice.com.br` → port 3000 (porta interna do container)
   - HTTPS: enable, Let's Encrypt
4. Environment:
   - Cole as envs (formato `KEY=value` uma por linha):
     ```
     PORT=3000
     PUBLIC_BASE_URL=https://bot.appslice.com.br
     USER_WHATSAPP_NUMBER=5588998082034
     GEMINI_API_KEY=...
     PIX_KEY=...
     PIX_MERCHANT_NAME=...
     PIX_MERCHANT_CITY=...
     LEDGER_SOURCE=cumbuca
     WHATSAPP_PHONE_NUMBER_ID=...
     WHATSAPP_ACCESS_TOKEN=...
     WHATSAPP_APP_SECRET=...
     WHATSAPP_VERIFY_TOKEN=...
     ```
5. Volumes:
   - Mount: `/app/data` → volume nomeado `slice-data` (Dokploy gerencia)
6. Auto Deploy:
   - Toggle on. Dokploy configura webhook no GitHub.

Save settings.

## 7. (Não fazer deploy ainda — falta merge da branch)

Voltar pro fluxo: tarefa final é a Task 15 desse plano.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/2026-05-23-vps-setup.md
git commit -m "docs(runbooks): Hetzner VPS and Dokploy provisioning steps"
```

---

## Task 15: Production deploy + smoke ponta-a-ponta

**Files:** (none — operacional)

Esse task assume Tasks 1-14 completadas, templates do Meta aprovados, e VPS+Dokploy prontos.

- [ ] **Step 1: Mergear branch `feat/cloud-deployment` → `main`**

```bash
git checkout main
git pull --ff-only
git merge --ff-only feat/cloud-deployment
git push
```

(Ou via PR no GitHub, o que matchar o seu workflow.)

- [ ] **Step 2: Confirmar auto-deploy do Dokploy**

UI Dokploy → app → Deployments. Deve ter aparecido um deployment novo após
o push em `main`. Acompanhar Logs:
- Build deve passar (npm ci + Docker layers)
- Container starts; primeira linha do bot deve ser
  `[scanner] starting payment scanner`
- Healthz: `curl https://bot.appslice.com.br/healthz` retorna
  `{"ok":true,"ts":"..."}`

Se o build falhar:
- Build Logs no Dokploy → identificar erro
- Comum: env vars faltando → start falha em `process.exit(1)`. Setar e
  redeploy.

- [ ] **Step 3: Configurar webhook no Meta (passo 8 do runbook Meta)**

Meta Business → WhatsApp → Configuration → Webhook:
- Callback URL: `https://bot.appslice.com.br/webhooks/whatsapp`
- Verify Token: o valor de `WHATSAPP_VERIFY_TOKEN`
- "Verify and save" → Meta faz GET; rota nossa deve responder 200 com
  challenge

Subscribe to `messages` field.

- [ ] **Step 4: Re-pareamento Cumbuca**

```bash
ssh slice@bot.appslice.com.br
docker exec -it $(docker ps -qf "name=slice") npm run cumbuca:link
```

CLI imprime URL de autorização. Abrir no celular ou notebook. Após o
consent no app do banco, callback fecha o flow no servidor; CLI continua
e te pede pra escolher a conta. Tokens persistidos em volume.

- [ ] **Step 5: Smoke ponta-a-ponta**

Do seu WhatsApp principal (5588998082034), mandar mensagem pro número
Vivo (o do bot):

```
Paguei 10 no almoço, divide com Maria, 10 cada
```

Esperado:
1. Webhook do Meta entrega POST na rota do bot
2. Bot valida HMAC, identifica sender = USER_WHATSAPP_NUMBER, processa
3. Gemini extrai bill
4. Bot manda 2 mensagens de volta:
   - Resumo ("Anotei sua conta de R$ 10 em "almoço"...")
   - String PIX da Maria

5. Maria paga PIX real (R$ 10) pra sua conta
6. Scanner detecta na próxima janela de scan (5-15min)
7. Bot manda mensagem de bill fechada ("Fechou a conta..."), via texto
   livre se janela aberta ou via template `bill_settled` se fechada

Logs do bot no Dokploy → app → Logs devem mostrar:
- `[webhook] HMAC ok` (implícito; rejeitaria 401 se falhasse)
- `[webhook] processing { messageId, text }`
- `[bill] createBill from extraction`
- `[whatsapp] sendText →`
- `[scanner] credits returned: 1` (no scan que detectar o PIX)
- `[bill] tryReconcile matched`
- `[bill] bill closed`

- [ ] **Step 6: (Sem commit — operacional)**

Não tem commit nessa task. Mas vale registrar o ✅ em algum lugar
(memória do Claude, status do PR de merge, etc) que o smoke fechou.

---

## Self-review

Cobertura do spec:

| Spec section | Task(s) que implementam |
|---|---|
| §3.2/§3.3 componentes alterados/novos | Tasks 2-12 |
| §4 WhatsApp Cloud API (webhook + outbound + janela + templates) | Tasks 2-6, 13 |
| §5 Refactor OAuth Cumbuca | Tasks 7-8 |
| §6.1 VPS Hetzner | Task 14 |
| §6.2 Dokploy + porta 3000 fechada | Task 14 (passo 5) |
| §6.3 DNS subdomínios | Task 14 (passo 2) |
| §6.4 HTTPS Let's Encrypt | Task 14 (passo 5/6) — Traefik gerencia |
| §6.5 Env vars | Tasks 1, 10, 11 |
| §7.1 Estratégia big-bang com rollback | Implícito em Task 15 |
| §7.2 Migração de dados | Task 14 (volume vazio) — start fresh, OK |
| §7.3 Chip Vivo limpeza | Task 13 (pré-req) |
| §7.4 Cumbuca re-pareamento | Task 15 (passo 4) |
| §8 Operations runbook | Tasks 13 e 14 cobrem o lado manual; deploy/log/restart vivem na UI Dokploy |

Lacunas conscientemente fora de escopo (capturadas em §9 do spec): rename
`racha-conta-bot` → `slice`, deferidos #3/#4 do review do Cumbuca,
SQLite migration, comandos admin via WhatsApp.
