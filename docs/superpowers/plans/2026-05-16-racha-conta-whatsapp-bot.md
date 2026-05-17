# Racha-Conta WhatsApp Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-user WhatsApp bot in Node.js/TypeScript that takes a free-text bill description, generates PIX codes per participant, and reconciles incoming payments from a mocked transaction file.

**Architecture:** Fastify HTTP server exposing one webhook (`POST /webhooks/whatsapp`) plus an in-process background worker that polls a local JSON file simulating Cumbuca incoming transactions. State lives in `data/db.json`. Gemini 2.0 Flash extracts structured bill data from free text. Outbound messages go through Evolution API.

**Tech Stack:** Node.js 24, TypeScript, Fastify, `@google/genai` (Gemini), `qrcode-pix`, `axios`, `dotenv`, `ulid`, `tsx`.

**Plan-level conventions (per user instructions in `INSTRUCTIONS.md`):**
- All schemas, enums, variables and code comments are in English.
- All user-facing WhatsApp messages are in humanized Portuguese.
- **No automated tests** in this MVP. Validation is manual at the end.
- **No git commits** — repo is not initialized. Steps that look like checkpoints just run `tsc --noEmit` to confirm types compile.

---

## File map

| Path | Responsibility |
|------|---------------|
| `package.json` | deps, scripts |
| `tsconfig.json` | TS config |
| `.gitignore` | ignore `data/`, `.env`, `node_modules`, `dist` |
| `.env.example` | env var template |
| `src/server.ts` | Fastify bootstrap + worker boot |
| `src/config/env.ts` | load + validate env vars |
| `src/services/bills/bill.types.ts` | Bill, Participant types + status enums |
| `src/repositories/bill.repository.ts` | read/write `data/db.json` under a mutex |
| `src/services/pix/pix.ts` | build static PIX Copia-e-Cola payloads |
| `src/services/evolution/evolution.ts` | `sendText(to, message)` via Evolution API |
| `src/services/llm/gemini.ts` | `extractBillFromText(text)` via Gemini 2.0 Flash |
| `src/services/bills/bill.service.ts` | orchestrate createBill / matchPayment / closeBill + message templates |
| `src/routes/whatsapp.webhook.ts` | parse Evolution payload, run flow |
| `src/workers/ledger.worker.ts` | tick over `mock/incoming-transactions.json` |
| `src/mock/incoming-transactions.json` | seeded payments for reconciliation |
| `data/db.json` | bills store (created at runtime) |
| `README.md` | how to run |

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: empty directories `src/config`, `src/routes`, `src/services/llm`, `src/services/pix`, `src/services/evolution`, `src/services/bills`, `src/repositories`, `src/workers`, `src/mock`, `data`, `docs`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "racha-conta-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@google/genai": "^1.0.0",
    "axios": "^1.7.0",
    "dotenv": "^16.4.0",
    "fastify": "^5.0.0",
    "qrcode-pix": "^1.0.5",
    "ulid": "^2.3.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules
dist
.env
data/
*.log
.DS_Store
```

- [ ] **Step 4: Create `.env.example`**

```
PORT=3000

# Evolution API
EVOLUTION_API_URL=https://your-evolution-host
EVOLUTION_API_KEY=your-api-key
EVOLUTION_INSTANCE=your-instance-name

# Your own number, where notifications will be sent (E.164 without +, e.g. 5511999999999)
USER_WHATSAPP_NUMBER=

# Gemini
GEMINI_API_KEY=

# PIX (static Copia-e-Cola)
PIX_KEY=
PIX_MERCHANT_NAME=
PIX_MERCHANT_CITY=

# Worker
WORKER_INTERVAL_MS=30000
```

- [ ] **Step 5: Create directory tree**

Run:
```bash
mkdir -p src/config src/routes src/services/llm src/services/pix src/services/evolution src/services/bills src/repositories src/workers src/mock data
```

- [ ] **Step 6: Install dependencies**

Run:
```bash
npm install
```

Expected: dependencies install without errors.

---

## Task 2: Environment config

**Files:**
- Create: `src/config/env.ts`

- [ ] **Step 1: Implement env loader/validator**

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
};
```

- [ ] **Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: passes (no output is success).

---

## Task 3: Bill types and enums

**Files:**
- Create: `src/services/bills/bill.types.ts`

- [ ] **Step 1: Define domain types**

```ts
export type BillStatus = 'OPEN' | 'CLOSED';
export type ParticipantStatus = 'PENDING' | 'PAID';

export interface Participant {
  name: string;
  amount_due: number;
  status: ParticipantStatus;
  pix_payload: string;
  paid_at?: string;
}

export interface Bill {
  id: string;
  description: string;
  total_amount: number;
  amount_per_person: number;
  status: BillStatus;
  created_at: string;
  participants: Participant[];
}

export interface ExtractedBill {
  description: string;
  total_amount: number;
  participants: { name: string; amount_due: number }[];
}

export interface ExtractionResult {
  intent: 'create_bill' | 'unknown';
  bill?: ExtractedBill;
}

export interface IncomingTransaction {
  id: string;
  amount: number;
  payer_name: string;
  occurred_at: string;
  consumed?: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

---

## Task 4: Bill repository (JSON file + mutex)

**Files:**
- Create: `src/repositories/bill.repository.ts`

- [ ] **Step 1: Implement repo**

```ts
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import type { Bill } from '../services/bills/bill.types.js';

const DB_PATH = path.resolve('data/db.json');

interface DbShape {
  bills: Bill[];
}

// Single in-process mutex: queue writes/reads so the worker and the webhook
// route never interleave on the same JSON file.
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function ensureFile(): Promise<void> {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  try {
    await access(DB_PATH);
  } catch {
    const empty: DbShape = { bills: [] };
    await writeFile(DB_PATH, JSON.stringify(empty, null, 2), 'utf8');
  }
}

async function readDb(): Promise<DbShape> {
  await ensureFile();
  const raw = await readFile(DB_PATH, 'utf8');
  return JSON.parse(raw) as DbShape;
}

async function writeDb(db: DbShape): Promise<void> {
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

export const billRepository = {
  list(): Promise<Bill[]> {
    return serialize(async () => (await readDb()).bills);
  },

  insert(bill: Bill): Promise<void> {
    return serialize(async () => {
      const db = await readDb();
      db.bills.push(bill);
      await writeDb(db);
    });
  },

  update(billId: string, mutator: (b: Bill) => void): Promise<Bill | null> {
    return serialize(async () => {
      const db = await readDb();
      const bill = db.bills.find((b) => b.id === billId);
      if (!bill) return null;
      mutator(bill);
      await writeDb(db);
      return bill;
    });
  },

  findOpen(): Promise<Bill[]> {
    return serialize(async () => (await readDb()).bills.filter((b) => b.status === 'OPEN'));
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

---

## Task 5: PIX service

**Files:**
- Create: `src/services/pix/pix.ts`

- [ ] **Step 1: Implement PIX payload builder**

```ts
import { QrCodePix } from 'qrcode-pix';
import { env } from '../../config/env.js';

interface BuildPixArgs {
  amount: number;
  txid: string;
  message?: string;
}

// Returns the Copia-e-Cola string for a static PIX charge.
// Uses the merchant info from env so all charges credit the same account.
export function buildPixPayload({ amount, txid, message }: BuildPixArgs): string {
  const qr = QrCodePix({
    version: '01',
    key: env.pixKey,
    name: env.pixMerchantName,
    city: env.pixMerchantCity,
    transactionId: txid.slice(0, 25),
    message,
    value: Number(amount.toFixed(2)),
  });
  return qr.payload();
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

---

## Task 6: Evolution API client

**Files:**
- Create: `src/services/evolution/evolution.ts`

- [ ] **Step 1: Implement sendText**

```ts
import axios from 'axios';
import { env } from '../../config/env.js';

const client = axios.create({
  baseURL: env.evolutionApiUrl,
  headers: {
    'Content-Type': 'application/json',
    apikey: env.evolutionApiKey,
  },
  timeout: 10_000,
});

export async function sendText(to: string, text: string): Promise<void> {
  try {
    await client.post(`/message/sendText/${env.evolutionInstance}`, {
      number: to,
      text,
    });
  } catch (err) {
    const detail = axios.isAxiosError(err) ? err.response?.data ?? err.message : err;
    console.error('[evolution] sendText failed', detail);
    throw err;
  }
}

// Convenience for the single-user MVP: send to USER_WHATSAPP_NUMBER.
export function notifyUser(text: string): Promise<void> {
  return sendText(env.userWhatsappNumber, text);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

---

## Task 7: Gemini LLM service

**Files:**
- Create: `src/services/llm/gemini.ts`

- [ ] **Step 1: Implement extractBillFromText**

```ts
import { GoogleGenAI, Type } from '@google/genai';
import { env } from '../../config/env.js';
import type { ExtractionResult } from '../bills/bill.types.js';

const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

const SYSTEM_INSTRUCTION = `
Você é um extrator de dados para um bot de racha-conta brasileiro.
Receberá uma mensagem em português onde o usuário descreve uma despesa
e como ela deve ser dividida. Retorne SEMPRE JSON estrito seguindo o schema fornecido.

Regras:
- Moeda: BRL. amount_due e total_amount são números (decimais), nunca strings.
- Se o usuário disser apenas um número de pessoas (ex: "dividir por 4"),
  gere participantes com nomes "Pessoa 1", "Pessoa 2", etc.
- Se o usuário NÃO informar o valor por pessoa, divida total_amount igualmente,
  arredondando para 2 casas. O último participante absorve qualquer sobra de centavos.
- Se a mensagem NÃO parecer uma intenção de criar uma conta para dividir,
  retorne {"intent": "unknown"} e omita o campo bill.
- Não inclua o usuário (a pessoa que enviou a mensagem) entre os participants:
  ele já pagou a conta.
`.trim();

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: ['create_bill', 'unknown'] },
    bill: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING },
        total_amount: { type: Type.NUMBER },
        participants: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              amount_due: { type: Type.NUMBER },
            },
            required: ['name', 'amount_due'],
          },
        },
      },
      required: ['description', 'total_amount', 'participants'],
    },
  },
  required: ['intent'],
};

export async function extractBillFromText(text: string): Promise<ExtractionResult> {
  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  });

  const raw = response.text;
  if (!raw) {
    return { intent: 'unknown' };
  }
  try {
    return JSON.parse(raw) as ExtractionResult;
  } catch (err) {
    console.error('[gemini] failed to parse JSON', { raw, err });
    return { intent: 'unknown' };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

---

## Task 8: Bill service (orchestration + message templates)

**Files:**
- Create: `src/services/bills/bill.service.ts`

- [ ] **Step 1: Implement createBill and matchPayment**

```ts
import { ulid } from 'ulid';
import { billRepository } from '../../repositories/bill.repository.js';
import { buildPixPayload } from '../pix/pix.js';
import { notifyUser } from '../evolution/evolution.js';
import type {
  Bill,
  ExtractedBill,
  IncomingTransaction,
  Participant,
} from './bill.types.js';

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function buildParticipants(extracted: ExtractedBill, billId: string): Participant[] {
  return extracted.participants.map((p, i) => ({
    name: p.name,
    amount_due: Number(p.amount_due.toFixed(2)),
    status: 'PENDING' as const,
    pix_payload: buildPixPayload({
      amount: p.amount_due,
      txid: `${billId.slice(-10)}${i}`,
      message: `Racha: ${extracted.description}`.slice(0, 60),
    }),
  }));
}

function renderCreatedMessage(bill: Bill): string {
  const header = `Anotei sua conta de ${formatBRL(bill.total_amount)} em "${bill.description}". Vou te mandar o PIX de cada um.`;
  const blocks = bill.participants
    .map(
      (p) =>
        `*${p.name}* — ${formatBRL(p.amount_due)}\n` +
        '```' + '\n' + p.pix_payload + '\n' + '```'
    )
    .join('\n\n');
  return `${header}\n\n${blocks}\n\nÉ só repassar pra cada um. Eu te aviso conforme os PIX chegarem aqui.`;
}

function renderPaidMessage(bill: Bill, paid: Participant): string {
  const remaining = bill.participants.filter((p) => p.status === 'PENDING');
  if (remaining.length === 0) {
    return '';
  }
  const names = remaining.map((p) => p.name).join(', ');
  return `${paid.name} acabou de pagar! ${formatBRL(paid.amount_due)} caíram aqui. Ainda falta: ${names}.`;
}

function renderClosedMessage(bill: Bill): string {
  return `Fechou! Todo mundo pagou a conta de "${bill.description}". Saldo zerado 💸`;
}

export async function createBillFromExtraction(extracted: ExtractedBill): Promise<Bill> {
  const id = ulid();
  const amountPerPerson = Number(
    (extracted.total_amount / extracted.participants.length).toFixed(2)
  );

  const bill: Bill = {
    id,
    description: extracted.description,
    total_amount: Number(extracted.total_amount.toFixed(2)),
    amount_per_person: amountPerPerson,
    status: 'OPEN',
    created_at: new Date().toISOString(),
    participants: buildParticipants(extracted, id),
  };

  await billRepository.insert(bill);
  await notifyUser(renderCreatedMessage(bill));
  return bill;
}

interface MatchResult {
  billId: string;
  participantName: string;
}

// Returns the bill+participant that matches, or null if no candidate found.
// Match rules:
//   1. Find an OPEN bill with a PENDING participant whose amount_due === tx.amount.
//   2. If multiple participants match by amount, prefer the one whose name matches
//      (case-insensitive substring) tx.payer_name.
//   3. If still multiple, pick the first PENDING in order.
async function findMatch(tx: IncomingTransaction): Promise<MatchResult | null> {
  const openBills = await billRepository.findOpen();
  for (const bill of openBills) {
    const candidates = bill.participants.filter(
      (p) => p.status === 'PENDING' && Math.abs(p.amount_due - tx.amount) < 0.005
    );
    if (candidates.length === 0) continue;

    const byName = candidates.find((p) => {
      const a = p.name.toLowerCase();
      const b = tx.payer_name.toLowerCase();
      return a.includes(b) || b.includes(a);
    });
    const winner = byName ?? candidates[0];
    return { billId: bill.id, participantName: winner.name };
  }
  return null;
}

export async function tryReconcile(tx: IncomingTransaction): Promise<boolean> {
  const match = await findMatch(tx);
  if (!match) return false;

  const updated = await billRepository.update(match.billId, (b) => {
    const p = b.participants.find((x) => x.name === match.participantName);
    if (!p || p.status === 'PAID') return;
    p.status = 'PAID';
    p.paid_at = new Date().toISOString();
    if (b.participants.every((x) => x.status === 'PAID')) {
      b.status = 'CLOSED';
    }
  });
  if (!updated) return false;

  const paidParticipant = updated.participants.find((x) => x.name === match.participantName);
  if (paidParticipant) {
    const msg = renderPaidMessage(updated, paidParticipant);
    if (msg) await notifyUser(msg);
  }
  if (updated.status === 'CLOSED') {
    await notifyUser(renderClosedMessage(updated));
  }
  return true;
}

export async function notifyUnknown(): Promise<void> {
  await notifyUser(
    'Não consegui entender essa mensagem como uma conta pra dividir. Pode reformular? Ex: "Paguei 60 na pizzaria, dividir com João e Maria, 20 cada."'
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

---

## Task 9: Ledger worker

**Files:**
- Create: `src/workers/ledger.worker.ts`

- [ ] **Step 1: Implement worker tick**

```ts
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { tryReconcile } from '../services/bills/bill.service.js';
import type { IncomingTransaction } from '../services/bills/bill.types.js';

const MOCK_PATH = path.resolve('src/mock/incoming-transactions.json');

async function loadMock(): Promise<IncomingTransaction[]> {
  try {
    await access(MOCK_PATH);
  } catch {
    return [];
  }
  const raw = await readFile(MOCK_PATH, 'utf8');
  return JSON.parse(raw) as IncomingTransaction[];
}

async function saveMock(txs: IncomingTransaction[]): Promise<void> {
  await mkdir(path.dirname(MOCK_PATH), { recursive: true });
  await writeFile(MOCK_PATH, JSON.stringify(txs, null, 2), 'utf8');
}

async function tick(): Promise<void> {
  const txs = await loadMock();
  let dirty = false;
  for (const tx of txs) {
    if (tx.consumed) continue;
    const matched = await tryReconcile(tx);
    if (matched) {
      tx.consumed = true;
      dirty = true;
    }
  }
  if (dirty) await saveMock(txs);
}

export function startLedgerWorker(): void {
  console.log(`[worker] ledger worker starting (interval ${env.workerIntervalMs}ms)`);
  // Run once on boot, then on interval. Errors are caught so the worker survives.
  const safeTick = () =>
    tick().catch((err) => console.error('[worker] tick failed', err));
  void safeTick();
  setInterval(safeTick, env.workerIntervalMs);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

---

## Task 10: Mock seed file

**Files:**
- Create: `src/mock/incoming-transactions.json`

- [ ] **Step 1: Seed the mock with 2 known payments**

```json
[
  {
    "id": "mock-tx-001",
    "amount": 20.00,
    "payer_name": "João",
    "occurred_at": "2026-05-16T12:00:00.000Z",
    "consumed": false
  },
  {
    "id": "mock-tx-002",
    "amount": 20.00,
    "payer_name": "Maria",
    "occurred_at": "2026-05-16T12:05:00.000Z",
    "consumed": false
  }
]
```

**Note for the user during smoke test:** the seeded mock will reconcile if your first bill has João and Maria each owing R$ 20,00. Send `"Paguei 40 reais na pizzaria, dividir entre João e Maria, 20 cada"` to test full closure.

---

## Task 11: WhatsApp webhook route

**Files:**
- Create: `src/routes/whatsapp.webhook.ts`

- [ ] **Step 1: Implement webhook handler**

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { extractBillFromText } from '../services/llm/gemini.js';
import {
  createBillFromExtraction,
  notifyUnknown,
} from '../services/bills/bill.service.js';

// Evolution API MESSAGES_UPSERT payload (only the fields we care about).
interface EvolutionWebhookBody {
  event?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
    };
  };
}

function extractText(body: EvolutionWebhookBody): string | null {
  const msg = body?.data?.message;
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? null;
}

function extractSender(body: EvolutionWebhookBody): string | null {
  const jid = body?.data?.key?.remoteJid;
  if (!jid) return null;
  // remoteJid looks like "5511999999999@s.whatsapp.net"
  return jid.split('@')[0] ?? null;
}

export function registerWhatsAppWebhook(app: FastifyInstance): void {
  app.post('/webhooks/whatsapp', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as EvolutionWebhookBody;

    // Ignore self-sent messages and messages from anyone other than the bot owner.
    if (body?.data?.key?.fromMe) {
      return reply.code(200).send({ ok: true, ignored: 'fromMe' });
    }
    const sender = extractSender(body);
    if (sender !== env.userWhatsappNumber) {
      return reply.code(200).send({ ok: true, ignored: 'unauthorized-sender' });
    }

    const text = extractText(body);
    if (!text) {
      return reply.code(200).send({ ok: true, ignored: 'no-text' });
    }

    // Reply 200 immediately and run the flow in the background so Evolution
    // doesn't retry on slow LLM calls.
    void (async () => {
      try {
        const result = await extractBillFromText(text);
        if (result.intent !== 'create_bill' || !result.bill) {
          await notifyUnknown();
          return;
        }
        await createBillFromExtraction(result.bill);
      } catch (err) {
        console.error('[webhook] flow failed', err);
        try {
          await notifyUnknown();
        } catch {
          // already logged
        }
      }
    })();

    return reply.code(200).send({ ok: true });
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

---

## Task 12: Server bootstrap

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: Wire Fastify + worker**

```ts
import Fastify from 'fastify';
import { env } from './config/env.js';
import { registerWhatsAppWebhook } from './routes/whatsapp.webhook.js';
import { startLedgerWorker } from './workers/ledger.worker.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ ok: true }));
  registerWhatsAppWebhook(app);

  await app.listen({ port: env.port, host: '0.0.0.0' });
  startLedgerWorker();
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Boot smoke test**

Run: `cp .env.example .env`
Then fill in the env values (Evolution URL/key/instance, your WhatsApp number, Gemini key, PIX key).

Run: `npm run dev`
Expected: Fastify logs `Server listening at http://0.0.0.0:3000`, and `[worker] ledger worker starting` appears.

Then in another terminal:
```bash
curl -s http://localhost:3000/health
```
Expected: `{"ok":true}`

Stop the server with Ctrl-C before moving on.

---

## Task 13: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

````markdown
# Racha-Conta WhatsApp Bot (MVP)

Single-user WhatsApp bot that splits a bill from a free-text message,
generates PIX codes per participant, and reconciles incoming payments
from a mocked transaction file.

See `docs/superpowers/specs/2026-05-16-racha-conta-whatsapp-bot-design.md`
for the full design.

## Setup

```bash
npm install
cp .env.example .env
# fill in EVOLUTION_*, USER_WHATSAPP_NUMBER, GEMINI_API_KEY, PIX_*
```

Point your Evolution API instance webhook at `http://<this-host>:3000/webhooks/whatsapp`
and enable the `MESSAGES_UPSERT` event.

## Run

```bash
npm run dev
```

## Smoke test

1. From your own WhatsApp, send:
   `Paguei 40 reais na pizzaria, dividir entre João e Maria, 20 cada.`
2. The bot replies with two PIX Copia-e-Cola codes.
3. The seeded `src/mock/incoming-transactions.json` already contains payments
   from "João" and "Maria" of R$ 20 each. Within `WORKER_INTERVAL_MS` the worker
   should reconcile both and close the bill.
4. To test additional flows, edit `src/mock/incoming-transactions.json` and
   add another entry (the worker re-reads on every tick).

## Storage

State lives in `data/db.json`. Delete it to reset.
````

- [ ] **Step 2: Typecheck (sanity)**

Run: `npm run typecheck`
Expected: passes.

---

## Task 14: End-to-end manual validation

**Files:** none — this is a smoke test.

- [ ] **Step 1: Configure Evolution webhook**

In your Evolution dashboard (or via its API), set the webhook for your instance to
`http://<host>:3000/webhooks/whatsapp` and enable `MESSAGES_UPSERT`.

If you're running locally and Evolution is hosted, use ngrok or similar to expose
port 3000.

- [ ] **Step 2: Reset state**

Run: `rm -f data/db.json`

Also reset the mock if you've already consumed it:
```bash
git checkout src/mock/incoming-transactions.json 2>/dev/null || true
```
(If you're not in git yet, just re-edit `consumed: false` on both entries.)

- [ ] **Step 3: Boot the server**

Run: `npm run dev`

Expected log lines include `Server listening at http://0.0.0.0:3000` and
`[worker] ledger worker starting`.

- [ ] **Step 4: Send the bill from your phone**

From the WhatsApp number set in `USER_WHATSAPP_NUMBER`, message the Evolution
instance:

> Paguei 40 reais na pizzaria, dividir entre João e Maria, 20 cada.

Expected: within a few seconds the bot replies with a humanized message and two
PIX Copia-e-Cola codes (one per participant).

- [ ] **Step 5: Wait for the worker tick**

Within `WORKER_INTERVAL_MS` (default 30 s) you should receive:

1. "João acabou de pagar! R$ 20,00 caíram aqui. Ainda falta: Maria."
2. "Maria acabou de pagar!" — actually the closure message,
   "Fechou! Todo mundo pagou a conta de \"pizzaria\". Saldo zerado 💸"

- [ ] **Step 6: Inspect state**

Run: `cat data/db.json`

Expected: one bill, `status: "CLOSED"`, both participants `status: "PAID"`
with `paid_at` timestamps.

- [ ] **Step 7: Test the unknown-intent path**

From your phone, send something that is not a bill, e.g. `oi tudo bem?`.

Expected: bot replies with the "não entendi, pode reformular" message.

If everything above passes, the MVP is validated.
