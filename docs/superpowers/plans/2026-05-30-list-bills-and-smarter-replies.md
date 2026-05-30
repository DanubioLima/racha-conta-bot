# Listar contas + respostas menos "burras" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao Slice um intent de **listar contas em aberto** e fazê-lo responder perguntas óbvias (capacidades, off-topic variado) e usar descrição vazia em vez de "Conta".

**Architecture:** Novo intent `list_bills` classificado pelo Gemini → `bill.service.listOpenBills` busca `findOpenForOwner` e formata via `voice.openBillsList` (resumo compacto). Ajustes de prompt separam "pergunta sobre o bot" de off-topic e variam a recusa. Descrição vazia (`""`) é renderizada graciosamente nas frases de dinheiro. Caminho do dinheiro segue determinístico; sem memória de conversa.

**Tech Stack:** Node ≥20 + TypeScript (ESM, imports com `.js`), Fastify, Evolution API (Baileys), `@google/genai` (Gemini `gemini-2.5-flash-lite`), better-sqlite3.

**Convenção de verificação (override de TDD):** o projeto **não usa testes automatizados** — decisão do dono. Cada task verifica com `npx tsc --noEmit` (limpo) + smoke manual descrito, e commita. **Não** escrever vitest/jest. O smoke (Docker + WhatsApp) é manual/humano; o gate do executor é o `tsc`.

**Spec:** [`docs/superpowers/specs/2026-05-30-list-bills-and-smarter-replies-design.md`](../specs/2026-05-30-list-bills-and-smarter-replies-design.md)

---

## File structure overview

Todas modificações (nenhum arquivo novo). Tasks independentes, cada uma commitável e `tsc`-limpa, na ordem abaixo (respeita dependências: voice antes do service; tipo antes do dispatcher; service antes do dispatcher):

- `src/services/messaging/voice.ts` — `openBillsList` novo + descrição vazia em `billCreatedHeadline`/`billClosed`.
- `src/services/bills/bill.types.ts` — `ExtractionResult` ganha `{ intent: 'list_bills' }`.
- `src/services/llm/gemini.ts` — enum do schema ganha `"list_bills"`.
- `src/services/llm/prompt.ts` — list_bills + capacidades + off-topic variado + descrição vazia.
- `src/services/bills/bill.service.ts` — `listOpenBills(ownerPhone)`.
- `src/routes/whatsapp.webhook.ts` — `case "list_bills"`.

---

## Task 1: `voice.ts` — `openBillsList` + descrição vazia

**Files:**
- Modify: `src/services/messaging/voice.ts`

- [ ] **Step 1: Tratar descrição vazia em `billCreatedHeadline`**

Substituir a função atual por (omite o " em {desc}" quando vazia):

```typescript
export function billCreatedHeadline(params: {
  total: number;
  description: string;
  amountPerPerson: number;
  participantNames: string[];
}): string {
  const names = joinNames(params.participantNames);
  const where = params.description ? ` em ${params.description}` : '';
  return (
    `Anotei: ${formatBRL(params.total)}${where}, ` +
    `${formatBRL(params.amountPerPerson)} pra cada. Te mando o PIX de ${names} 👇`
  );
}
```

- [ ] **Step 2: Tratar descrição vazia em `billClosed`**

Substituir a função atual por:

```typescript
export function billClosed(description: string): string {
  const what = description ? description : 'a conta';
  return `Fechou! Todo mundo pagou ${what}. Saldo zerado 💸`;
}
```

- [ ] **Step 3: Adicionar `openBillsList`** (no fim do arquivo, depois de `billClosed`)

```typescript
// ---- Listagem de contas em aberto ----

// Resumo compacto das contas ABERTAS do dono (1 linha por conta). Recebe um shape
// mínimo pra não acoplar voice.ts ao tipo Bill. Como só vêm contas OPEN, sempre há
// ao menos 1 pendente por conta.
export function openBillsList(
  bills: { description: string; total: number; pending: string[] }[],
): string {
  if (bills.length === 0) return 'Você não tem nenhuma conta em aberto 🎉';
  const lines = bills.map((bill) => {
    const label = bill.description
      ? `${bill.description} — ${formatBRL(bill.total)}`
      : formatBRL(bill.total);
    const missing =
      bill.pending.length === 1
        ? `falta ${bill.pending[0]}`
        : `faltam ${bill.pending.length}: ${bill.pending.join(', ')}`;
    return `• ${label} (${missing})`;
  });
  return `Suas contas em aberto:\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS limpo (`billCreatedHeadline`/`billClosed` mantêm a mesma assinatura; `openBillsList` é export novo).

- [ ] **Step 5: Commit**

```bash
git add src/services/messaging/voice.ts
git commit -m "$(printf 'feat(voice): openBillsList + descrição vazia gracioso\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: `bill.types.ts` — variante `list_bills`

**Files:**
- Modify: `src/services/bills/bill.types.ts`

- [ ] **Step 1: Adicionar a variante ao `ExtractionResult`**

Bloco atual:

```typescript
export type ExtractionResult =
  | { intent: 'create_bill'; bill: ExtractedBill; profile?: RegisterProfile }
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
  | { intent: 'list_bills' }
  | { intent: 'unknown'; reply?: string };
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS limpo. O `switch` do webhook tem `default`, então a nova variante não dispara erro de exaustividade; ninguém referencia `list_bills` ainda.

- [ ] **Step 3: Commit**

```bash
git add src/services/bills/bill.types.ts
git commit -m "$(printf 'feat(types): ExtractionResult ganha variante list_bills\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: `gemini.ts` — enum do schema

**Files:**
- Modify: `src/services/llm/gemini.ts`

- [ ] **Step 1: Adicionar `"list_bills"` ao enum de `intent`**

Linha atual (dentro de `RESPONSE_SCHEMA.properties.intent`):

```typescript
    intent: { type: Type.STRING, enum: ["create_bill", "register_account", "mark_paid", "unknown"] },
```

Passa a ser:

```typescript
    intent: { type: Type.STRING, enum: ["create_bill", "register_account", "mark_paid", "list_bills", "unknown"] },
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS limpo.

- [ ] **Step 3: Commit**

```bash
git add src/services/llm/gemini.ts
git commit -m "$(printf 'feat(gemini): schema enum aceita intent list_bills\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: `prompt.ts` — list_bills + capacidades + off-topic + descrição vazia

**Files:**
- Modify: `src/services/llm/prompt.ts`

- [ ] **Step 1: Substituir o `SYSTEM_INSTRUCTION` inteiro**

Substituir todo o `export const SYSTEM_INSTRUCTION = \`...\`.trim();` por EXATAMENTE isto (mantém os emojis 😊🙂😄😅👋🤔 e os acentos; preserva o wrapper de template literal + `.trim()`). Mudanças vs atual: linha de intents inclui `list_bills`; PERSONA lista "listar contas" e perde o bullet de off-topic (agora no `unknown`); `create_bill` ganha a regra de description vazia; nova seção `== list_bills ==`; `== unknown ==` separa "pergunta sobre você" de off-topic e manda variar a recusa; exemplos novos (list_bills, capacidade, 2º off-topic) e identidade atualizada.

```typescript
export const SYSTEM_INSTRUCTION = `
Você é o Slice, um bot brasileiro de dividir contas no WhatsApp. Recebe UMA
mensagem em português e retorna SEMPRE JSON estrito seguindo o schema. Escolha um
"intent" entre: create_bill, register_account, mark_paid, list_bills, unknown.

== PERSONA (vale principalmente pro campo "reply") ==
Caloroso, brasileiro, direto. Fale como um amigo que resolve, não como atendente
de robô. Frases curtas (é WhatsApp). No máximo 1 emoji por mensagem, às vezes
nenhum. Você sabe: registrar (nome+PIX), dividir conta gerando PIX, marcar quem
pagou, e listar as contas em aberto do usuário.
- Responda ao que a pessoa disse, curto e direto. NÃO transforme toda resposta num
  tutorial. O exemplo de formato ("paguei 60 na pizza, divide com Ana e Beto") é
  ferramenta de ENSINO: só use quando a pessoa precisa aprender o formato (primeiro
  contato/cadastro ou confusão genuína). Pra quem já sabe usar, NÃO repita instrução.
- NUNCA invente recurso que você não tem. NUNCA coloque chave PIX nem valores no "reply".

== create_bill ==
O usuário descreve uma despesa que ELE JÁ PAGOU e como dividir. Preencha "bill":
- description: estabelecimento/descrição curta. Se NÃO houver estabelecimento
  claro (ex: "divide uma conta de 20"), deixe description como string vazia "" —
  não invente "Conta".
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

== list_bills ==
O usuário quer VER as contas dele em aberto, saber quanto falta, ou o que já
registrou. Ex: "liste contas em aberto", "minhas contas", "quais contas você
registrou", "quanto falta", "o que tá em aberto". Intent "list_bills" (sem outros
campos).

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
- Pergunta sobre VOCÊ ("quem é você", "o que você faz", "o que mais você faz",
  "sabe fazer algo além de dividir conta", "me explica"): responda em 1-2 linhas o
  que você faz (registrar PIX, dividir conta, marcar quem pagou, listar contas em
  aberto). É pergunta sobre VOCÊ — NÃO é off-topic.
- Off-topic = pergunta sobre o MUNDO (matemática, clima, notícias), não sobre você
  nem sobre as contas: recuse com simpatia + 1 linha do que você faz. VARIE a
  recusa, não repita sempre a mesma frase.
- Lixo/sem sentido ("asdf", "..."): peça gentilmente pra reformular.
Para create_bill, register_account, mark_paid e list_bills, NÃO preencha "reply".

EXEMPLOS:

"Paguei 60 na pizzaria, dividir com João e Maria, 20 cada"
{"intent":"create_bill","bill":{"description":"Pizzaria","total_amount":60,"headcount":3,"participants":[{"name":"João","amount_due":20},{"name":"Maria","amount_due":20}]}}

"Sou a Ana e paguei 30 no lanche, divide comigo e com o Beto"
{"intent":"create_bill","bill":{"description":"Lanche","total_amount":30,"headcount":2,"participants":[{"name":"Beto","amount_due":15}]},"profile":{"name":"Ana"}}

"divide uma conta de 20 com o João"
{"intent":"create_bill","bill":{"description":"","total_amount":20,"headcount":2,"participants":[{"name":"João","amount_due":10}]}}

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

"Liste contas em aberto"
{"intent":"list_bills"}

"Quais contas você registrou pra mim?"
{"intent":"list_bills"}

"Quanto ainda falta?"
{"intent":"list_bills"}

"Obrigado!"
{"intent":"unknown","reply":"De nada! 😊"}

"Quem é você?"
{"intent":"unknown","reply":"Sou o Slice 🙂 Eu divido conta no PIX, marco quem já pagou e te mostro suas contas em aberto."}

"Você sabe fazer algo além de dividir conta?"
{"intent":"unknown","reply":"Além de dividir, eu marco quem já pagou e te mostro suas contas em aberto 🙂"}

"Qual a definição de número par?"
{"intent":"unknown","reply":"Essa eu não sei 😅 Eu cuido mesmo é de dividir conta."}

"Que horas são?"
{"intent":"unknown","reply":"Aí já é fora da minha praia 😄 Eu sou bom é em rachar conta."}

"oi"
{"intent":"unknown","reply":"Opa! 👋 Tudo bom?"}

"asdf"
{"intent":"unknown","reply":"Não peguei essa 🤔 Me explica de outro jeito?"}
`.trim();
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS limpo (arquivo é uma string).

- [ ] **Step 3: Commit**

```bash
git add src/services/llm/prompt.ts
git commit -m "$(printf 'feat(prompt): list_bills + perguntas de capacidade + off-topic variado + desc vazia\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: `bill.service.ts` — `listOpenBills`

**Files:**
- Modify: `src/services/bills/bill.service.ts`

- [ ] **Step 1: Importar `openBillsList`**

Bloco de import atual (linhas 6-11):

```typescript
import {
  formatBRL,
  billCreatedHeadline,
  paymentReceived,
  billClosed,
} from "../messaging/voice.js";
```

Passa a ser:

```typescript
import {
  formatBRL,
  billCreatedHeadline,
  paymentReceived,
  billClosed,
  openBillsList,
} from "../messaging/voice.js";
```

- [ ] **Step 2: Adicionar `listOpenBills`** (depois de `createBillFromExtraction`, antes do bloco `// ---- mark_paid (manual) ----`)

```typescript
export async function listOpenBills(ownerPhone: string): Promise<void> {
  const bills = await billRepository.findOpenForOwner(ownerPhone);
  const summary = bills.map((bill) => ({
    description: bill.description,
    total: bill.total_amount,
    pending: bill.participants.filter((p) => p.status === "PENDING").map((p) => p.name),
  }));
  await sendText(ownerPhone, openBillsList(summary));
}
```

- [ ] **Step 3: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS limpo (`openBillsList` existe desde a Task 1; `findOpenForOwner` já existe no `billRepository`).

- [ ] **Step 4: Commit**

```bash
git add src/services/bills/bill.service.ts
git commit -m "$(printf 'feat(bills): listOpenBills (resumo das contas abertas do dono)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: `whatsapp.webhook.ts` — case `list_bills`

**Files:**
- Modify: `src/routes/whatsapp.webhook.ts`

- [ ] **Step 1: Importar `listOpenBills`**

Linha de import atual:

```typescript
import { createBillFromExtraction, markPaid } from "../services/bills/bill.service.js";
```

Passa a ser:

```typescript
import { createBillFromExtraction, markPaid, listOpenBills } from "../services/bills/bill.service.js";
```

- [ ] **Step 2: Adicionar o `case "list_bills"`** no `switch (result.intent)`, logo após o bloco `case "mark_paid": ... break;`

```typescript
          case "list_bills":
            if (!user) { await sendText(senderPhone, askToRegister()); break; }
            await listOpenBills(senderPhone);
            break;
```

(`askToRegister` e `sendText` já estão importados no arquivo desde o PR #8.)

- [ ] **Step 3: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: PASS limpo. `result` é tipado `ExtractionResult` (com `list_bills` desde a Task 2), então o `case` narrowa corretamente.

- [ ] **Step 4: Smoke manual** (stack local + `npm run dev`)

Pelo WhatsApp, com um user cadastrado e ao menos 1 conta aberta:
- "Liste contas em aberto" / "quais contas você registrou" → resumo compacto:
  `Suas contas em aberto:` + `• {desc} — R$ X (falta Y)` / `(faltam N: ...)`.
- Sem contas abertas → "Você não tem nenhuma conta em aberto 🎉".
- "Liste contas" de usuário NÃO cadastrado → `askToRegister`.
- "Você sabe fazer algo além de dividir conta?" → responde capacidades (inclui
  listar), **não** off-topic.
- Off-topic 2-3× seguidos ("quanto é 2+2?", "que dia é hoje?") → recusas variam.
- "divide uma conta de 20 com o joão" → "Anotei: R$ 20,00, R$ 10,00 pra cada..."
  **sem** "em Conta"; ao fechar → "...pagou a conta."; na lista → "• R$ 20,00 (...)".
- create_bill com estabelecimento, mark_paid, register_account continuam iguais.

- [ ] **Step 5: Commit**

```bash
git add src/routes/whatsapp.webhook.ts
git commit -m "$(printf 'feat(dispatcher): case list_bills (lista contas abertas do dono)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Verificação final
- [ ] `npx tsc --noEmit` limpo na árvore inteira.
- [ ] `git diff main...HEAD -- src/` — conferir os 6 arquivos e nada a mais.
- [ ] PR contra `main` (workflow do projeto; merge é do Danubio):
  ```bash
  git push -u origin feat/list-bills-and-smarter-replies
  gh pr create --base main --title "Listar contas + respostas menos burras" \
    --body "Implementa docs/superpowers/specs/2026-05-30-list-bills-and-smarter-replies-design.md"
  ```
  **Não** auto-mergear.
