# Slice — Respostas "soft" geradas (fluidez conversacional)

**Status:** approved (design) — implementation pending
**Date:** 2026-05-26
**Author:** Danubio + Claude (brainstorm)
**Depende de:** multi-user lite (`2026-05-25-multiuser-lite-mark-paid.md`) — já em prod

---

## 1. Problema

Hoje, qualquer mensagem que o Gemini não classifica (intent `unknown`) recebe a
MESMA resposta genérica. Saudações ("oi", "bom dia") e qualquer coisa fora do
esperado caem nesse `unknown` e batem num muro robótico que não orienta o
usuário. Na validação com poucos testers, isso vira fricção (a pessoa não
descobre o que o bot faz e desiste).

## 2. Decisão

**Híbrido, priorizando reduzir fricção.** O que exige exatidão continua
determinístico (PIX copia-e-cola, resumo da conta, valores, confirmação de quem
pagou). Os momentos "soft" — **só o caso `unknown`, que já inclui saudações** —
passam a ter uma resposta **gerada e contextual**, curta, que guia o usuário pra
uma capacidade real.

**Uma chamada só:** a classificação que já roda em toda mensagem
(`extractIntent`) passa a, quando o intent for `unknown`, devolver também um
campo `reply`. Sem segunda chamada ao Gemini, sem custo/latência extra. Sem
intent novo (saudação continua sendo `unknown`).

Abordagens consideradas e descartadas:
- **Templates puros com variedade** — barato mas teto baixo de naturalidade; o
  ganho de fricção vem mais de *orientar contextualmente* do que de variar frase.
- **Segunda chamada dedicada no unknown** — mais contextual, mas chamada extra
  (custo/latência) e mais código; não compensa no estágio de validação.

## 3. Mudanças

### 3.1 `src/services/llm/gemini.ts`
- `RESPONSE_SCHEMA` ganha `reply` (STRING, opcional).
- `ExtractionResult` (em `bill.types.ts`): a variante `unknown` ganha
  `reply?: string`. As outras variantes não mudam.
- A função vira `extractIntent(text, ctx)`, onde `ctx` descreve o estado do
  remetente: `{ registered: boolean; hasPix: boolean; name?: string }`.
- **Contexto sem bagunçar a classificação:** o `ctx` é injetado **no
  systemInstruction daquela chamada** (montado em runtime:
  `SYSTEM_INSTRUCTION + nota de contexto`), enquanto o `contents` continua sendo
  só o texto do usuário. Assim a classificação de `create_bill`/`register`/
  `mark_paid` não é afetada — o contexto só orienta o `reply` do `unknown`.

### 3.2 `src/services/llm/prompt.ts`
Adiciona instrução: quando o intent for `unknown`, preencher `reply` com uma
frase **curta, em PT-BR, calorosa e que conduz pra uma capacidade real**:
- Saudação ("oi", "bom dia") → boas-vindas + o que dá pra fazer.
- Gibberish/sem sentido ("asdf", "...") → re-pergunta gentil.
- Adaptar pela nota de contexto do usuário (ver §3.3).
- **Nunca** inventar recurso que o bot não tem; **nunca** colocar string PIX nem
  valores no `reply`. Pros intents não-`unknown`, `reply` é omitido (quem
  responde são os handlers determinísticos).

### 3.3 Flavors de contexto (a nota injetada no systemInstruction)
- **não-cadastrado** → conduz pro cadastro (nome + chave PIX).
- **cadastrado sem PIX** → pede a chave PIX.
- **cadastrado (com nome)** → sugere "paguei X, divide com Ana e Beto" ou
  "a Ana me pagou".

### 3.4 `src/routes/whatsapp.webhook.ts` (dispatcher)
- O `user` já é buscado antes de classificar; monta-se
  `ctx = { registered: !!user, hasPix: !!user?.pix_key, name: user?.name }` e
  passa pra `extractIntent(text, ctx)`.
- No caso `default` (unknown): continua registrando o unknown (analytics) e
  logando; **se** `result.reply` for válido (não-vazio, ≤ ~300 chars), manda ele
  via `sendText`; **senão** cai no `notifyUnknown(senderPhone, !!user)`
  determinístico de hoje (fallback).

## 4. Guardrails / error handling
- `reply` ausente, vazio ou maior que o cap → fallback no template determinístico.
- Se a chamada ao Gemini falhar, `extractIntent` já retorna `{ intent: 'unknown' }`
  sem `reply` → fallback. **Nunca piora em relação ao comportamento atual.**
- O `unknown` continua sendo gravado em `data/unknown-intents.json`
  independentemente de ter `reply` ou não.

## 5. Fora de escopo
- Mensagens de exatidão (resumo da conta, PIX, confirmação de pagamento,
  persistência de cadastro) — continuam determinísticas.
- Mudança de fluxo do "reenviar a conta após coletar PIX lazy" — é melhoria de
  fluxo, não de tom; fica pra depois.
- Persona/personagem elaborado — prioridade é fricção, não personalidade;
  mantém o tom curto e amigável que já existe ("Olá! Sou o Slice 👋").

## 6. Testing
Convenção do projeto: sem testes automatizados — `npx tsc --noEmit` + smoke
manual. Smoke:
- "oi" (remetente não-cadastrado) → resposta calorosa conduzindo pro cadastro.
- "asdf" → re-pergunta gentil.
- "oi" (remetente cadastrado) → sugere criar conta / marcar pago.
- `create_bill` / `register_account` / `mark_paid` continuam funcionando igual.
- Forçar `reply` vazio (ou Gemini indisponível) → cai no template antigo.
