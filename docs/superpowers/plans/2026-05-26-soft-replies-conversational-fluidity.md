# Soft Generated Replies (Conversational Fluidity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando o Gemini não classifica a mensagem (`unknown`), devolver na MESMA chamada um `reply` curto e contextual que orienta o usuário, em vez do template genérico fixo.

**Architecture:** A chamada de classificação (`extractIntent`) passa a receber o estado do remetente (`UserContext`) e, via systemInstruction dinâmico, gera um `reply` só no caso `unknown`. O dispatcher manda esse `reply` se válido, senão cai no `notifyUnknown` determinístico (fallback). Determinístico onde exatidão importa; gerado só nos momentos "soft".

**Tech Stack:** TypeScript ESM, `@google/genai` (Gemini 2.5 flash-lite), Fastify.

**Verificação (override de TDD):** projeto sem testes automatizados — `npx tsc --noEmit` + smoke manual. Não adicionar framework de teste.

---

## File structure overview

Tudo modificação, nenhum arquivo novo:
- `src/services/bills/bill.types.ts` — `reply?: string` na variante `unknown`
- `src/services/llm/gemini.ts` — `UserContext`, `reply` no schema, `buildContextNote`, `extractIntent(text, ctx)`
- `src/services/llm/prompt.ts` — instrução + exemplos do campo `reply`
- `src/routes/whatsapp.webhook.ts` — monta `ctx`, passa pro `extractIntent`, manda `reply` com fallback

Mudança acoplada (a assinatura do `extractIntent` muda e o webhook é o único caller), então é um task só, terminando com `tsc` limpo.

---

## Task 1: Reply contextual gerado no caso `unknown`

**Files:**
- Modify: `src/services/bills/bill.types.ts`
- Modify: `src/services/llm/gemini.ts`
- Modify: `src/services/llm/prompt.ts`
- Modify: `src/routes/whatsapp.webhook.ts`

- [ ] **Step 1: `reply?` na variante `unknown`**

Em `src/services/bills/bill.types.ts`, na `ExtractionResult`, trocar a última variante:

```typescript
export type ExtractionResult =
  | { intent: 'create_bill'; bill: ExtractedBill }
  | { intent: 'register_account'; profile: RegisterProfile }
  | { intent: 'mark_paid'; payment: MarkPaidInput }
  | { intent: 'unknown'; reply?: string };
```

(As outras variantes não mudam.)

- [ ] **Step 2: `gemini.ts` — UserContext, schema `reply`, contexto dinâmico, nova assinatura**

Em `src/services/llm/gemini.ts`:

(a) Adicionar `reply` às `properties` do `RESPONSE_SCHEMA` (irmão de `intent`/`bill`/`profile`/`payment`):

```typescript
    reply: { type: Type.STRING },
```

(b) Acima da função `extractIntent`, adicionar o tipo e o helper:

```typescript
export interface UserContext {
  registered: boolean;
  hasPix: boolean;
  name: string; // '' quando ainda não coletado
}

function buildContextNote(ctx: UserContext): string {
  if (!ctx.registered) {
    return '\n\nCONTEXTO DO REMETENTE: ainda NÃO tem cadastro. No campo "reply" (quando intent=unknown), conduza pro cadastro: peça nome + chave PIX, ex: \'Sou João, pix joao@email.com\'.';
  }
  if (!ctx.hasPix) {
    return '\n\nCONTEXTO DO REMETENTE: cadastrado, mas SEM chave PIX. No campo "reply" (unknown), peça a chave PIX, ex: \'pix joao@email.com\'.';
  }
  const nome = ctx.name ? ` (nome: ${ctx.name})` : '';
  return `\n\nCONTEXTO DO REMETENTE: cadastrado${nome}. No campo "reply" (unknown), sugira criar uma conta ('paguei 60 na pizza, divide com Ana e Beto') ou marcar pago ('a Ana me pagou').`;
}
```

(c) Trocar a assinatura e o `systemInstruction` da chamada (resto da função igual):

```typescript
export async function extractIntent(text: string, ctx: UserContext): Promise<ExtractionResult> {
  console.log("[gemini] extracting", { text });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION + buildContextNote(ctx),
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

- [ ] **Step 3: `prompt.ts` — instrução do campo `reply` + exemplos**

Em `src/services/llm/prompt.ts`, na seção `== unknown ==`, substituir:

```
== unknown ==
Saudação, mensagem sem dados, ambígua ou lixo → {"intent":"unknown"}.
```

por:

```
== unknown ==
Saudação, mensagem sem dados, ambígua ou lixo → intent "unknown".
Quando o intent for "unknown", preencha TAMBÉM o campo "reply": uma frase CURTA
(1-2 linhas), em PT-BR, calorosa, que conduz o usuário pra uma capacidade REAL
do bot. Adapte usando a "CONTEXTO DO REMETENTE" fornecida.
- Saudação ("oi", "bom dia") → cumprimente de volta + diga o que dá pra fazer.
- Lixo/sem sentido ("asdf", "...") → peça gentilmente pra reformular.
NUNCA invente recurso que o bot não tem. NUNCA coloque chave PIX nem valores no "reply".
Para os outros intents (create_bill, register_account, mark_paid), NÃO preencha "reply".
```

E trocar o exemplo final:

```
"Bom dia, tudo bem?"
{"intent":"unknown"}
```

por:

```
"Bom dia, tudo bem?"
{"intent":"unknown","reply":"Bom dia! 😄 Eu te ajudo a dividir contas — manda algo tipo \"paguei 60 na pizza, divide com Ana e Beto\"."}

"asdf"
{"intent":"unknown","reply":"Não peguei essa 🤔 Me manda algo tipo \"paguei 60 na pizza, divide com Ana e Beto\" ou \"a Ana me pagou\"."}
```

- [ ] **Step 4: `whatsapp.webhook.ts` — monta ctx, passa, manda reply com fallback**

(a) Adicionar o import do `sendText` no topo (junto dos outros imports):

```typescript
import { sendText } from "../services/whatsapp/whatsapp.js";
```

(b) Trocar a chamada do `extractIntent` (dentro do `void (async () => {`), de
`const result = await extractIntent(text);` para:

```typescript
        const result = await extractIntent(text, {
          registered: !!user,
          hasPix: !!user?.pix_key,
          name: user?.name ?? "",
        });
```

(c) Trocar o caso `default` do switch por (note as chaves `{ }` — `const` dentro de case precisa de bloco):

```typescript
          default: {
            await unknownIntentsRepository.record({ phone: senderPhone, text, registered: !!user });
            console.log("[unknown-intent]", { phone: senderPhone, text });
            const reply = result.reply?.trim();
            if (reply && reply.length <= 300) {
              await sendText(senderPhone, reply);
            } else {
              await notifyUnknown(senderPhone, !!user);
            }
          }
        }
```

(O `}` extra fecha o `switch` — confira a indentação contra o arquivo atual.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros. (Pontos de atenção: a narrowing do `result.reply` no `default` — só compila porque a variante `unknown` agora tem `reply?`; e `name: user?.name ?? ""` casa com `UserContext.name: string`.)

- [ ] **Step 6: Smoke manual do Gemini (recomendado — precisa de `GEMINI_API_KEY` no `.env`)**

Run:
```bash
npx tsx -e "import('./src/services/llm/gemini.js').then(async m => {
  console.log('oi / não-cadastrado →', JSON.stringify(await m.extractIntent('oi', { registered:false, hasPix:false, name:'' })));
  console.log('oi / cadastrado →', JSON.stringify(await m.extractIntent('oi', { registered:true, hasPix:true, name:'João' })));
  console.log('asdf →', JSON.stringify(await m.extractIntent('asdf', { registered:true, hasPix:true, name:'João' })));
  console.log('create_bill →', JSON.stringify(await m.extractIntent('paguei 60 na pizza divide com Ana e Beto', { registered:true, hasPix:true, name:'João' })));
})"
```
Expected:
- "oi" não-cadastrado → `intent:"unknown"` com `reply` conduzindo ao cadastro (nome+PIX).
- "oi" cadastrado → `intent:"unknown"` com `reply` sugerindo criar conta / marcar pago.
- "asdf" → `intent:"unknown"` com `reply` de re-pergunta gentil.
- create_bill → `intent:"create_bill"` (sem depender de `reply`), classificação intacta.

- [ ] **Step 7: Commit**

```bash
git add src/services/bills/bill.types.ts src/services/llm/gemini.ts src/services/llm/prompt.ts src/routes/whatsapp.webhook.ts
git commit -m "feat(llm): contextual generated reply for unknown intent"
```

---

## Self-review

| Requisito do spec | Coberto em |
|---|---|
| §3.1 `reply` no schema + `extractIntent(text, ctx)` | Task 1 steps 1-2 |
| §3.2 instrução do `reply` no prompt | Task 1 step 3 |
| §3.3 flavors de contexto (não-cadastrado / sem-PIX / cadastrado) | `buildContextNote` (step 2b) |
| §3.4 dispatcher monta ctx + manda reply com fallback | Task 1 step 4 |
| §4 guardrails (vazio/grande/Gemini falha → fallback) | step 4c (`reply && length<=300`) + `extractIntent` retorna unknown sem reply em falha |
| §6 smoke | step 6 |

**Placeholder scan:** sem TBD/TODO; todo step tem código/comando concreto.

**Type consistency:** `UserContext { registered, hasPix, name: string }` definido no step 2b e consumido no step 4b (`name: user?.name ?? ""`). `extractIntent(text, ctx)` (step 2c) bate com o call site (step 4b). `result.reply` (step 4c) existe porque a variante `unknown` ganhou `reply?` (step 1). `notifyUnknown(phone, hasUser)` e `sendText(to, text)` são assinaturas já existentes no projeto.
