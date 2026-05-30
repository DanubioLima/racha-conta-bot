# Fase 1 — Harness de testes integrados + caracterização — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Montar a rede de regressão (vitest + testes de integração dos fluxos críticos) ANTES de a Fase 2 (Nível 1.5) mexer no caminho do dinheiro/conversa — sem mudar comportamento.

**Architecture:** Adiciona vitest. Extrai a lógica de despacho do webhook numa função testável `dispatchIncomingMessage(senderPhone, text)`. Testes usam SQLite real efêmero (`:memory:` via `SLICE_DB_PATH`), com Gemini (`extractIntent`), WhatsApp (`sendText`) e o worker de reconciliação stubados. Asserta mensagens enviadas + estado do banco. Padrão ARRANGE/ACT/ASSERT.

**Tech Stack:** Node ≥20 + TypeScript (ESM, imports com `.js`), better-sqlite3, **vitest** (novo).

**Convenção:** TDD agora vale (o projeto passa a ter testes — ver decisão na memória). Gate de cada task: `npx tsc --noEmit` limpo **+** `npm test` verde.

**Spec:** [`docs/superpowers/specs/2026-05-30-integration-test-harness-design.md`](../specs/2026-05-30-integration-test-harness-design.md)

---

## File structure overview

**Novos:**
- `vitest.config.ts` — config + env de teste (inclui dummies das env vars obrigatórias, senão `env.ts` faz `process.exit`).
- `test/setup.ts` — `resetDb()` + builders (`registerUser`, `insertOpenBill`).
- `test/db-harness.test.ts` — sanity do harness (banco efêmero + reset).
- `src/services/dispatch/dispatch-message.ts` — `dispatchIncomingMessage` (lógica extraída do webhook).
- `test/money-flows.test.ts` — caracterização: create_bill, mark_paid, list_bills.
- `test/registration-and-conversation.test.ts` — caracterização: registro, unknown/fallback, instabilidade.

**Modificados:**
- `package.json` — devDep `vitest` + scripts `test`.
- `src/repositories/db.ts` — caminho via `SLICE_DB_PATH`.
- `src/routes/whatsapp.webhook.ts` — passa a só parsear + chamar `dispatchIncomingMessage`.

---

## Task 1: vitest + DB efêmero + harness base

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`, `test/setup.ts`, `test/db-harness.test.ts`
- Modify: `src/repositories/db.ts`

- [ ] **Step 1: Instalar vitest e adicionar scripts**

Run: `npm install -D vitest`
Depois, em `package.json`, no bloco `"scripts"`, adicionar:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 2: `db.ts` — caminho por env (default inalterado)**

Substituir as linhas 5-10 atuais:

```typescript
const DATA_DIR = path.resolve('data');
const DB_PATH = path.join(DATA_DIR, 'slice.db');

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
```

por:

```typescript
const DATA_DIR = path.resolve('data');
const DB_PATH = process.env.SLICE_DB_PATH ?? path.join(DATA_DIR, 'slice.db');

// Em teste o banco é ':memory:' (sem diretório). Em prod, garante a pasta do arquivo.
if (DB_PATH !== ':memory:') {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

export const db = new Database(DB_PATH);
```

(Prod sem `SLICE_DB_PATH` → mesmo `data/slice.db`, mesmo mkdir. Comportamento idêntico.)

- [ ] **Step 3: `vitest.config.ts`** (novo)

As env vars obrigatórias precisam existir ANTES de qualquer módulo carregar (`env.ts` faz `process.exit` se faltar) — por isso vão em `test.env`, não no setup (imports são hoisted).

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    env: {
      SLICE_DB_PATH: ':memory:',
      EVOLUTION_API_URL: 'http://localhost:8080',
      EVOLUTION_API_KEY: 'test',
      EVOLUTION_INSTANCE: 'test',
      USER_WHATSAPP_NUMBER: '550000000000',
      GEMINI_API_KEY: 'test',
      PIX_KEY: 'test@pix.com',
      PIX_MERCHANT_NAME: 'Test',
      PIX_MERCHANT_CITY: 'BRASIL',
      LEDGER_SOURCE: 'mock',
    },
  },
});
```

- [ ] **Step 4: `test/setup.ts`** (novo) — reset + builders

```typescript
import { db } from '../src/repositories/db.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { billRepository } from '../src/repositories/bill.repository.js';
import type { Bill } from '../src/services/bills/bill.types.js';

// Ordem respeita FK: participants → bills → users.
export function resetDb(): void {
  db.exec(
    'DELETE FROM participants; DELETE FROM bills; DELETE FROM users; ' +
      'DELETE FROM processed_transactions; DELETE FROM unknown_intents;',
  );
}

export async function registerUser(
  phone: string,
  opts: { name?: string; pixKey?: string } = {},
): Promise<void> {
  const name = opts.name ?? 'Ana';
  const pixKey = opts.pixKey ?? 'ana@email.com';
  await userRepository.insert({
    phone,
    name,
    pix_key: pixKey,
    pix_merchant_name: pixKey ? name.slice(0, 25) : '',
    pix_merchant_city: 'BRASIL',
    created_at: '2026-05-30T00:00:00Z',
  });
}

// Insere uma bill OPEN direto (sem passar pelo service/worker). pix_payload é um
// placeholder — os testes que dependem dele arranjam via create_bill real.
export async function insertOpenBill(
  ownerPhone: string,
  opts: {
    id: string;
    description: string;
    total: number;
    participants: { name: string; amount_due: number; status?: 'PENDING' | 'PAID' }[];
  },
): Promise<void> {
  const bill: Bill = {
    id: opts.id,
    owner_phone: ownerPhone,
    description: opts.description,
    total_amount: opts.total,
    amount_per_person: opts.participants[0]?.amount_due ?? 0,
    status: 'OPEN',
    created_at: '2026-05-30T00:00:00Z',
    participants: opts.participants.map((p) => ({
      name: p.name,
      amount_due: p.amount_due,
      status: p.status ?? 'PENDING',
      pix_payload: `pix-${p.name}`,
    })),
  };
  await billRepository.insert(bill);
}
```

- [ ] **Step 5: Escrever o teste de sanity do harness** (`test/db-harness.test.ts`)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { userRepository } from '../src/repositories/user.repository.js';
import { resetDb } from './setup.js';

beforeEach(() => resetDb());

describe('harness — banco efêmero', () => {
  it('insere e lê via repositório, e resetDb limpa', async () => {
    // ARRANGE
    await userRepository.insert({
      phone: '558800000000', name: 'Teste', pix_key: 'x@y.com',
      pix_merchant_name: 'Teste', pix_merchant_city: 'BRASIL', created_at: '2026-05-30T00:00:00Z',
    });

    // ACT
    const found = await userRepository.findByPhone('558800000000');

    // ASSERT
    expect(found?.name).toBe('Teste');

    // ACT — reset
    resetDb();

    // ASSERT
    expect(await userRepository.findByPhone('558800000000')).toBeNull();
  });
});
```

- [ ] **Step 6: Rodar e verificar**

Run: `npx tsc --noEmit` → limpo.
Run: `npm test` → 1 arquivo, 1 teste, PASS. (Prova que `:memory:` + schema + repos + reset funcionam.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts test/setup.ts test/db-harness.test.ts src/repositories/db.ts
git commit -m "$(printf 'test: vitest + harness (DB :memory:, reset, builders)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Extrair `dispatchIncomingMessage` (refactor behavior-preserving)

**Files:**
- Create: `src/services/dispatch/dispatch-message.ts`
- Modify: `src/routes/whatsapp.webhook.ts`

- [ ] **Step 1: Criar `dispatch-message.ts`** com a lógica de hoje da IIFE (recorte literal, `senderPhone`/`text` viram parâmetros)

```typescript
import { extractIntent, GeminiUnavailableError } from "../llm/gemini.js";
import { createBillFromExtraction, markPaid, listOpenBills } from "../bills/bill.service.js";
import { handleRegistration } from "../users/user.service.js";
import { userRepository } from "../../repositories/user.repository.js";
import { unknownIntentsRepository } from "../../repositories/unknown-intents.repository.js";
import { sendText } from "../whatsapp/whatsapp.js";
import { fallbackReply, instability, askToRegister, askForPix } from "../messaging/voice.js";
import type { ExtractionResult } from "../bills/bill.types.js";

export async function dispatchIncomingMessage(senderPhone: string, text: string): Promise<void> {
  const user = await userRepository.findByPhone(senderPhone);
  const ctx = { registered: !!user, hasPix: !!user?.pix_key, name: user?.name ?? "" };

  // Extração isolada: Gemini fora (503) ou erro inesperado → instabilidade, não silêncio.
  let result: ExtractionResult;
  try {
    result = await extractIntent(text, ctx);
  } catch (err) {
    if (err instanceof GeminiUnavailableError) {
      console.warn("[dispatch] gemini unavailable, sending instability message");
    } else {
      console.error("[dispatch] extraction failed", err);
    }
    try {
      await sendText(senderPhone, instability());
    } catch (sendErr) {
      console.error("[dispatch] failed to send instability message", sendErr);
    }
    return;
  }

  try {
    switch (result.intent) {
      case "register_account":
        if (!result.profile?.name && !result.profile?.pix_key) {
          await sendText(senderPhone, fallbackReply({ registered: !!user }));
          break;
        }
        await handleRegistration(senderPhone, result.profile);
        break;

      case "create_bill": {
        if (!result.bill) { await sendText(senderPhone, fallbackReply({ registered: !!user })); break; }
        // Intent misto: só auto-registra quem está incompleto; conta vence o resto.
        let owner = user;
        if (result.profile && (!owner || !owner.pix_key)) {
          await handleRegistration(senderPhone, result.profile, { continueToBill: true });
          owner = await userRepository.findByPhone(senderPhone);
        }
        if (!owner) { await sendText(senderPhone, askToRegister()); break; }
        if (!owner.pix_key) { await sendText(senderPhone, askForPix(owner.name)); break; }
        await createBillFromExtraction(result.bill, owner);
        break;
      }

      case "mark_paid":
        if (!user) { await sendText(senderPhone, askToRegister()); break; }
        await markPaid(senderPhone, result.payment ?? {});
        break;

      case "list_bills":
        if (!user) { await sendText(senderPhone, askToRegister()); break; }
        await listOpenBills(senderPhone);
        break;

      default: {
        const softReply = result.intent === "unknown" ? result.reply?.trim() : undefined;
        if (softReply && softReply.length <= 300) {
          await sendText(senderPhone, softReply);
        } else {
          await unknownIntentsRepository.record({ phone: senderPhone, text, registered: !!user });
          console.log("[unknown-intent recorded]", { phone: senderPhone, textLen: text.length });
          await sendText(senderPhone, fallbackReply({ registered: !!user }));
        }
      }
    }
    console.log("[dispatch] flow finished ok");
  } catch (err) {
    console.error("[dispatch] flow failed", err);
  }
}
```

- [ ] **Step 2: Enxugar `whatsapp.webhook.ts`** — substituir o arquivo inteiro por:

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { normalizeBrNumber } from "../lib/phone.js";
import { dispatchIncomingMessage } from "../services/dispatch/dispatch-message.js";

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
    void dispatchIncomingMessage(senderPhone, text).catch((err) =>
      console.error("[webhook] dispatch failed", err),
    );

    return reply.code(200).send({ ok: true });
  });
}
```

- [ ] **Step 3: Verificar**

Run: `npx tsc --noEmit` → limpo.
Run: `npm test` → o teste de sanity (Task 1) ainda passa (o refactor não toca o harness).

- [ ] **Step 4: Commit**

```bash
git add src/services/dispatch/dispatch-message.ts src/routes/whatsapp.webhook.ts
git commit -m "$(printf 'refactor(webhook): extrai dispatchIncomingMessage (testável)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Caracterização — fluxos de dinheiro (`test/money-flows.test.ts`)

**Files:**
- Create: `test/money-flows.test.ts`

- [ ] **Step 1: Escrever o arquivo de teste** (header de mocks + casos create_bill, mark_paid, list_bills)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Captura de mensagens enviadas (hoisted pra o factory do vi.mock alcançar).
const { sentMessages } = vi.hoisted(() => ({ sentMessages: [] as { to: string; text: string }[] }));

vi.mock('../src/services/whatsapp/whatsapp.js', () => ({
  sendText: vi.fn(async (to: string, text: string) => { sentMessages.push({ to, text }); }),
  sendImage: vi.fn(),
}));
// Neutraliza o worker de reconciliação (timers/cumbuca) que createBillFromExtraction aciona.
vi.mock('../src/workers/payment-scanner.worker.js', () => ({ notifyNewBillCreated: vi.fn() }));
// Stub só do extractIntent; mantém o resto real (GeminiUnavailableError etc.).
vi.mock('../src/services/llm/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llm/gemini.js')>();
  return { ...actual, extractIntent: vi.fn() };
});

import { extractIntent } from '../src/services/llm/gemini.js';
import { dispatchIncomingMessage } from '../src/services/dispatch/dispatch-message.js';
import { billRepository } from '../src/repositories/bill.repository.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { askToRegister, askForPix } from '../src/services/messaging/voice.js';
import { resetDb, registerUser, insertOpenBill } from './setup.js';

const extractIntentMock = vi.mocked(extractIntent);
const PHONE = '558899990000';

beforeEach(() => {
  resetDb();
  sentMessages.length = 0;
  extractIntentMock.mockReset();
});

describe('create_bill', () => {
  it('cria conta de 2 pessoas e gera 1 PIX por participante', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: 'ana@email.com' });
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Pizza', total_amount: 60, headcount: 3,
        participants: [{ name: 'Beto', amount_due: 20 }, { name: 'Carla', amount_due: 20 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 60 na pizza, divide com Beto e Carla');

    // ASSERT
    const bills = await billRepository.findOpenForOwner(PHONE);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.participants).toHaveLength(2);
    expect(sentMessages[0]!.text).toContain('Te mando o PIX de Beto e Carla');
    expect(sentMessages.filter((m) => /br\.gov\.bcb\.pix/i.test(m.text))).toHaveLength(2);
    // headline não vaza PIX
    expect(sentMessages[0]!.text).not.toMatch(/br\.gov\.bcb\.pix/i);
  });

  it('conta de 1 participante usa singular no headline (sem "(João)")', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Sorvete', total_amount: 10, headcount: 2,
        participants: [{ name: 'João', amount_due: 5 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 10 no sorvete, divide com o João');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Te mando o PIX de João');
    expect(sentMessages[0]!.text).not.toContain('(João)');
  });

  it('descrição vazia não gera " em " no headline', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: '', total_amount: 20, headcount: 2,
        participants: [{ name: 'João', amount_due: 10 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'divide uma conta de 20 com o joão');

    // ASSERT
    expect(sentMessages[0]!.text).not.toContain(' em ');
    expect(sentMessages[0]!.text).toContain('Anotei: R$');
  });

  it('não cadastrado → pede cadastro, não cria conta', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Bar', total_amount: 40, headcount: 2,
        participants: [{ name: 'João', amount_due: 20 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 40 no bar, divide com o joão');

    // ASSERT
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toBe(askToRegister());
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });

  it('cadastrado sem PIX → pede a chave PIX', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana', pixKey: '' });
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Bar', total_amount: 40, headcount: 2,
        participants: [{ name: 'João', amount_due: 20 }] },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 40 no bar, divide com o joão');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(askForPix('Ana'));
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });

  it('intent misto (nome embutido, sem PIX) → registra nome e pede PIX', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Sorvete', total_amount: 10, headcount: 2,
        participants: [{ name: 'João', amount_due: 5 }] },
      profile: { name: 'Daiane' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'Sou Daiane e paguei 10 no sorvete, divide com o joão');

    // ASSERT
    expect((await userRepository.findByPhone(PHONE))?.name).toBe('Daiane');
    expect(sentMessages.at(-1)!.text).toBe(askForPix('Daiane'));
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });
});

describe('mark_paid', () => {
  it('paga 1 de 2 pendentes → bill segue aberta', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40,
      participants: [{ name: 'Beto', amount_due: 20 }, { name: 'Carla', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'mark_paid', payment: { name: 'Beto' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'o Beto me pagou');

    // ASSERT
    const bills = await billRepository.findOpenForOwner(PHONE);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.participants.find((p) => p.name === 'Beto')!.status).toBe('PAID');
    expect(sentMessages[0]!.text).toContain('Beto pagou');
  });

  it('paga o último pendente → fecha a conta', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40,
      participants: [{ name: 'Beto', amount_due: 20, status: 'PAID' }, { name: 'Carla', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'mark_paid', payment: { name: 'Carla' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'a Carla me pagou');

    // ASSERT
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0); // não está mais OPEN
    expect(sentMessages[0]!.text).toContain('Fechou!');
  });

  it('nome ambíguo (casa mais de um) → pergunta quem pagou', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Bar', total: 40,
      participants: [{ name: 'Ana', amount_due: 20 }, { name: 'Ana Paula', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'mark_paid', payment: { name: 'ana' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'a ana me pagou');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Quem pagou?');
  });
});

describe('list_bills', () => {
  it('lista contas abertas no formato compacto', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 60,
      participants: [{ name: 'Beto', amount_due: 20 }, { name: 'Carla', amount_due: 20 }] });
    extractIntentMock.mockResolvedValue({ intent: 'list_bills' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'liste contas em aberto');

    // ASSERT
    expect(sentMessages[0]!.text).toContain('Suas contas em aberto:');
    expect(sentMessages[0]!.text).toContain('Pizza — R$ 60,00 (faltam 2: Beto, Carla)');
  });

  it('sem contas abertas → mensagem de vazio', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({ intent: 'list_bills' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'minhas contas');

    // ASSERT
    expect(sentMessages[0]!.text).toBe('Você não tem nenhuma conta em aberto 🎉');
  });

  it('não cadastrado → pede cadastro', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({ intent: 'list_bills' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'minhas contas');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(askToRegister());
  });
});
```

- [ ] **Step 2: Rodar**

Run: `npx tsc --noEmit` → limpo.
Run: `npm test` → todos os casos de `money-flows` + sanity PASS. Se algum falhar, é sinal honesto (ou o teste codifica o comportamento errado, ou achou um bug pré-existente — investigar antes de "ajustar pra passar").

- [ ] **Step 3: Commit**

```bash
git add test/money-flows.test.ts
git commit -m "$(printf 'test: caracterização dos fluxos de dinheiro (criar/marcar/listar)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Caracterização — registro + conversa/guarda-corpos (`test/registration-and-conversation.test.ts`)

**Files:**
- Create: `test/registration-and-conversation.test.ts`

- [ ] **Step 1: Escrever o arquivo de teste**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sentMessages } = vi.hoisted(() => ({ sentMessages: [] as { to: string; text: string }[] }));

vi.mock('../src/services/whatsapp/whatsapp.js', () => ({
  sendText: vi.fn(async (to: string, text: string) => { sentMessages.push({ to, text }); }),
  sendImage: vi.fn(),
}));
vi.mock('../src/workers/payment-scanner.worker.js', () => ({ notifyNewBillCreated: vi.fn() }));
vi.mock('../src/services/llm/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llm/gemini.js')>();
  return { ...actual, extractIntent: vi.fn() };
});

import { extractIntent, GeminiUnavailableError } from '../src/services/llm/gemini.js';
import { dispatchIncomingMessage } from '../src/services/dispatch/dispatch-message.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { unknownIntentsRepository } from '../src/repositories/unknown-intents.repository.js';
import {
  welcomeNeedPix, welcomeReady, fallbackReply, instability,
} from '../src/services/messaging/voice.js';
import { resetDb, registerUser } from './setup.js';

const extractIntentMock = vi.mocked(extractIntent);
const PHONE = '558899990000';

beforeEach(() => {
  resetDb();
  sentMessages.length = 0;
  extractIntentMock.mockReset();
});

describe('register_account', () => {
  it('nome só (user novo) → insere sem PIX e pede a chave', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({ intent: 'register_account', profile: { name: 'João' } });

    // ACT
    await dispatchIncomingMessage(PHONE, 'sou o João');

    // ASSERT
    const user = await userRepository.findByPhone(PHONE);
    expect(user?.name).toBe('João');
    expect(user?.pix_key).toBe('');
    expect(sentMessages[0]!.text).toBe(welcomeNeedPix('João'));
  });

  it('nome + PIX (user novo) → insere completo e confirma pronto', async () => {
    // ARRANGE
    extractIntentMock.mockResolvedValue({
      intent: 'register_account', profile: { name: 'João', pix_key: 'joao@email.com' },
    });

    // ACT
    await dispatchIncomingMessage(PHONE, 'sou o João, pix joao@email.com');

    // ASSERT
    expect((await userRepository.findByPhone(PHONE))?.pix_key).toBe('joao@email.com');
    expect(sentMessages[0]!.text).toBe(welcomeReady('João'));
  });

  it('profile vazio (user já cadastrado) → fallback, sem silêncio', async () => {
    // ARRANGE
    await registerUser(PHONE, { name: 'Ana' });
    extractIntentMock.mockResolvedValue({ intent: 'register_account', profile: {} });

    // ACT
    await dispatchIncomingMessage(PHONE, 'quero me registrar');

    // ASSERT
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toBe(fallbackReply({ registered: true }));
  });
});

describe('conversa / guarda-corpos', () => {
  it('unknown com reply válido → envia o reply e NÃO grava em unknown_intents', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({ intent: 'unknown', reply: 'Opa! 👋 Tudo bom?' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'oi');

    // ASSERT
    expect(sentMessages[0]!.text).toBe('Opa! 👋 Tudo bom?');
    expect(await unknownIntentsRepository.list()).toHaveLength(0);
  });

  it('unknown sem reply → fallback e grava em unknown_intents', async () => {
    // ARRANGE (sem user → fallback de não cadastrado)
    extractIntentMock.mockResolvedValue({ intent: 'unknown' });

    // ACT
    await dispatchIncomingMessage(PHONE, '???');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(fallbackReply({ registered: false }));
    expect(await unknownIntentsRepository.list()).toHaveLength(1);
  });

  it('Gemini indisponível → mensagem de instabilidade', async () => {
    // ARRANGE
    extractIntentMock.mockRejectedValue(new GeminiUnavailableError());

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 60 na pizza');

    // ASSERT
    expect(sentMessages[0]!.text).toBe(instability());
  });
});
```

- [ ] **Step 2: Rodar**

Run: `npx tsc --noEmit` → limpo.
Run: `npm test` → toda a suíte PASS (4 arquivos).

- [ ] **Step 3: Commit**

```bash
git add test/registration-and-conversation.test.ts
git commit -m "$(printf 'test: caracterização de registro + conversa/guarda-corpos\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Verificação final
- [ ] `npx tsc --noEmit` limpo.
- [ ] `npm test` verde (4 arquivos: db-harness, money-flows, registration-and-conversation + sanity).
- [ ] `git diff main...HEAD -- src/` — só `db.ts` (env) e o refactor do webhook + o novo `dispatch-message.ts`. Nenhuma mudança de comportamento de prod.
- [ ] Boot rápido: `npm run dev` sobe sem erro (o refactor não quebrou o registro do webhook). Encerrar depois.
- [ ] PR contra `main` (merge é do Danubio):
  ```bash
  git push -u origin feat/integration-test-harness
  gh pr create --base main --title "Fase 1: harness de testes integrados + caracterização" \
    --body "Implementa docs/superpowers/specs/2026-05-30-integration-test-harness-design.md. Behavior-preserving."
  ```
  **Não** auto-mergear.
