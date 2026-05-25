# Multi-User Lite + `mark_paid` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o Slice multi-user com PIX gerado no nome de cada dono e fechamento de bills via marcação manual (`mark_paid`), sem integração bancária pros testers.

**Architecture:** Mantém JSON files (sem SQLite). Adiciona `users.json` + `owner_phone` nas bills. O webhook vira dispatcher por intent (`create_bill` | `register_account` | `mark_paid` | `unknown`) classificado pelo Gemini. PIX deixa de ler env global e passa a usar a chave/nome do dono. Cumbuca fica intocado e dormente; o scanner só reconcilia as bills do Danubio.

**Tech Stack:** Node 24 + TypeScript (ESM, `.js` imports), Fastify, Evolution API (Baileys), `@google/genai` (Gemini), `qrcode-pix`, `ulid`.

**Convenção de verificação (override de TDD):** o projeto **não usa testes automatizados** — decisão consciente do dono, reforçada neste pivot ("simplificar ao extremo"). Cada task verifica com `npx tsc --noEmit` (deve passar limpo) + smoke manual descrito, e commita. Não escrever vitest/jest.

---

## File structure overview

**Novos:**
- `src/repositories/user.repository.ts` — store JSON `data/users.json` (mesmo padrão do `bill.repository`)
- `src/services/users/user.service.ts` — handlers de registro e mensagens de orientação
- `bin/seed-danubio-user.ts` — cria o user Danubio + backfill `owner_phone` (one-shot)

**Modificados:**
- `src/services/bills/bill.types.ts` — `ExtractionResult` vira discriminated union; `Bill.owner_phone`
- `src/services/llm/gemini.ts` — schema com 4 intents; renomeia `extractBillFromText` → `extractIntent`
- `src/services/llm/prompt.ts` — few-shot dos novos intents
- `src/repositories/bill.repository.ts` — `findOpenForOwner`
- `src/services/pix/pix.ts` — `buildPixPayload` recebe chave/nome/cidade do dono
- `src/services/bills/bill.service.ts` — create com owner; `markPaid`; `tryReconcile(tx, ownerPhone)`
- `src/services/whatsapp/whatsapp.ts` — remove echo-cache + `notifyUser`; mantém `sendText`
- `src/routes/whatsapp.webhook.ts` — dispatcher por intent; remove filtro single-user
- `src/workers/payment-scanner.worker.ts` — reconcile só Danubio; expiração notifica o dono
- `src/config/env.ts` — remove `WORKER_INTERVAL_MS` morto

**Intocados:** `services/cumbuca/*`, `services/ledger/*`, `bin/cumbuca-link.ts`, `routes/cumbuca.oauth.ts`.

---

## Task 1: User repository (JSON)

**Files:**
- Create: `src/repositories/user.repository.ts`

- [ ] **Step 1: Criar o repository**

Espelha o padrão de `src/repositories/bill.repository.ts` (mutex in-process + read/write JSON).

```typescript
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

const DB_PATH = path.resolve('data/users.json');

export interface User {
  phone: string;                 // E.164 sem +, normalizado (ver webhook)
  name: string;
  pix_key: string;               // '' enquanto não coletado
  pix_merchant_name: string;     // derivado de name (≤25 chars) quando pix salvo
  pix_merchant_city: string;     // 'BRASIL'
  created_at: string;
}

interface DbShape {
  users: Record<string, User>;
}

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
    await writeFile(DB_PATH, JSON.stringify({ users: {} } satisfies DbShape, null, 2), 'utf8');
  }
}

async function readDb(): Promise<DbShape> {
  await ensureFile();
  return JSON.parse(await readFile(DB_PATH, 'utf8')) as DbShape;
}

async function writeDb(db: DbShape): Promise<void> {
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

export const userRepository = {
  findByPhone(phone: string): Promise<User | null> {
    return serialize(async () => (await readDb()).users[phone] ?? null);
  },
  insert(user: User): Promise<void> {
    return serialize(async () => {
      const db = await readDb();
      db.users[user.phone] = user;
      await writeDb(db);
    });
  },
  update(phone: string, partial: Partial<User>): Promise<User | null> {
    return serialize(async () => {
      const db = await readDb();
      const existing = db.users[phone];
      if (!existing) return null;
      const updated: User = { ...existing, ...partial };
      db.users[phone] = updated;
      await writeDb(db);
      return updated;
    });
  },
};
```

- [ ] **Step 2: Verificar tsc**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/user.repository.ts
git commit -m "feat(users): add JSON-backed user repository"
```

---

## Task 2: Intent types + Gemini schema + prompt

**Files:**
- Modify: `src/services/bills/bill.types.ts`
- Modify: `src/services/llm/gemini.ts`
- Modify: `src/services/llm/prompt.ts`
- Modify: `src/routes/whatsapp.webhook.ts` (só o import/call renomeado)

- [ ] **Step 1: Transformar `ExtractionResult` em discriminated union**

Em `bill.types.ts`, substituir a interface `ExtractionResult` (linhas 32-35) por:

```typescript
export interface RegisterProfile {
  name?: string;
  pix_key?: string;
}

export interface MarkPaidInput {
  name?: string;
  amount?: number;
}

export type ExtractionResult =
  | { intent: 'create_bill'; bill: ExtractedBill }
  | { intent: 'register_account'; profile: RegisterProfile }
  | { intent: 'mark_paid'; payment: MarkPaidInput }
  | { intent: 'unknown' };
```

Manter `ExtractedBill`, `Bill`, `Participant`, `IncomingTransaction` como estão.

- [ ] **Step 2: Atualizar o schema e renomear a função no Gemini**

Em `src/services/llm/gemini.ts`, trocar `RESPONSE_SCHEMA` e renomear `extractBillFromText` → `extractIntent`:

```typescript
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: ["create_bill", "register_account", "mark_paid", "unknown"] },
    bill: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING },
        total_amount: { type: Type.NUMBER },
        headcount: { type: Type.INTEGER },
        participants: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              amount_due: { type: Type.NUMBER },
            },
            required: ["name", "amount_due"],
          },
        },
      },
    },
    profile: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        pix_key: { type: Type.STRING },
      },
    },
    payment: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        amount: { type: Type.NUMBER },
      },
    },
  },
  required: ["intent"],
};

export async function extractIntent(text: string): Promise<ExtractionResult> {
  console.log("[gemini] extracting", { text });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  });

  const raw = response.text;
  console.log("[gemini] raw response", { raw });
  if (!raw) return { intent: "unknown" };
  try {
    const parsed = JSON.parse(raw) as ExtractionResult;
    console.log("[gemini] parsed", parsed);
    return parsed;
  } catch (err) {
    console.error("[gemini] failed to parse JSON", { raw, err });
    return { intent: "unknown" };
  }
}
```

- [ ] **Step 3: Reescrever o system prompt com os 4 intents**

Substituir o conteúdo de `src/services/llm/prompt.ts` por:

```typescript
export const SYSTEM_INSTRUCTION = `
Você é o classificador de intenções de um bot brasileiro de dividir contas no
WhatsApp. Receba UMA mensagem em português e retorne SEMPRE JSON estrito seguindo
o schema. Escolha um "intent" entre: create_bill, register_account, mark_paid, unknown.

== create_bill ==
O usuário descreve uma despesa que ELE JÁ PAGOU e como dividir. Preencha "bill":
- description: estabelecimento/descrição curta.
- total_amount: valor total pago (decimal BRL).
- headcount: total de pessoas no rateio, INCLUINDO o usuário se ele se incluir
  ("eu", "a gente", "nós"). Se não se incluir, só os outros mencionados.
- participants: APENAS as outras pessoas (nunca o usuário). Cada uma:
  - name: nome. "dividir por N" → gere "Pessoa 1".."Pessoa N-1".
  - amount_due: total_amount / headcount (2 casas). Sobra de centavo no último.

== register_account ==
O usuário informa NOME e/ou CHAVE PIX dele. Preencha "profile" com os campos
presentes (pode ser parcial):
- name: nome COMPLETO até um separador natural (vírgula, "e", ponto, "pix").
- pix_key: string após "pix"/"chave pix" (não valide formato).
NUNCA extraia telefone (o bot já tem). "Sou João, pix joao@x.com" → name+pix_key.

== mark_paid ==
O usuário avisa que RECEBEU um pagamento / alguém PAGOU pra ele. Preencha
"payment" com o que houver:
- name: quem pagou ("a Maria me pagou" → name "Maria").
- amount: valor recebido se mencionado ("recebi 20 do João" → name "João", amount 20).

== Direção do dinheiro (desambiguação) ==
"paguei/gastei X" (o usuário gastou) → create_bill.
"fulano pagou / me pagou / recebi de fulano / caiu aqui" (entrou dinheiro) → mark_paid.

== unknown ==
Saudação, mensagem sem dados, ambígua ou lixo → {"intent":"unknown"}.

EXEMPLOS:

"Paguei 60 na pizzaria, dividir com João e Maria, 20 cada"
{"intent":"create_bill","bill":{"description":"Pizzaria","total_amount":60,"headcount":3,"participants":[{"name":"João","amount_due":20},{"name":"Maria","amount_due":20}]}}

"Almoço de 80, dividir por 4"
{"intent":"create_bill","bill":{"description":"Almoço","total_amount":80,"headcount":4,"participants":[{"name":"Pessoa 1","amount_due":20},{"name":"Pessoa 2","amount_due":20},{"name":"Pessoa 3","amount_due":20}]}}

"Sou João Pedro Silva, pix joao@email.com"
{"intent":"register_account","profile":{"name":"João Pedro Silva","pix_key":"joao@email.com"}}

"pix minha-chave-123"
{"intent":"register_account","profile":{"pix_key":"minha-chave-123"}}

"a Maria me pagou"
{"intent":"mark_paid","payment":{"name":"Maria"}}

"recebi 30 do Pedro"
{"intent":"mark_paid","payment":{"name":"Pedro","amount":30}}

"caiu 25 aqui"
{"intent":"mark_paid","payment":{"amount":25}}

"Bom dia, tudo bem?"
{"intent":"unknown"}
`.trim();
```

- [ ] **Step 4: Atualizar o import/call no webhook (sem mudar a lógica ainda)**

Em `src/routes/whatsapp.webhook.ts`, trocar a linha de import (3) e a chamada
(99) pelo novo nome. O resto da lógica de create_bill/unknown continua por
enquanto (o dispatcher completo vem na Task 5):

```typescript
// import (linha 3)
import { extractIntent } from "../services/llm/gemini.js";
```
```typescript
// dentro do void async (linha ~99)
const result = await extractIntent(text);
if (result.intent !== "create_bill") {
  console.log("[webhook] intent não-create_bill, notificando user");
  await notifyUnknown();
  return;
}
await createBillFromExtraction(result.bill);
```

(Após a union, `result.bill` só existe no ramo `create_bill` — o `if` acima
estreita o tipo corretamente.)

- [ ] **Step 5: Verificar tsc**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 6: Smoke manual do Gemini (opcional mas recomendado)**

Run: `npx tsx -e "import('./src/services/llm/gemini.js').then(async m => { for (const t of ['Sou João, pix joao@x.com','a Maria me pagou','paguei 60 na pizza divide com Ana e Beto','oi']) console.log(t, '→', JSON.stringify(await m.extractIntent(t))); })"`
Expected: respectivamente register_account, mark_paid, create_bill, unknown (precisa de `GEMINI_API_KEY` no `.env`).

- [ ] **Step 7: Commit**

```bash
git add src/services/bills/bill.types.ts src/services/llm/gemini.ts src/services/llm/prompt.ts src/routes/whatsapp.webhook.ts
git commit -m "feat(llm): classify register_account and mark_paid intents"
```

---

## Task 3: User service (registro)

**Files:**
- Create: `src/services/users/user.service.ts`

- [ ] **Step 1: Criar o service**

```typescript
import { userRepository, type User } from '../../repositories/user.repository.js';
import { sendText } from '../whatsapp/whatsapp.js';
import type { RegisterProfile } from '../bills/bill.types.js';

function deriveMerchantName(name: string): string {
  return name.trim().slice(0, 25);
}

export async function handleRegistration(
  phone: string,
  profile: RegisterProfile,
): Promise<void> {
  const existing = await userRepository.findByPhone(phone);
  const name = profile.name?.trim();
  const pixKey = profile.pix_key?.trim();

  if (!existing) {
    if (!name) {
      await sendText(
        phone,
        'Pra começar preciso do seu nome. Manda algo tipo "Sou João, pix joao@email.com".',
      );
      return;
    }
    await userRepository.insert({
      phone,
      name,
      pix_key: pixKey ?? '',
      pix_merchant_name: pixKey ? deriveMerchantName(name) : '',
      pix_merchant_city: 'BRASIL',
      created_at: new Date().toISOString(),
    });
    if (!pixKey) {
      await sendText(
        phone,
        `Prazer, ${name}! Agora me manda sua chave PIX (ex: "pix seu@email.com") pra eu poder gerar as cobranças.`,
      );
      return;
    }
    await sendText(
      phone,
      `Tudo certo, ${name}! 🎉 Manda uma conta, ex: "paguei 60 na pizza, divide com Ana e Beto". Quando alguém te pagar, me avisa ("a Ana me pagou").`,
    );
    return;
  }

  // Update de user existente: correção de nome e/ou coleta lazy de PIX.
  const patch: Partial<User> = {};
  if (name) patch.name = name;
  if (pixKey) {
    patch.pix_key = pixKey;
    patch.pix_merchant_name = deriveMerchantName(name ?? existing.name);
  }
  if (Object.keys(patch).length === 0) return;
  await userRepository.update(phone, patch);
  await sendText(
    phone,
    pixKey
      ? 'Chave PIX salva! Agora manda a conta de novo (ex: "paguei 60 na pizza, divide com Ana e Beto").'
      : 'Atualizei seus dados.',
  );
}

export async function requireRegistrationFirst(phone: string): Promise<void> {
  await sendText(
    phone,
    'Olá! Sou o Slice 👋 Antes de dividir contas preciso do seu nome e chave PIX. Manda algo tipo "Sou João, pix joao@email.com".',
  );
}

export async function requirePixFirst(phone: string, name: string): Promise<void> {
  await sendText(
    phone,
    `${name}, antes de criar a conta preciso da sua chave PIX. Responde "pix sua-chave" (ex: "pix joao@email.com").`,
  );
}

export async function notifyUnknown(phone: string, hasUser: boolean): Promise<void> {
  if (!hasUser) {
    await requireRegistrationFirst(phone);
    return;
  }
  await sendText(
    phone,
    'Não entendi 🤔 Pra criar uma conta: "paguei 60 na pizza, divide com Ana e Beto". Pra marcar pago: "a Ana me pagou".',
  );
}
```

> `sendText` já existe em `whatsapp.ts` (assinatura `sendText(to, text)`). O
> service compila mesmo antes de ser plugado no webhook (Task 5).

- [ ] **Step 2: Verificar tsc**

Run: `npx tsc --noEmit`
Expected: sem erros (exports não-usados são OK).

- [ ] **Step 3: Commit**

```bash
git add src/services/users/user.service.ts
git commit -m "feat(users): registration handlers and guidance messages"
```

---

## Task 4: Remover echo-cache do WhatsApp + migrar `notifyUser` → `sendText`

Contexto: o modelo antigo era "user manda mensagem pra si mesmo", então havia
cache (`wasSentByBot`) pra filtrar echoes. No multi-user o bot fica num número
dedicado: inbound de terceiros vem `fromMe=false`, echoes do bot `fromMe=true`.
Filtra-se por `fromMe`. Esta task remove o cache e o `notifyUser` global,
mantendo o comportamento single-user até a Task 5 (ainda manda tudo pro Danubio).

**Files:**
- Modify: `src/services/whatsapp/whatsapp.ts`
- Modify: `src/services/bills/bill.service.ts`
- Modify: `src/workers/payment-scanner.worker.ts`
- Modify: `src/routes/whatsapp.webhook.ts`

- [ ] **Step 1: Enxugar `whatsapp.ts`**

Remover `sentIds`, `sentTexts`, `rememberSentId`, `rememberSentText`,
`wasSentByBot`, `notifyUser`, `notifyUserImage` e as constantes de cache. Manter
só `sendText` e `sendImage`. Resultado:

```typescript
import axios from 'axios';
import { env } from '../../config/env.js';

// Cliente fino do WhatsApp. Provider real é Evolution API + Baileys — quem está
// fora deste módulo fala em termos de "manda uma mensagem".
const client = axios.create({
  baseURL: env.evolutionApiUrl,
  headers: { 'Content-Type': 'application/json', apikey: env.evolutionApiKey },
  timeout: 10_000,
});

export async function sendText(to: string, text: string): Promise<void> {
  const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  console.log('[whatsapp] sendText →', { to, preview });
  try {
    const res = await client.post(`/message/sendText/${env.evolutionInstance}`, { number: to, text });
    console.log('[whatsapp] sendText ok', { id: res.data?.key?.id });
  } catch (err) {
    const detail = axios.isAxiosError(err) ? (err.response?.data ?? err.message) : err;
    console.error('[whatsapp] sendText failed', detail);
    throw err;
  }
}

export async function sendImage(to: string, base64: string, caption?: string): Promise<void> {
  console.log('[whatsapp] sendImage →', { to, caption: caption?.slice(0, 80) ?? '(no caption)' });
  try {
    const res = await client.post(`/message/sendMedia/${env.evolutionInstance}`, {
      number: to, mediatype: 'image', mimetype: 'image/png', media: base64, fileName: 'pix.png', caption,
    });
    console.log('[whatsapp] sendImage ok', { id: res.data?.key?.id });
  } catch (err) {
    const detail = axios.isAxiosError(err) ? (err.response?.data ?? err.message) : err;
    console.error('[whatsapp] sendImage failed', detail);
    throw err;
  }
}
```

- [ ] **Step 2: `bill.service.ts` — trocar `notifyUser` por `sendText` (ainda global)**

Trocar o import (linha 4) e cada chamada `notifyUser(x)` por
`sendText(env.userWhatsappNumber, x)`. Adicionar import do `env`.

```typescript
// imports (topo)
import { sendText } from "../whatsapp/whatsapp.js";
import { env } from "../../config/env.js";
```

Em `sendBillCreatedMessages`: `await notifyUser(...)` → `await sendText(env.userWhatsappNumber, ...)`
(duas ocorrências: a mensagem de resumo e o loop `for (const participant ...)`).
Em `tryReconcile`: `await notifyUser(msg)` → `await sendText(env.userWhatsappNumber, msg)`
e `await notifyUser(renderClosedMessage(updated))` idem.
Em `notifyUnknown`: `await notifyUser(...)` → `await sendText(env.userWhatsappNumber, ...)`.

- [ ] **Step 3: `payment-scanner.worker.ts` — `notifyUser` → `sendText`**

Trocar import (linha 5) `import { notifyUser } ...` por
`import { sendText } from '../services/whatsapp/whatsapp.js';` e adicionar
`import { env } from '../config/env.js';`. Em `expireBillsOlderThanSevenDays`,
trocar `await notifyUser(...)` por `await sendText(env.userWhatsappNumber, ...)`.

- [ ] **Step 4: `whatsapp.webhook.ts` — filtrar echo por `fromMe` (sem cache)**

Trocar o bloco de filtro de echo (linhas ~80-88) por um filtro simples no topo
do handler, e remover o import de `wasSentByBot` (linha 8):

```typescript
// remover: import { wasSentByBot } from "../services/whatsapp/whatsapp.js";

// dentro do handler, logo após ler o body:
if (body?.data?.key?.fromMe) {
  return reply.code(200).send({ ok: true, ignored: "from-me" });
}
```

Manter o resto (filtro `numbersMatch`, extractText) como está — o dispatcher
completo vem na Task 5.

- [ ] **Step 5: Verificar tsc**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/services/whatsapp/whatsapp.ts src/services/bills/bill.service.ts src/workers/payment-scanner.worker.ts src/routes/whatsapp.webhook.ts
git commit -m "refactor(whatsapp): drop self-message echo cache, use explicit recipient"
```

---

## Task 5: Bill domain owner-aware + PIX por dono + webhook dispatcher

O coração do multi-user. Bills ganham dono; PIX usa a chave do dono; `markPaid`
fecha bills manualmente; webhook vira dispatcher.

**Files:**
- Modify: `src/services/bills/bill.types.ts`
- Modify: `src/services/pix/pix.ts`
- Modify: `src/repositories/bill.repository.ts`
- Modify: `src/services/bills/bill.service.ts`
- Modify: `src/routes/whatsapp.webhook.ts`
- Modify: `src/workers/payment-scanner.worker.ts` (call site do `tryReconcile`)

- [ ] **Step 1: `Bill` ganha `owner_phone`**

Em `bill.types.ts`, na interface `Bill`, adicionar:

```typescript
export interface Bill {
  id: string;
  owner_phone: string;
  description: string;
  total_amount: number;
  amount_per_person: number;
  status: BillStatus;
  created_at: string;
  participants: Participant[];
}
```

- [ ] **Step 2: `buildPixPayload` recebe os dados do dono**

Substituir `src/services/pix/pix.ts` por:

```typescript
import { QrCodePix } from 'qrcode-pix';

interface BuildPixArgs {
  amount: number;
  txid: string;
  message?: string;
  key: string;
  merchantName: string;
  merchantCity: string;
}

function buildQrCodePix({ amount, txid, message, key, merchantName, merchantCity }: BuildPixArgs) {
  return QrCodePix({
    version: '01',
    key,
    name: merchantName,
    city: merchantCity,
    transactionId: txid.slice(0, 25),
    message,
    value: Number(amount.toFixed(2)),
  });
}

export function buildPixPayload(args: BuildPixArgs): string {
  return buildQrCodePix(args).payload();
}

export async function buildPixQrPngBase64(args: BuildPixArgs): Promise<string> {
  const dataUrl = await buildQrCodePix(args).base64();
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
```

- [ ] **Step 3: `bill.repository` ganha `findOpenForOwner`**

Em `src/repositories/bill.repository.ts`, adicionar ao objeto `billRepository`
(manter `findOpen` pra expiração global):

```typescript
  findOpenForOwner(ownerPhone: string): Promise<Bill[]> {
    return serialize(async () =>
      (await readDb()).bills.filter((b) => b.status === 'OPEN' && b.owner_phone === ownerPhone),
    );
  },
```

- [ ] **Step 4: `bill.service` — create com owner, `markPaid`, reconcile owner-scoped**

Substituir `src/services/bills/bill.service.ts` por:

```typescript
import { ulid } from "ulid";
import { billRepository } from "../../repositories/bill.repository.js";
import { buildPixPayload } from "../pix/pix.js";
import { sendText } from "../whatsapp/whatsapp.js";
import { notifyNewBillCreated } from "../../workers/payment-scanner.worker.js";
import type { User } from "../../repositories/user.repository.js";
import type {
  Bill,
  ExtractedBill,
  IncomingTransaction,
  MarkPaidInput,
  Participant,
} from "./bill.types.js";

function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function buildParticipants(extracted: ExtractedBill, billId: string, owner: User): Participant[] {
  return extracted.participants.map((p, i) => ({
    name: p.name,
    amount_due: Number(p.amount_due.toFixed(2)),
    status: "PENDING" as const,
    pix_payload: buildPixPayload({
      amount: p.amount_due,
      txid: `${billId.slice(-10)}${i}`,
      message: `Racha: ${extracted.description}`.slice(0, 60),
      key: owner.pix_key,
      merchantName: owner.pix_merchant_name,
      merchantCity: owner.pix_merchant_city,
    }),
  }));
}

async function sendBillCreatedMessages(bill: Bill): Promise<void> {
  const names = bill.participants.map((p) => p.name).join(" e ");
  await sendText(
    bill.owner_phone,
    `Anotei sua conta de ${formatBRL(bill.total_amount)} em "${bill.description}". ` +
      `Cabe ${formatBRL(bill.amount_per_person)} pra cada um. ` +
      `Mando o PIX de cada um (${names}) a seguir.`,
  );
  for (const participant of bill.participants) {
    await sendText(bill.owner_phone, participant.pix_payload);
  }
}

function renderPaidMessage(bill: Bill, paid: Participant): string {
  const remaining = bill.participants.filter((p) => p.status === "PENDING");
  if (remaining.length === 0) return "";
  const names = remaining.map((p) => p.name).join(", ");
  return `${paid.name} acabou de pagar! ${formatBRL(paid.amount_due)} 💰 Ainda falta: ${names}.`;
}

function renderClosedMessage(bill: Bill): string {
  return `Fechou! Todo mundo pagou a conta de "${bill.description}". Saldo zerado 💸`;
}

function pendingListText(prefix: string, openBills: Bill[]): string {
  const pend = openBills.flatMap((b) =>
    b.participants.filter((p) => p.status === "PENDING").map((p) => `${p.name} (${formatBRL(p.amount_due)})`),
  );
  if (pend.length === 0) return "Você não tem nenhuma conta em aberto.";
  return `${prefix}${pend.join(", ")}.`;
}

export async function createBillFromExtraction(extracted: ExtractedBill, owner: User): Promise<Bill> {
  console.log("[bill] createBill from extraction", { owner: owner.phone, extracted });
  const id = ulid();
  const divisor = Math.max(extracted.headcount, extracted.participants.length, 1);
  const amountPerPerson = Number((extracted.total_amount / divisor).toFixed(2));

  const bill: Bill = {
    id,
    owner_phone: owner.phone,
    description: extracted.description,
    total_amount: Number(extracted.total_amount.toFixed(2)),
    amount_per_person: amountPerPerson,
    status: "OPEN",
    created_at: new Date().toISOString(),
    participants: buildParticipants(extracted, id, owner),
  };

  await billRepository.insert(bill);
  console.log("[bill] inserted", { id: bill.id, owner: bill.owner_phone });
  try {
    await sendBillCreatedMessages(bill);
  } catch (sendError) {
    console.error("[bill] sendBillCreatedMessages failed", sendError);
  }
  notifyNewBillCreated();
  return bill;
}

// ---- mark_paid (manual) ----

interface PaidCandidate {
  billId: string;
  participantName: string;
  amountDue: number;
}

function collectCandidates(openBills: Bill[], input: MarkPaidInput): PaidCandidate[] {
  const out: PaidCandidate[] = [];
  const wantName = input.name?.trim().toLowerCase();
  for (const bill of openBills) {
    for (const p of bill.participants) {
      if (p.status !== "PENDING") continue;
      const nameOk = wantName
        ? p.name.toLowerCase().includes(wantName) || wantName.includes(p.name.toLowerCase())
        : true;
      const amountOk = input.amount != null ? Math.abs(p.amount_due - input.amount) < 0.005 : true;
      if (nameOk && amountOk) {
        out.push({ billId: bill.id, participantName: p.name, amountDue: p.amount_due });
      }
    }
  }
  return out;
}

export async function markPaid(ownerPhone: string, input: MarkPaidInput): Promise<void> {
  const openBills = await billRepository.findOpenForOwner(ownerPhone);

  if (!input.name?.trim() && input.amount == null) {
    await sendText(ownerPhone, pendingListText("Quem pagou? Em aberto: ", openBills));
    return;
  }

  const candidates = collectCandidates(openBills, input);
  if (candidates.length === 0) {
    await sendText(ownerPhone, `Não achei ninguém pendente com esse nome/valor. ${pendingListText("Em aberto: ", openBills)}`);
    return;
  }
  if (candidates.length > 1) {
    const list = candidates.map((c) => `${c.participantName} (${formatBRL(c.amountDue)})`).join(", ");
    await sendText(ownerPhone, `Quem pagou? Tenho em aberto: ${list}.`);
    return;
  }

  const match = candidates[0]!;
  const updated = await billRepository.update(match.billId, (b) => {
    const p = b.participants.find((x) => x.name === match.participantName);
    if (!p || p.status === "PAID") return;
    p.status = "PAID";
    p.paid_at = new Date().toISOString();
    if (b.participants.every((x) => x.status === "PAID")) b.status = "CLOSED";
  });
  if (!updated) return;

  if (updated.status === "CLOSED") {
    await sendText(ownerPhone, renderClosedMessage(updated));
    return;
  }
  const paid = updated.participants.find((x) => x.name === match.participantName);
  if (paid) {
    const msg = renderPaidMessage(updated, paid);
    if (msg) await sendText(ownerPhone, msg);
  }
}

// ---- reconcile (Cumbuca, owner-scoped) ----

interface MatchResult {
  billId: string;
  participantName: string;
}

async function findMatch(tx: IncomingTransaction, ownerPhone: string): Promise<MatchResult | null> {
  const openBills = await billRepository.findOpenForOwner(ownerPhone);
  for (const bill of openBills) {
    const candidates = bill.participants.filter(
      (p) => p.status === "PENDING" && Math.abs(p.amount_due - tx.amount) < 0.005,
    );
    if (candidates.length === 0) continue;
    const byName = candidates.find((p) => {
      const a = p.name.toLowerCase();
      const b = tx.payer_name.toLowerCase();
      return a.includes(b) || b.includes(a);
    });
    const winner = byName ?? candidates[0]!;
    return { billId: bill.id, participantName: winner.name };
  }
  return null;
}

export async function tryReconcile(tx: IncomingTransaction, ownerPhone: string): Promise<boolean> {
  const match = await findMatch(tx, ownerPhone);
  if (!match) {
    console.log("[bill] tryReconcile no match", { txId: tx.id, amount: tx.amount, payer: tx.payer_name });
    return false;
  }
  console.log("[bill] tryReconcile matched", { txId: tx.id, ...match });

  const updated = await billRepository.update(match.billId, (b) => {
    const p = b.participants.find((x) => x.name === match.participantName);
    if (!p || p.status === "PAID") return;
    p.status = "PAID";
    p.paid_at = new Date().toISOString();
    if (b.participants.every((x) => x.status === "PAID")) b.status = "CLOSED";
  });
  if (!updated) return false;

  const paid = updated.participants.find((x) => x.name === match.participantName);
  if (paid) {
    const msg = renderPaidMessage(updated, paid);
    if (msg) await sendText(updated.owner_phone, msg);
  }
  if (updated.status === "CLOSED") {
    console.log("[bill] bill closed", { id: updated.id });
    await sendText(updated.owner_phone, renderClosedMessage(updated));
  }
  return true;
}
```

> `notifyUnknown` saiu do `bill.service` (foi pro `user.service`). O `env`
> import some daqui também.

- [ ] **Step 5: Webhook vira dispatcher**

Substituir `src/routes/whatsapp.webhook.ts` por:

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { extractIntent } from "../services/llm/gemini.js";
import { createBillFromExtraction, markPaid } from "../services/bills/bill.service.js";
import {
  handleRegistration,
  requireRegistrationFirst,
  requirePixFirst,
  notifyUnknown,
} from "../services/users/user.service.js";
import { userRepository } from "../repositories/user.repository.js";

interface EvolutionWebhookBody {
  event?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: { conversation?: string; extendedTextMessage?: { text?: string } };
  };
}

function extractText(body: EvolutionWebhookBody): string | null {
  const msg = body?.data?.message;
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? null;
}

// Brazilian "nono dígito": normaliza 13→12 dígitos pra a chave do user ficar
// estável entre variações de número.
function normalizeBrNumber(num: string): string {
  const digits = num.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("55") && digits[4] === "9") {
    return digits.slice(0, 4) + digits.slice(5);
  }
  return digits;
}

function extractSender(body: EvolutionWebhookBody): string | null {
  const jid = body?.data?.key?.remoteJid;
  if (!jid) return null;
  const raw = jid.split("@")[0];
  return raw ? normalizeBrNumber(raw) : null;
}

export function registerWhatsAppWebhook(app: FastifyInstance): void {
  app.post("/webhooks/whatsapp", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as EvolutionWebhookBody;
    console.log("[webhook] event", {
      event: body?.event,
      fromMe: body?.data?.key?.fromMe,
      remoteJid: body?.data?.key?.remoteJid,
    });

    // Echoes do próprio bot chegam com fromMe=true — ignora.
    if (body?.data?.key?.fromMe) {
      return reply.code(200).send({ ok: true, ignored: "from-me" });
    }

    const senderPhone = extractSender(body);
    if (!senderPhone) return reply.code(200).send({ ok: true, ignored: "no-sender" });

    const text = extractText(body);
    if (!text) return reply.code(200).send({ ok: true, ignored: "no-text" });

    // Responde 200 já e roda o fluxo em background (Evolution não re-tenta).
    void (async () => {
      try {
        const user = await userRepository.findByPhone(senderPhone);
        const result = await extractIntent(text);
        switch (result.intent) {
          case "register_account":
            await handleRegistration(senderPhone, result.profile);
            break;
          case "create_bill":
            if (!user) { await requireRegistrationFirst(senderPhone); break; }
            if (!user.pix_key) { await requirePixFirst(senderPhone, user.name); break; }
            await createBillFromExtraction(result.bill, user);
            break;
          case "mark_paid":
            if (!user) { await requireRegistrationFirst(senderPhone); break; }
            await markPaid(senderPhone, result.payment);
            break;
          default:
            await notifyUnknown(senderPhone, !!user);
        }
        console.log("[webhook] flow finished ok");
      } catch (err) {
        console.error("[webhook] flow failed", err);
      }
    })();

    return reply.code(200).send({ ok: true });
  });
}
```

- [ ] **Step 6: Atualizar o call site do `tryReconcile` no scanner**

Em `src/workers/payment-scanner.worker.ts`, a chamada `await tryReconcile(transaction)`
(linha ~121) vira `await tryReconcile(transaction, env.userWhatsappNumber)`. (O
`env` já foi importado na Task 4.) Isso já escopa a reconciliação às bills do
Danubio — o refino da expiração vem na Task 6.

- [ ] **Step 7: Verificar tsc**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 8: Smoke manual (dev local)**

Subir `npm run dev`, e de um número NOVO (não-registrado) mandar pro bot:
1. "oi" → bot pede nome + PIX
2. "Sou Tester, pix tester@x.com" → bot confirma registro
3. "paguei 60 na pizza divide com Ana e Beto" → bot manda resumo + 2 PIX copia-e-cola (no nome "Tester")
4. "a Ana me pagou" → bot: "Ana acabou de pagar! ... Ainda falta: Beto."
5. "o Beto pagou" → bot: "Fechou! ... Saldo zerado 💸"

Conferir no `data/users.json` o user e em `data/db.json` a bill com `owner_phone`.

- [ ] **Step 9: Commit**

```bash
git add src/services/bills/bill.types.ts src/services/pix/pix.ts src/repositories/bill.repository.ts src/services/bills/bill.service.ts src/routes/whatsapp.webhook.ts src/workers/payment-scanner.worker.ts
git commit -m "feat(bills): multi-user owner-scoped bills, per-owner PIX, mark_paid, intent dispatcher"
```

---

## Task 6: Scanner multi-user — expiração notifica o dono

Reconciliação já está escopada (Task 5). Falta a expiração: hoje varre todas as
bills e notifica `env.userWhatsappNumber` fixo — no multi-user precisa notificar
o dono de cada bill.

**Files:**
- Modify: `src/workers/payment-scanner.worker.ts`

- [ ] **Step 1: Expiração notifica `bill.owner_phone`**

Em `expireBillsOlderThanSevenDays`, trocar a notificação global pelo dono da bill:

```typescript
    console.log('[scanner] expired bill', { id: expired.id, description: expired.description });
    await sendText(
      expired.owner_phone,
      pending.length > 0
        ? `⏱️ Conta "${expired.description}" expirou após 7 dias. Pendentes: ${pendingNames}.`
        : `⏱️ Conta "${expired.description}" expirou após 7 dias.`,
    );
```

(A reconciliação continua varrendo `findOpen()` pra computar `sinceISO`, o que é
inofensivo — só amplia a janela Cumbuca. O match em si já é Danubio-scoped via
`tryReconcile(tx, env.userWhatsappNumber)`.)

- [ ] **Step 2: Verificar tsc**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/workers/payment-scanner.worker.ts
git commit -m "fix(scanner): expiration notifies bill owner, not the fixed env number"
```

---

## Task 7: env cleanup + seed do Danubio

**Files:**
- Modify: `src/config/env.ts`
- Create: `bin/seed-danubio-user.ts`
- Modify: `package.json` (script)

- [ ] **Step 1: Remover `WORKER_INTERVAL_MS` morto**

Em `src/config/env.ts`, remover a linha `workerIntervalMs: ...` (37) do objeto
`env` (a var não é mais lida por ninguém — o scanner usa cadência própria).

- [ ] **Step 2: Script de seed**

`bin/seed-danubio-user.ts` — cria o user Danubio a partir das env vars atuais e
faz backfill de `owner_phone` nas bills existentes. Idempotente.

```typescript
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { userRepository } from '../src/repositories/user.repository.js';
import type { Bill } from '../src/services/bills/bill.types.js';

async function main() {
  const phone = env.userWhatsappNumber.replace(/\D/g, '');

  const existing = await userRepository.findByPhone(phone);
  if (!existing) {
    await userRepository.insert({
      phone,
      name: env.pixMerchantName,
      pix_key: env.pixKey,
      pix_merchant_name: env.pixMerchantName.slice(0, 25),
      pix_merchant_city: env.pixMerchantCity,
      created_at: new Date().toISOString(),
    });
    console.log('[seed] created Danubio user', phone);
  } else {
    console.log('[seed] Danubio user already exists', phone);
  }

  // Backfill owner_phone nas bills sem dono.
  const dbPath = path.resolve('data/db.json');
  const db = JSON.parse(await readFile(dbPath, 'utf8')) as { bills: Bill[] };
  let changed = 0;
  for (const bill of db.bills) {
    if (!bill.owner_phone) { bill.owner_phone = phone; changed++; }
  }
  if (changed > 0) {
    await writeFile(dbPath, JSON.stringify(db, null, 2), 'utf8');
    console.log(`[seed] backfilled owner_phone on ${changed} bill(s)`);
  } else {
    console.log('[seed] no bills needed backfill');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Script no package.json**

Adicionar em `"scripts"`: `"seed:danubio": "tsx bin/seed-danubio-user.ts"`.

- [ ] **Step 4: Verificar tsc**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 5: Rodar o seed local e conferir**

Run: `npm run seed:danubio`
Expected: cria o user em `data/users.json` e backfilla as bills. Re-rodar não duplica.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts bin/seed-danubio-user.ts package.json
git commit -m "chore(env): drop dead WORKER_INTERVAL_MS; add Danubio seed script"
```

---

## Task 8 (HUMAN-DRIVEN): Deploy + seed + smoke em produção

Não é code — checklist operacional pro Danubio.

- [ ] **Step 1: Garantir número dedicado do bot**

O bot precisa estar pareado num número dedicado (chip secundário), não no número
pessoal do Danubio — senão terceiros não conseguem mandar mensagem pro bot.
Confirmar pareamento Baileys ativo na instância Evolution.

- [ ] **Step 2: Push + deploy**

`git push origin feat/multiuser-lite-validation` → merge/deploy via Dokploy
(ou push direto em `main` conforme o fluxo atual).

- [ ] **Step 3: Rodar o seed em produção**

`docker exec slice_bot npm run seed:danubio` — cria o user Danubio e backfilla
as bills existentes com `owner_phone`.

- [ ] **Step 4: Smoke com 1-2 pessoas reais**

De um número de terceiro: registro → cria bill → confere PIX no nome do tester →
`mark_paid` fecha. Do número do Danubio: confere que o fluxo dele segue
funcionando (e que o scanner Cumbuca, se ativo, só fecha as bills dele).

---

## Self-review

| Requisito do spec | Task |
|---|---|
| §3.1 `users.json` repository | Task 1 |
| §3.2 `owner_phone` + `findOpenForOwner` | Task 5 |
| §3.3 migration/seed | Task 7 |
| §4 intent dispatcher (4 intents) | Task 2 (classificação) + Task 5 (dispatch) |
| §4.2 prompt Gemini | Task 2 |
| §5 auto-registro mínimo | Task 3 (handlers) + Task 5 (wiring) |
| §6 mark_paid | Task 5 |
| §7.1 canal Baileys / fromMe / sem cache | Task 4 |
| §7.2 PIX por owner | Task 5 |
| §7.3 scanner owner-scoped + expiração por dono | Task 5 (reconcile) + Task 6 (expiração) |
| §8 env cleanup | Task 7 |

**Placeholder scan:** sem TBD/TODO; todo step tem código ou comando concreto.

**Type consistency:** `extractIntent` (Task 2) usado no webhook (Task 5);
`ExtractionResult` union com `bill`/`profile`/`payment` casa com o consumo no
dispatcher; `User` (Task 1) consumido por `bill.service`/`user.service`;
`createBillFromExtraction(extracted, owner)`, `markPaid(ownerPhone, input)`,
`tryReconcile(tx, ownerPhone)` consistentes entre definição (Task 5) e call
sites (webhook Task 5, scanner Task 5/6); `MarkPaidInput`/`RegisterProfile`
definidos em Task 2 e usados em Tasks 3/5.
