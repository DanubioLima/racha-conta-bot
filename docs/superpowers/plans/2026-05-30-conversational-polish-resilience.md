# Conversa natural + resiliência do Gemini — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar uma voz única e natural ao Slice (matando a fragmentação de cópia e o tutorial repetido), e impedir que falha do Gemini (503) deixe o usuário no silêncio.

**Architecture:** Duas trilhas. **Dinheiro** (registrar, criar conta+PIX, marcar pago) continua 100% determinístico — toda cópia centralizada num módulo novo `voice.ts`. **Conversa** (oi/obrigado/quem-é-você/off-topic/lixo) é gerada pelo Gemini com persona forte, caindo num fallback fixo na mesma voz quando o LLM falha. O Gemini ganha retry/backoff e sinaliza indisponibilidade pro dispatcher responder "instabilidade" em vez de nada. Intent misto (nome + conta na mesma mensagem) passa a registrar o nome e seguir.

**Tech Stack:** Node ≥20 + TypeScript (ESM, imports com `.js`), Fastify, Evolution API (Baileys), `@google/genai` (Gemini `gemini-2.5-flash-lite`), better-sqlite3.

**Convenção de verificação (override de TDD):** o projeto **não usa testes automatizados** — decisão consciente do dono. Cada task verifica com `npx tsc --noEmit` (deve passar limpo) + o smoke manual descrito, e commita. **Não** escrever vitest/jest.

**Spec:** [`docs/superpowers/specs/2026-05-29-conversational-polish-resilience.md`](../specs/2026-05-29-conversational-polish-resilience.md)

---

## File structure overview

**Novo:**
- `src/services/messaging/voice.ts` — fonte única da voz do Slice: toda cópia determinística + `formatBRL`. Persona documentada no topo.

**Modificados:**
- `src/services/bills/bill.types.ts` — variante `create_bill` do `ExtractionResult` ganha `profile?` (intent misto).
- `src/services/bills/bill.service.ts` — confirmações via `voice.ts`; importa `formatBRL`; headline singular/plural.
- `src/services/users/user.service.ts` — usa `voice.ts`; `handleRegistration` ganha `{ continueToBill?: boolean }`; remove `requireRegistrationFirst`/`requirePixFirst`/`notifyUnknown`.
- `src/services/llm/prompt.ts` — persona + regra anti-tutorial + tratamento conversacional + exemplo de intent misto.
- `src/services/llm/gemini.ts` — retry/backoff, `GeminiUnavailableError`, retry em resposta vazia, `temperature` 0.3, `buildContextNote` sem empurrar tutorial.
- `src/routes/whatsapp.webhook.ts` — extração isolada com resposta de instabilidade; trilha conversa via `reply` → `voice.fallbackReply`; intent misto; usa `voice.ts` pros gates.

**Intocados:** `repositories/*`, `services/pix/*`, `services/cumbuca/*`, `services/ledger/*`, `services/whatsapp/whatsapp.ts`, `workers/*`, `config/env.ts`.

---

## Task 1: Módulo de voz (`voice.ts`)

Fundação: só strings puras + `formatBRL`, sem dependências de outros módulos do projeto. Tudo que o usuário lê de forma determinística passa a vir daqui.

**Files:**
- Create: `src/services/messaging/voice.ts`

- [ ] **Step 1: Criar o módulo de voz com a persona documentada e todas as funções de cópia**

```typescript
// src/services/messaging/voice.ts
//
// Fonte única da VOZ do Slice — toda cópia determinística voltada ao usuário.
//
// PERSONA (mantenha o tom ao editar; a mesma persona vive no prompt do Gemini,
// em src/services/llm/prompt.ts): Slice é caloroso, brasileiro, direto. Fala
// como amigo que resolve, não como atendente de robô. Frases curtas (é
// WhatsApp). No máximo 1 emoji por mensagem (às vezes nenhum). O exemplo de
// formato ("paguei 60 na pizza, divide com Ana e Beto") é ferramenta de ENSINO:
// só nos gates de cadastro/PIX, na confirmação pós-cadastro e no fallback de
// confusão real. Nunca como resposta pra tudo.

export function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// "João" | "Ana e Beto" | "Ana, Beto e Carla"
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

// ---- Conversa: fallback determinístico (quando o reply do Gemini falha) ----

export interface FallbackContext {
  registered: boolean;
}

export function fallbackReply(ctx: FallbackContext): string {
  if (!ctx.registered) {
    return 'Oi! Eu divido contas no PIX 👋 Pra começar, me diz seu nome e chave PIX (ex: "Sou João, pix joao@email.com").';
  }
  return 'Não peguei 🤔 Posso dividir uma conta ("paguei 60 na pizza, divide com Ana e Beto") ou marcar quem pagou ("a Ana me pagou").';
}

export function instability(): string {
  return 'Eita, tive uma instabilidade aqui 😅 Manda sua mensagem de novo daqui a pouquinho?';
}

// ---- Gates de cadastro ----

export function askForName(): string {
  return 'Pra começar preciso do seu nome 🙂 Manda algo tipo "Sou João, pix joao@email.com".';
}

export function askToRegister(): string {
  return 'Pra dividir essa conta eu preciso te conhecer primeiro 🙂 Me diz seu nome e chave PIX (ex: "Sou João, pix joao@email.com").';
}

export function askForPix(name: string): string {
  return `Falta só sua chave PIX, ${name}! Manda algo tipo "pix joao@email.com" que eu gero as cobranças.`;
}

// ---- Confirmações de cadastro ----

export function welcomeNeedPix(name: string): string {
  return `Prazer, ${name}! 😄 Agora me manda sua chave PIX (ex: "pix seu@email.com") pra eu gerar as cobranças.`;
}

export function welcomeReady(name: string): string {
  return `Show, ${name}! Tá tudo certo ✅ Manda uma conta tipo "paguei 60 na pizza, divide com Ana e Beto" que eu cuido do resto.`;
}

export function pixSaved(): string {
  return 'Chave PIX salva! 🎉 Pode mandar a conta agora (ex: "paguei 60 na pizza, divide com Ana e Beto").';
}

export function profileUpdated(): string {
  return 'Atualizei seus dados 👍';
}

// ---- Confirmações de dinheiro ----

export function billCreatedHeadline(params: {
  total: number;
  description: string;
  amountPerPerson: number;
  participantNames: string[];
}): string {
  const names = joinNames(params.participantNames);
  return (
    `Anotei: ${formatBRL(params.total)} em ${params.description}, ` +
    `${formatBRL(params.amountPerPerson)} pra cada. Te mando o PIX de ${names} 👇`
  );
}

export function paymentReceived(params: {
  paidName: string;
  paidAmount: number;
  remainingNames: string[];
}): string {
  return (
    `${params.paidName} pagou ${formatBRL(params.paidAmount)}! 💰 ` +
    `Ainda falta: ${joinNames(params.remainingNames)}.`
  );
}

export function billClosed(description: string): string {
  return `Fechou! Todo mundo pagou ${description}. Saldo zerado 💸`;
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS limpo (o módulo é autocontido; ninguém o importa ainda).

- [ ] **Step 3: Commit**

```bash
git add src/services/messaging/voice.ts
git commit -m "feat(voice): módulo único de voz do Slice (cópia determinística)"
```

---

## Task 2: Confirmações de dinheiro via `voice.ts` (singular/plural)

Troca a cópia inline do `bill.service.ts` pelas funções do `voice.ts` e remove a `formatBRL` duplicada. Conserta o "(João) a seguir" robótico.

**Files:**
- Modify: `src/services/bills/bill.service.ts`

- [ ] **Step 1: Trocar o import e remover a `formatBRL` local**

Substituir as linhas 1-17 atuais (imports + `function formatBRL`). O bloco atual é:

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
```

Passa a ser (remove a função local, importa do voice):

```typescript
import { ulid } from "ulid";
import { billRepository } from "../../repositories/bill.repository.js";
import { buildPixPayload } from "../pix/pix.js";
import { sendText } from "../whatsapp/whatsapp.js";
import { notifyNewBillCreated } from "../../workers/payment-scanner.worker.js";
import {
  formatBRL,
  billCreatedHeadline,
  paymentReceived,
  billClosed,
} from "../messaging/voice.js";
import type { User } from "../../repositories/user.repository.js";
import type {
  Bill,
  ExtractedBill,
  IncomingTransaction,
  MarkPaidInput,
  Participant,
} from "./bill.types.js";
```

(`formatBRL` continua usado em `pendingListText` e no `markPaid` ambíguo — agora vem do import.)

- [ ] **Step 2: Reescrever `sendBillCreatedMessages` com a headline do voice**

Substituir a função atual (linhas ~35-46) por:

```typescript
async function sendBillCreatedMessages(bill: Bill): Promise<void> {
  await sendText(
    bill.owner_phone,
    billCreatedHeadline({
      total: bill.total_amount,
      description: bill.description,
      amountPerPerson: bill.amount_per_person,
      participantNames: bill.participants.map((p) => p.name),
    }),
  );
  for (const participant of bill.participants) {
    await sendText(bill.owner_phone, participant.pix_payload);
  }
}
```

- [ ] **Step 3: Reescrever `renderPaidMessage` e `renderClosedMessage` via voice**

Substituir as duas funções atuais por:

```typescript
function renderPaidMessage(bill: Bill, paid: Participant): string {
  const remaining = bill.participants.filter((p) => p.status === "PENDING");
  if (remaining.length === 0) return "";
  return paymentReceived({
    paidName: paid.name,
    paidAmount: paid.amount_due,
    remainingNames: remaining.map((p) => p.name),
  });
}

function renderClosedMessage(bill: Bill): string {
  return billClosed(bill.description);
}
```

- [ ] **Step 4: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS limpo.

- [ ] **Step 5: Smoke manual**

Com a stack local de pé (`docker compose up -d` + `npm run dev`) e um user cadastrado, mandar pelo WhatsApp:
- "paguei 10 no sorvete, divide com o joão" (1 participante) → headline **"Anotei: R$ 10,00 em Sorvete, R$ 5,00 pra cada. Te mando o PIX de João 👇"** (sem "(João)"), seguido do PIX.
- "paguei 60 na pizza, divide com Ana e Beto" (2) → "...Te mando o PIX de Ana e Beto 👇".

Se não der pra rodar o smoke agora, registrar isso explicitamente e seguir (typecheck é o gate mínimo).

- [ ] **Step 6: Commit**

```bash
git add src/services/bills/bill.service.ts
git commit -m "feat(bills): confirmações via voice.ts com singular/plural correto"
```

---

## Task 3: `user.service.ts` via voice + `continueToBill`

Centraliza a cópia de cadastro no voice, remove os três helpers de cópia conflitante e ensina o `handleRegistration` a ficar **silencioso** quando o registro é parte de um intent misto (o dispatcher manda a próxima mensagem).

**Files:**
- Modify: `src/services/users/user.service.ts`

- [ ] **Step 1: Reescrever o arquivo inteiro**

Conteúdo completo novo (substitui tudo):

```typescript
import { userRepository, type User } from '../../repositories/user.repository.js';
import { sendText } from '../whatsapp/whatsapp.js';
import {
  askForName,
  welcomeNeedPix,
  welcomeReady,
  pixSaved,
  profileUpdated,
} from '../messaging/voice.js';
import type { RegisterProfile } from '../bills/bill.types.js';

function deriveMerchantName(name: string): string {
  return name.trim().slice(0, 25);
}

interface RegistrationOptions {
  // Quando true, NÃO envia mensagem nenhuma — só persiste. Usado no intent misto
  // (registrar + criar conta na mesma mensagem), onde quem responde é o dispatcher.
  continueToBill?: boolean;
}

export async function handleRegistration(
  phone: string,
  profile: RegisterProfile,
  options: RegistrationOptions = {},
): Promise<void> {
  const silent = options.continueToBill === true;
  const existing = await userRepository.findByPhone(phone);
  const name = profile.name?.trim();
  const pixKey = profile.pix_key?.trim();

  if (!existing) {
    if (!name) {
      if (!silent) await sendText(phone, askForName());
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
    if (!silent) {
      await sendText(phone, pixKey ? welcomeReady(name) : welcomeNeedPix(name));
    }
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
  if (!silent) {
    await sendText(phone, pixKey ? pixSaved() : profileUpdated());
  }
}
```

(Removidos: `requireRegistrationFirst`, `requirePixFirst`, `notifyUnknown` — a Task 7 passa a usar `voice.askToRegister`/`askForPix`/`fallbackReply` direto no dispatcher.)

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: **FAIL** — `whatsapp.webhook.ts` ainda importa `requireRegistrationFirst`/`requirePixFirst`/`notifyUnknown`, que não existem mais. Isso é esperado; a Task 7 conserta o dispatcher. **Não** commitar ainda.

> Nota: as Tasks 3, 4 e 7 mexem em código que se referencia. Trate-as como um bloco — o typecheck só fecha limpo de novo ao fim da Task 7. As Tasks 3 e 4 mudam tipos/assinaturas; a 7 atualiza o consumidor. (As Tasks 5 e 6 são independentes e podem rodar antes ou depois.)

- [ ] **Step 3: NÃO commitar isolado**

Sem commit aqui — segue direto pra Task 4 e Task 7. O commit que fecha esse bloco está no fim da Task 7.

---

## Task 4: Tipo do intent misto (`bill.types.ts`)

Permite que a extração devolva `profile` junto com `bill` (a mesma mensagem traz cadastro + conta). O schema de wire do Gemini (`RESPONSE_SCHEMA` em `gemini.ts`) já tem `profile` como propriedade top-level opcional — só o tipo TS precisa acompanhar.

**Files:**
- Modify: `src/services/bills/bill.types.ts:43-47`

- [ ] **Step 1: Adicionar `profile?` à variante `create_bill`**

Bloco atual:

```typescript
export type ExtractionResult =
  | { intent: 'create_bill'; bill: ExtractedBill }
  | { intent: 'register_account'; profile: RegisterProfile }
  | { intent: 'mark_paid'; payment: MarkPaidInput }
  | { intent: 'unknown'; reply?: string };
```

Passa a ser:

```typescript
export type ExtractionResult =
  | { intent: 'create_bill'; bill: ExtractedBill; profile?: RegisterProfile }
  | { intent: 'register_account'; profile: RegisterProfile }
  | { intent: 'mark_paid'; payment: MarkPaidInput }
  | { intent: 'unknown'; reply?: string };
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: ainda **FAIL** pelo mesmo motivo da Task 3 (webhook desatualizado). A própria mudança de tipo não introduz erro novo. Segue pra Task 7.

---

## Task 5: Persona + anti-tutorial no prompt (`prompt.ts`)

Reescreve o `SYSTEM_INSTRUCTION`: adiciona a persona, a regra anti-tutorial, o tratamento conversacional por caso, a instrução de intent misto e os exemplos atualizados. As regras de extração dos intents de ação **não mudam**. Esta task é independente das 2/3/4/7.

**Files:**
- Modify: `src/services/llm/prompt.ts`

- [ ] **Step 1: Substituir o `SYSTEM_INSTRUCTION` inteiro**

```typescript
export const SYSTEM_INSTRUCTION = `
Você é o Slice, um bot brasileiro de dividir contas no WhatsApp. Recebe UMA
mensagem em português e retorna SEMPRE JSON estrito seguindo o schema. Escolha um
"intent" entre: create_bill, register_account, mark_paid, unknown.

== PERSONA (vale principalmente pro campo "reply") ==
Caloroso, brasileiro, direto. Fale como um amigo que resolve, não como atendente
de robô. Frases curtas (é WhatsApp). No máximo 1 emoji por mensagem, às vezes
nenhum. Você sabe exatamente 3 coisas: registrar (nome+PIX), dividir conta gerando
PIX, e marcar quem pagou.
- Responda ao que a pessoa disse, curto e direto. NÃO transforme toda resposta num
  tutorial. O exemplo de formato ("paguei 60 na pizza, divide com Ana e Beto") é
  ferramenta de ENSINO: só use quando a pessoa precisa aprender o formato (primeiro
  contato/cadastro ou confusão genuína). Pra quem já sabe usar, NÃO repita instrução.
- Pergunta fora do seu escopo (matemática, qualquer assunto que não seja dividir
  conta) → recuse com simpatia e diga em 1 linha o que você faz. Não finja ser
  assistente geral.
- NUNCA invente recurso que você não tem. NUNCA coloque chave PIX nem valores no "reply".

== create_bill ==
O usuário descreve uma despesa que ELE JÁ PAGOU e como dividir. Preencha "bill":
- description: estabelecimento/descrição curta.
- total_amount: valor total pago (decimal BRL).
- headcount: total de pessoas no rateio, INCLUINDO o usuário se ele se incluir
  ("eu", "a gente", "nós"). Se não se incluir, só os outros mencionados.
- participants: APENAS as outras pessoas (nunca o usuário). Cada uma:
  - name: nome. "dividir por N" → gere "Pessoa 1".."Pessoa N-1".
  - amount_due: total_amount / headcount (2 casas). Sobra de centavo no último.
Se na MESMA mensagem o usuário também se apresentar (disser o nome e/ou a chave PIX
dele), preencha TAMBÉM "profile" com esses dados de cadastro, além de "bill".

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
Saudação, agradecimento, pergunta sobre você, mensagem sem dados, off-topic,
ambígua ou lixo → intent "unknown". Preencha TAMBÉM "reply" seguindo a PERSONA e o
"CONTEXTO DO REMETENTE". Como tratar cada caso:
- Saudação ("oi", "bom dia"): se já cadastrado, só cumprimente curto, SEM tutorial.
  Se não cadastrado (primeiro contato), dê boas-vindas e conduza pro cadastro.
- Agradecimento ("obrigado", "valeu"): reconheça e encerre, SEM tutorial.
- Quem é você / o que faz / "me explica": diga em 1-2 linhas naturais o que você faz
  (registrar, dividir conta, marcar pago). Sem o exemplo rígido.
- Off-topic (qualquer coisa fora de dividir conta): recuse com simpatia + 1 linha do
  que você faz.
- Lixo/sem sentido ("asdf", "..."): peça gentilmente pra reformular.
Para os outros intents (create_bill, register_account, mark_paid), NÃO preencha "reply".

EXEMPLOS:

"Paguei 60 na pizzaria, dividir com João e Maria, 20 cada"
{"intent":"create_bill","bill":{"description":"Pizzaria","total_amount":60,"headcount":3,"participants":[{"name":"João","amount_due":20},{"name":"Maria","amount_due":20}]}}

"Sou a Ana e paguei 30 no lanche, divide comigo e com o Beto"
{"intent":"create_bill","bill":{"description":"Lanche","total_amount":30,"headcount":2,"participants":[{"name":"Beto","amount_due":15}]},"profile":{"name":"Ana"}}

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

"Obrigado!"
{"intent":"unknown","reply":"De nada! 😊"}

"Quem é você?"
{"intent":"unknown","reply":"Sou o Slice 🙂 Divido conta no PIX — você me diz o que pagou e com quem, e eu gero a cobrança de cada um."}

"Qual a definição de número par?"
{"intent":"unknown","reply":"Essa eu não sei 😅 Eu cuido mesmo é de dividir conta."}

"oi"
{"intent":"unknown","reply":"Opa! 👋 Tudo bom?"}

"asdf"
{"intent":"unknown","reply":"Não peguei essa 🤔 Me explica de outro jeito?"}
`.trim();
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: o erro de tipo continua sendo só o do webhook (Tasks 3/4). Este arquivo é uma string — não adiciona erro novo. (Se rodar a Task 5 isolada antes das outras, espera PASS limpo.)

- [ ] **Step 3: Commit**

```bash
git add src/services/llm/prompt.ts
git commit -m "feat(prompt): persona + regra anti-tutorial + intent misto"
```

---

## Task 6: Resiliência do Gemini (`gemini.ts`)

Retry com backoff em erros transitórios, `GeminiUnavailableError` quando o Gemini cai de vez, retry extra em resposta vazia/inparseável, `temperature` 0.3, e `buildContextNote` que não empurra tutorial. Independente das Tasks 2/3/4/7.

**Files:**
- Modify: `src/services/llm/gemini.ts`

- [ ] **Step 1: Adicionar a classe de erro e os helpers de retry (logo após o `RESPONSE_SCHEMA`)**

Inserir, depois da constante `RESPONSE_SCHEMA` (antes de `export interface UserContext`):

```typescript
export class GeminiUnavailableError extends Error {
  constructor(message = 'Gemini indisponível após retries') {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Transitório = vale retentar. Status 5xx/429 ou erro de rede/timeout. Um 400
// (bug de request) NÃO é transitório — propaga sem retentar.
function isRetryableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|overloaded|deadline|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(
    message,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 3 tentativas (2 retentativas) com backoff + jitter. Lança GeminiUnavailableError
// quando esgota as retentativas num erro transitório; propaga o erro original se
// não for transitório (ex: 400).
async function generateWithRetry(
  request: Parameters<typeof ai.models.generateContent>[0],
): Promise<Awaited<ReturnType<typeof ai.models.generateContent>>> {
  const backoffMs = [500, 1500];
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      const canRetry = isRetryableError(error) && attempt < backoffMs.length;
      if (!canRetry) {
        if (isRetryableError(error)) {
          console.error('[gemini] giving up after retries', error);
          throw new GeminiUnavailableError();
        }
        throw error;
      }
      const waitMs = backoffMs[attempt]! + Math.floor(Math.random() * 250);
      console.warn('[gemini] retryable error, retrying', { attempt: attempt + 1, waitMs });
      await delay(waitMs);
    }
  }
}
```

- [ ] **Step 2: Reescrever `buildContextNote` pra não empurrar tutorial**

Substituir a função `buildContextNote` atual por:

```typescript
function buildContextNote(ctx: UserContext): string {
  if (!ctx.registered) {
    return '\n\nCONTEXTO DO REMETENTE: ainda NÃO tem cadastro. Se for primeiro contato, saudação ou tentativa de dividir conta, conduza pro cadastro (nome + chave PIX, ex: \'Sou João, pix joao@email.com\'). Caso contrário, responda natural seguindo a persona.';
  }
  if (!ctx.hasPix) {
    return '\n\nCONTEXTO DO REMETENTE: cadastrado, mas SEM chave PIX. Quando fizer sentido, lembre que falta a chave PIX (ex: \'pix joao@email.com\').';
  }
  const safeName = sanitizeName(ctx.name);
  const nome = safeName ? ` (nome: ${safeName})` : '';
  return `\n\nCONTEXTO DO REMETENTE: cadastrado${nome}, já sabe usar. Responda natural seguindo a persona; NÃO empurre tutorial nem repita instrução.`;
}
```

(`sanitizeName` permanece inalterada.)

- [ ] **Step 3: Reescrever `extractIntent` com retry de transporte + retry de resposta vazia + temp 0.3**

Substituir a função `extractIntent` inteira por:

```typescript
export async function extractIntent(text: string, ctx: UserContext): Promise<ExtractionResult> {
  console.log("[gemini] extracting", { text });
  const request = {
    model: "gemini-2.5-flash-lite",
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION + buildContextNote(ctx),
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      // 0.3 dá vida ao "reply" sem arriscar a extração — o responseSchema prende
      // os campos estruturados, e os números vêm do texto, não são amostrados.
      temperature: 0.3,
    },
  };

  // Resposta vazia/inparseável é "respondeu estranho", não "está fora" — tenta
  // mais uma vez antes de cair no fallback de confusão (unknown sem reply).
  // generateWithRetry, ao contrário, lança GeminiUnavailableError quando o
  // transporte falha de vez (503 etc.); isso sobe pro dispatcher virar instabilidade.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await generateWithRetry(request);
    const raw = response.text;
    console.log("[gemini] raw response", { raw });
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as ExtractionResult;
      console.log("[gemini] parsed", parsed);
      return parsed;
    } catch (error) {
      console.error("[gemini] failed to parse JSON", { raw, error });
    }
  }
  return { intent: "unknown" };
}
```

- [ ] **Step 4: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: o único erro restante é o do webhook (Tasks 3/4). `gemini.ts` em si compila. (Rodada isolada → PASS limpo.)

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/gemini.ts
git commit -m "feat(gemini): retry/backoff + GeminiUnavailableError + temp 0.3"
```

---

## Task 7: Dispatcher (`whatsapp.webhook.ts`) — fecha o bloco

Isola a extração (instabilidade em vez de silêncio), unifica a trilha conversa no `reply` → `voice.fallbackReply`, implementa o intent misto, e troca os templates removidos pelas funções do `voice.ts`. Ao fim desta task o `npx tsc --noEmit` volta a passar limpo.

**Files:**
- Modify: `src/routes/whatsapp.webhook.ts`

- [ ] **Step 1: Trocar os imports do topo**

Bloco atual (linhas 1-13):

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
import { unknownIntentsRepository } from "../repositories/unknown-intents.repository.js";
import { normalizeBrNumber } from "../lib/phone.js";
import { sendText } from "../services/whatsapp/whatsapp.js";
```

Passa a ser:

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { extractIntent, GeminiUnavailableError } from "../services/llm/gemini.js";
import { createBillFromExtraction, markPaid } from "../services/bills/bill.service.js";
import { handleRegistration } from "../services/users/user.service.js";
import { userRepository } from "../repositories/user.repository.js";
import { unknownIntentsRepository } from "../repositories/unknown-intents.repository.js";
import { normalizeBrNumber } from "../lib/phone.js";
import { sendText } from "../services/whatsapp/whatsapp.js";
import {
  fallbackReply,
  instability,
  askToRegister,
  askForPix,
} from "../services/messaging/voice.js";
import type { ExtractionResult } from "../services/bills/bill.types.js";
```

> Por que importar `ExtractionResult`: o `result` precisa ser anotado (Step 2). Sem anotação, `let result;` vira `any` implícito e a narrowing da discriminated union no `switch` não acontece — `result.bill`/`result.profile` deixariam de ser type-checked.

- [ ] **Step 2: Reescrever a IIFE de background (o bloco `void (async () => { ... })();`)**

Substituir todo o bloco atual (linhas ~56-96, do `void (async () => {` até `})();`) por:

```typescript
    // Responde 200 já e roda o fluxo em background (Evolution não re-tenta).
    void (async () => {
      const user = await userRepository.findByPhone(senderPhone);
      const ctx = { registered: !!user, hasPix: !!user?.pix_key, name: user?.name ?? "" };

      // Extração isolada: se o Gemini cair (503) ou der erro inesperado aqui,
      // manda instabilidade em vez de deixar o usuário no silêncio.
      let result: ExtractionResult;
      try {
        result = await extractIntent(text, ctx);
      } catch (err) {
        if (err instanceof GeminiUnavailableError) {
          console.warn("[webhook] gemini unavailable, sending instability message");
        } else {
          console.error("[webhook] extraction failed", err);
        }
        try {
          await sendText(senderPhone, instability());
        } catch (sendErr) {
          console.error("[webhook] failed to send instability message", sendErr);
        }
        return;
      }

      try {
        switch (result.intent) {
          case "register_account":
            if (!result.profile) { await sendText(senderPhone, fallbackReply({ registered: !!user })); break; }
            await handleRegistration(senderPhone, result.profile);
            break;

          case "create_bill": {
            if (!result.bill) { await sendText(senderPhone, fallbackReply({ registered: !!user })); break; }
            // Intent misto: a pessoa se apresentou E mandou a conta na mesma
            // mensagem. Registra o cadastro embutido (silencioso) e segue.
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

          default: {
            await unknownIntentsRepository.record({ phone: senderPhone, text, registered: !!user });
            console.log("[unknown-intent]", { phone: senderPhone, text });
            const softReply = result.intent === "unknown" ? result.reply?.trim() : undefined;
            if (softReply && softReply.length <= 300) {
              await sendText(senderPhone, softReply);
            } else {
              await sendText(senderPhone, fallbackReply({ registered: !!user }));
            }
          }
        }
        console.log("[webhook] flow finished ok");
      } catch (err) {
        console.error("[webhook] flow failed", err);
      }
    })();
```

- [ ] **Step 3: Verificar typecheck (fecha o bloco 3/4/7)**

Run: `npx tsc --noEmit`
Expected: **PASS limpo**. Se acusar `requireRegistrationFirst`/`requirePixFirst`/`notifyUnknown`, sobrou referência — conferir que o Step 1 removeu todas.

- [ ] **Step 4: Smoke manual (os casos dos prints)**

Stack local + `npm run dev`. Pelo WhatsApp:
- **"Obrigado!"** (cadastrado) → reconhecimento curto ("De nada! 😊"), **sem** tutorial.
- **"Quem é você?"** → descrição natural, **sem** o exemplo rígido.
- **"Qual a definição de número par?"** → recusa simpática, **sem** tutorial.
- **"oi"** (cadastrado) → cumprimento curto; (não-cadastrado, número limpo) → boas-vindas conduzindo pro cadastro.
- **Intent misto** sem PIX: "Sou Daiane e paguei 10 no sorvete, divide com o joão" → registra Daiane e responde **só** `askForPix("Daiane")` (não joga o nome fora, não duplica mensagem).
- **Intent misto** completo: "Sou Ana, pix ana@x.com, paguei 30 no lanche divide com Beto" → cria a conta direto (sem o "manda uma conta" antes).
- **Instabilidade:** forçar erro do Gemini (ex: setar `GEMINI_API_KEY` inválida e reiniciar o dev) → mandar qualquer mensagem → recebe a frase de instabilidade; nos logs aparecem as retentativas. Restaurar a key depois.

- [ ] **Step 5: Commit (bloco 3/4/7)**

```bash
git add src/services/users/user.service.ts src/services/bills/bill.types.ts src/routes/whatsapp.webhook.ts
git commit -m "feat(dispatcher): voz unificada, instabilidade no 503 e intent misto"
```

---

## Verificação final

- [ ] **`npx tsc --noEmit`** passa limpo na árvore inteira.
- [ ] **`git status`** limpo (sem arquivos não commitados de fonte; lembrar que rodar `LEDGER_SOURCE=mock` suja o mock JSON — não commitar isso).
- [ ] Revisar o diff completo: `git diff main...HEAD -- src/` — conferir que nenhum template antigo de "não entendi"/"Olá! Sou o Slice" sobrou fora do `voice.ts`/`prompt.ts`.

## Handoff de PR

Conforme o workflow do projeto (mudança de código → PR, merge é do Danubio):

```bash
git push -u origin feat/conversational-polish-resilience
gh pr create --base main --title "Conversa natural + resiliência do Gemini" \
  --body "Implementa docs/superpowers/specs/2026-05-29-conversational-polish-resilience.md"
```

**Não** auto-mergear — deixar pro Danubio (review do Copilot + controle de quando vai pra prod, que auto-deploya da main).
```
