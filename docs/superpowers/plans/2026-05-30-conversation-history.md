# Fase 2 — Nível 1.5 (memória de conversa) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar memória de conversa ao Slice (histórico por telefone) pra resolver referências, completar dado faltando e sustentar papo — mantendo ação determinística.

**Architecture:** Tabela `conversation_turns` + `conversationRepository`. `dispatchIncomingMessage` carrega os últimos turnos, passa pro `extractIntent`, e grava o turno do user + um turno do bot (reply verbatim, ou resumo de ação SEM PIX). `extractIntent(text, ctx, history)` injeta o histórico no `contents` do Gemini (bot→model). O prompt orienta a usar o histórico. Caminho do dinheiro intocado.

**Tech Stack:** Node ≥20 + TypeScript (ESM, imports `.js`), better-sqlite3, `@google/genai`, vitest.

**Convenção:** gate de cada task = `npx tsc --noEmit` limpo **+** `npm test` verde. TDD: teste antes/junto da implementação.

**Spec:** [`docs/superpowers/specs/2026-05-30-conversation-history-design.md`](../specs/2026-05-30-conversation-history-design.md)

---

## File structure overview

**Novos:** `src/repositories/conversation.repository.ts`, `test/conversation-repository.test.ts`, `test/conversation-history.test.ts`.
**Modificados:** `src/repositories/db.ts` (tabela), `test/setup.ts` (`resetDb` + builder), `src/services/llm/gemini.ts` (`buildContents` + param `history`), `src/services/llm/prompt.ts` (usar histórico), `src/services/dispatch/dispatch-message.ts` (carrega/grava).

Ordem (respeita dependências): T1 repo → T2 gemini → T3 prompt → T4 dispatcher.

---

## Task 1: Histórico — tabela + `conversationRepository` + `resetDb`

**Files:**
- Modify: `src/repositories/db.ts`
- Create: `src/repositories/conversation.repository.ts`
- Modify: `test/setup.ts`
- Create: `test/conversation-repository.test.ts`

- [ ] **Step 1: Adicionar a tabela no `db.ts`**

No `db.exec(\`...\`)`, ANTES do fechamento da template string (depois do bloco `unknown_intents`), adicionar:

```sql
  CREATE TABLE IF NOT EXISTS conversation_turns (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    role  TEXT NOT NULL,
    text  TEXT NOT NULL,
    at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_phone ON conversation_turns(phone, id);
```

- [ ] **Step 2: Criar `src/repositories/conversation.repository.ts`**

```typescript
import { db } from './db.js';

export interface HistoryTurn {
  role: 'user' | 'bot';
  text: string;
}

const MAX_TURNS_PER_PHONE = 16; // cap FIFO por telefone (não cresce sem limite)
const WINDOW_TTL_HOURS = 6;     // contexto mais velho que isso não volta
const MAX_TURN_TEXT = 500;      // corta texto longo (tokens + superfície de injection)

interface TurnRow {
  role: 'user' | 'bot';
  text: string;
}

const insertTurn = db.prepare(
  'INSERT INTO conversation_turns (phone, role, text, at) VALUES (@phone, @role, @text, @at)',
);
const trimPhone = db.prepare(
  `DELETE FROM conversation_turns WHERE phone = ? AND id NOT IN (
     SELECT id FROM conversation_turns WHERE phone = ? ORDER BY id DESC LIMIT ?
   )`,
);
const selectRecent = db.prepare<[string, string, number], TurnRow>(
  `SELECT role, text FROM conversation_turns
   WHERE phone = ? AND at >= ?
   ORDER BY id DESC LIMIT ?`,
);

const appendTx = db.transaction(
  (entry: { phone: string; role: string; text: string; at: string }) => {
    insertTurn.run(entry);
    trimPhone.run(entry.phone, entry.phone, MAX_TURNS_PER_PHONE);
  },
);

export const conversationRepository = {
  async append(phone: string, role: 'user' | 'bot', text: string): Promise<void> {
    appendTx({ phone, role, text: text.slice(0, MAX_TURN_TEXT), at: new Date().toISOString() });
  },

  // Últimos `limit` turnos dentro do TTL, em ordem cronológica (antigo → novo).
  async recent(phone: string, limit = 8): Promise<HistoryTurn[]> {
    const cutoff = new Date(Date.now() - WINDOW_TTL_HOURS * 60 * 60 * 1000).toISOString();
    const rows = selectRecent.all(phone, cutoff, limit);
    return rows.reverse().map((row) => ({ role: row.role, text: row.text }));
  },
};
```

- [ ] **Step 3: `resetDb` limpa a tabela nova + builder de histórico** (`test/setup.ts`)

Na função `resetDb`, incluir `conversation_turns` no DELETE:

```typescript
export function resetDb(): void {
  db.exec(
    'DELETE FROM participants; DELETE FROM bills; DELETE FROM users; ' +
      'DELETE FROM processed_transactions; DELETE FROM unknown_intents; ' +
      'DELETE FROM conversation_turns;',
  );
}
```

- [ ] **Step 4: Escrever `test/conversation-repository.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/repositories/db.js';
import { conversationRepository } from '../src/repositories/conversation.repository.js';
import { resetDb } from './setup.js';

const PHONE = '558899990000';

beforeEach(() => resetDb());

describe('conversationRepository', () => {
  it('append e recent fazem roundtrip em ordem cronológica', async () => {
    // ARRANGE / ACT
    await conversationRepository.append(PHONE, 'user', 'oi');
    await conversationRepository.append(PHONE, 'bot', 'opa');

    // ASSERT
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns).toEqual([
      { role: 'user', text: 'oi' },
      { role: 'bot', text: 'opa' },
    ]);
  });

  it('corta o texto do turno em 500 chars', async () => {
    // ARRANGE / ACT
    await conversationRepository.append(PHONE, 'user', 'x'.repeat(600));

    // ASSERT
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns[0]!.text).toHaveLength(500);
  });

  it('mantém no máximo 16 turnos por telefone (FIFO)', async () => {
    // ARRANGE / ACT
    for (let i = 0; i < 20; i++) {
      await conversationRepository.append(PHONE, 'user', `t${i}`);
    }

    // ASSERT — só os 16 últimos sobrevivem
    const turns = await conversationRepository.recent(PHONE, 100);
    expect(turns).toHaveLength(16);
    expect(turns[0]!.text).toBe('t4'); // t0..t3 caíram
    expect(turns[15]!.text).toBe('t19');
  });

  it('recent ignora turnos mais velhos que o TTL (6h)', async () => {
    // ARRANGE — insere um turno "velho" direto (7h atrás) + um fresco
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO conversation_turns (phone, role, text, at) VALUES (?, ?, ?, ?)')
      .run(PHONE, 'user', 'velho', sevenHoursAgo);
    await conversationRepository.append(PHONE, 'user', 'novo');

    // ACT
    const turns = await conversationRepository.recent(PHONE, 8);

    // ASSERT
    expect(turns).toEqual([{ role: 'user', text: 'novo' }]);
  });
});
```

- [ ] **Step 5: Verificar**

Run: `npx tsc --noEmit` → limpo.
Run: `npm test` → repo tests passam + Fase 1 segue verde (resetDb agora limpa a tabela nova; ninguém grava nela ainda).

- [ ] **Step 6: Commit**

```bash
git add src/repositories/db.ts src/repositories/conversation.repository.ts test/setup.ts test/conversation-repository.test.ts
git commit -m "$(printf 'feat(history): tabela + conversationRepository (janela/TTL/cap)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: `gemini.ts` — `buildContents` + param `history`

**Files:**
- Modify: `src/services/llm/gemini.ts`
- Create: `test/gemini-contents.test.ts`

- [ ] **Step 1: Escrever o teste do `buildContents`** (`test/gemini-contents.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { buildContents } from '../src/services/llm/gemini.js';

describe('buildContents', () => {
  it('sem histórico → só a mensagem atual como user', () => {
    expect(buildContents('oi', [])).toEqual([
      { role: 'user', parts: [{ text: 'oi' }] },
    ]);
  });

  it('mapeia bot→model, mantém ordem e põe a mensagem atual por último', () => {
    const history = [
      { role: 'user' as const, text: 'paguei 60 na pizza' },
      { role: 'bot' as const, text: 'quanto foi?' },
    ];
    expect(buildContents('com a Ana', history)).toEqual([
      { role: 'user', parts: [{ text: 'paguei 60 na pizza' }] },
      { role: 'model', parts: [{ text: 'quanto foi?' }] },
      { role: 'user', parts: [{ text: 'com a Ana' }] },
    ]);
  });
});
```

- [ ] **Step 2: Rodar — deve FALHAR** (`buildContents` não existe / não exportado)

Run: `npm test -- gemini-contents`
Expected: FAIL.

- [ ] **Step 3: Implementar em `gemini.ts`**

Adicionar o import de tipo (no topo, junto dos outros imports):

```typescript
import type { HistoryTurn } from "../../repositories/conversation.repository.js";
```

Adicionar a função `buildContents` (logo antes de `export async function extractIntent`):

```typescript
// Monta o array de contents do Gemini: histórico (bot→model) + a mensagem atual.
export function buildContents(
  text: string,
  history: HistoryTurn[],
): { role: "user" | "model"; parts: { text: string }[] }[] {
  const past = history.map((turn) => ({
    role: turn.role === "bot" ? ("model" as const) : ("user" as const),
    parts: [{ text: turn.text }],
  }));
  return [...past, { role: "user" as const, parts: [{ text }] }];
}
```

Alterar a assinatura e o `contents` do `extractIntent`:

```typescript
export async function extractIntent(
  text: string,
  ctx: UserContext,
  history: HistoryTurn[] = [],
): Promise<ExtractionResult> {
  console.log("[gemini] extracting", {
    textLen: text.length, registered: ctx.registered, hasPix: ctx.hasPix, historyTurns: history.length,
  });
  const request = {
    model: "gemini-2.5-flash-lite",
    contents: buildContents(text, history),
    config: {
      systemInstruction: SYSTEM_INSTRUCTION + buildContextNote(ctx),
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.3,
    },
  };
  // ... resto da função (loop de retry/parse) INALTERADO ...
```

Não mudar `buildContextNote`, `generateWithRetry`, o loop de parse, nem o `RESPONSE_SCHEMA`.

- [ ] **Step 4: Rodar**

Run: `npx tsc --noEmit` → limpo. (Se o SDK reclamar do tipo de `contents`, mantenha os roles como literais `"user"`/`"model"` — já estão; reporte se persistir.)
Run: `npm test` → `buildContents` passa; Fase 1 segue verde (extractIntent é stubado lá; o 3º arg default `[]` não quebra chamadas antigas).

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/gemini.ts test/gemini-contents.test.ts
git commit -m "$(printf 'feat(gemini): extractIntent recebe histórico (buildContents bot→model)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: `prompt.ts` — orientar uso do histórico

**Files:**
- Modify: `src/services/llm/prompt.ts`

- [ ] **Step 1: Inserir a seção `== HISTÓRICO ==`**

No `SYSTEM_INSTRUCTION`, inserir o bloco abaixo ENTRE o fim da seção `== PERSONA ...` (logo após a linha `- NUNCA invente recurso que você não tem. NUNCA coloque chave PIX nem valores no "reply".`) e o início de `== create_bill ==`:

```
== HISTÓRICO ==
Você recebe os últimos turnos da conversa, além da mensagem atual. Use-os para:
- Resolver referências ao que veio antes ("e o do João?", "muda essa") — olhe o
  histórico pra saber de qual conta/pessoa se trata.
- Completar dado faltando: se a pessoa quer dividir mas falta o valor ou com quem,
  NÃO invente — responda no "reply" (intent unknown) pedindo SÓ o que falta; quando
  ela responder, use o histórico pra montar o create_bill completo.
- Sustentar uma conversa natural e contextual.
Nunca invente dado que não esteja no histórico nem na mensagem atual.
```

- [ ] **Step 2: Verificar**

Run: `npx tsc --noEmit` → limpo (é uma string).
Run: `npm test` → tudo verde (mudança de prompt não afeta testes, que stubam o Gemini).

- [ ] **Step 3: Commit**

```bash
git add src/services/llm/prompt.ts
git commit -m "$(printf 'feat(prompt): orienta uso do histórico (referências, slot-filling, papo)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: `dispatch-message.ts` — carregar + gravar histórico

**Files:**
- Modify: `src/services/dispatch/dispatch-message.ts`
- Create: `test/conversation-history.test.ts`

- [ ] **Step 1: Escrever os testes de integração** (`test/conversation-history.test.ts`)

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
import { conversationRepository } from '../src/repositories/conversation.repository.js';
import { resetDb, registerUser } from './setup.js';

const extractIntentMock = vi.mocked(extractIntent);
const PHONE = '558899990000';

beforeEach(() => {
  resetDb();
  sentMessages.length = 0;
  extractIntentMock.mockReset();
});

describe('histórico de conversa', () => {
  it('após criar conta, grava turno user + resumo do bot SEM PIX', async () => {
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
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ role: 'user', text: 'paguei 60 na pizza, divide com Beto e Carla' });
    expect(turns[1]!.role).toBe('bot');
    expect(turns[1]!.text).not.toMatch(/br\.gov\.bcb\.pix/i);
  });

  it('após unknown com reply, grava o reply verbatim no turno do bot', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockResolvedValue({ intent: 'unknown', reply: 'Opa! 👋 Tudo bom?' });

    // ACT
    await dispatchIncomingMessage(PHONE, 'oi');

    // ASSERT
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns[1]).toEqual({ role: 'bot', text: 'Opa! 👋 Tudo bom?' });
  });

  it('passa o histórico recente pro extractIntent', async () => {
    // ARRANGE — semeia histórico (ex: bot perguntou "quanto foi?")
    await registerUser(PHONE);
    await conversationRepository.append(PHONE, 'user', 'paguei na pizza');
    await conversationRepository.append(PHONE, 'bot', 'quanto foi?');
    extractIntentMock.mockResolvedValue({ intent: 'unknown', reply: 'beleza' });

    // ACT
    await dispatchIncomingMessage(PHONE, '60, com a Ana');

    // ASSERT — 3º argumento do extractIntent traz o histórico semeado
    expect(extractIntentMock).toHaveBeenCalledTimes(1);
    expect(extractIntentMock.mock.calls[0]![2]).toEqual([
      { role: 'user', text: 'paguei na pizza' },
      { role: 'bot', text: 'quanto foi?' },
    ]);
  });

  it('instabilidade do Gemini não grava histórico', async () => {
    // ARRANGE
    await registerUser(PHONE);
    extractIntentMock.mockRejectedValue(new GeminiUnavailableError());

    // ACT
    await dispatchIncomingMessage(PHONE, 'paguei 60 na pizza');

    // ASSERT
    expect(await conversationRepository.recent(PHONE, 8)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar — deve FALHAR** (dispatcher ainda não grava histórico nem passa o 3º arg)

Run: `npm test -- conversation-history`
Expected: FAIL.

- [ ] **Step 3: Implementar — reescrever `dispatch-message.ts`**

Substituir o arquivo inteiro por:

```typescript
import { extractIntent, GeminiUnavailableError } from "../llm/gemini.js";
import { createBillFromExtraction, markPaid, listOpenBills } from "../bills/bill.service.js";
import { handleRegistration } from "../users/user.service.js";
import { userRepository } from "../../repositories/user.repository.js";
import { unknownIntentsRepository } from "../../repositories/unknown-intents.repository.js";
import { conversationRepository } from "../../repositories/conversation.repository.js";
import { sendText } from "../whatsapp/whatsapp.js";
import { fallbackReply, instability, askToRegister, askForPix } from "../messaging/voice.js";
import type { ExtractionResult } from "../bills/bill.types.js";

export async function dispatchIncomingMessage(senderPhone: string, text: string): Promise<void> {
  const user = await userRepository.findByPhone(senderPhone);
  const ctx = { registered: !!user, hasPix: !!user?.pix_key, name: user?.name ?? "" };
  const history = await conversationRepository.recent(senderPhone, 8);

  // Extração isolada: Gemini fora (503) ou erro inesperado → instabilidade, não silêncio.
  // (Não grava histórico quando a extração falha.)
  let result: ExtractionResult;
  try {
    result = await extractIntent(text, ctx, history);
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
    // botTurn = o que o bot "disse" pro histórico: reply/gate verbatim, ou resumo de
    // ação (sem PIX). `say` envia E registra o texto pro histórico de uma vez.
    let botTurn = "";
    const say = async (message: string): Promise<void> => {
      await sendText(senderPhone, message);
      botTurn = message;
    };

    switch (result.intent) {
      case "register_account":
        if (!result.profile?.name && !result.profile?.pix_key) {
          await say(fallbackReply({ registered: !!user }));
          break;
        }
        await handleRegistration(senderPhone, result.profile);
        botTurn = "[registrei seu cadastro]";
        break;

      case "create_bill": {
        if (!result.bill) { await say(fallbackReply({ registered: !!user })); break; }
        // Intent misto: só auto-registra quem está incompleto; conta vence o resto.
        let owner = user;
        if (result.profile && (!owner || !owner.pix_key)) {
          await handleRegistration(senderPhone, result.profile, { continueToBill: true });
          owner = await userRepository.findByPhone(senderPhone);
        }
        if (!owner) { await say(askToRegister()); break; }
        if (!owner.pix_key) { await say(askForPix(owner.name)); break; }
        await createBillFromExtraction(result.bill, owner);
        botTurn = "[criei a conta]";
        break;
      }

      case "mark_paid":
        if (!user) { await say(askToRegister()); break; }
        await markPaid(senderPhone, result.payment ?? {});
        botTurn = "[registrei o pagamento]";
        break;

      case "list_bills":
        if (!user) { await say(askToRegister()); break; }
        await listOpenBills(senderPhone);
        botTurn = "[mostrei as contas em aberto]";
        break;

      default: {
        const softReply = result.intent === "unknown" ? result.reply?.trim() : undefined;
        if (softReply && softReply.length <= 300) {
          await say(softReply);
        } else {
          await unknownIntentsRepository.record({ phone: senderPhone, text, registered: !!user });
          console.log("[unknown-intent recorded]", { phone: senderPhone, textLen: text.length });
          await say(fallbackReply({ registered: !!user }));
        }
      }
    }

    // Grava o turno só em sucesso (um throw acima pula isto e cai no catch).
    await conversationRepository.append(senderPhone, "user", text);
    await conversationRepository.append(senderPhone, "bot", botTurn);
    console.log("[dispatch] flow finished ok");
  } catch (err) {
    console.error("[dispatch] flow failed", err);
  }
}
```

- [ ] **Step 4: Rodar**

Run: `npx tsc --noEmit` → limpo.
Run: `npm test` → TODOS verdes (Fase 1 + repo + buildContents + conversation-history). Se algum teste da Fase 1 quebrar, investigar honestamente (não enfraquecer asserção).

- [ ] **Step 5: Commit**

```bash
git add src/services/dispatch/dispatch-message.ts test/conversation-history.test.ts
git commit -m "$(printf 'feat(dispatch): carrega e grava histórico de conversa\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Verificação final
- [ ] `npx tsc --noEmit` limpo + `npm test` verde (toda a suíte).
- [ ] `git diff main...HEAD -- src/` — só os arquivos previstos; turnos de ação inalterados; nenhum PIX no histórico.
- [ ] Smoke manual (Danubio, ao vivo): "paguei na pizza" → bot pergunta o valor → responder → cria a conta; "e o do João?" após uma conta; um papo curto. (Qualidade conversacional não é testável em CI.)
- [ ] PR contra `main` (merge é do Danubio):
  ```bash
  git push -u origin feat/conversation-history
  gh pr create --base main --title "Fase 2: Nível 1.5 — memória de conversa" \
    --body "Implementa docs/superpowers/specs/2026-05-30-conversation-history-design.md"
  ```
  **Não** auto-mergear.
