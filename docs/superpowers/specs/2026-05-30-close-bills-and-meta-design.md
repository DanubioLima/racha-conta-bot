# Slice — Encerrar contas + pagar por conta + meta-requests

**Status:** approved (design) — implementation pending
**Date:** 2026-05-30
**Author:** Danubio + Claude (brainstorm)
**Depende de:** Fase 2 / memória de conversa (PR #11 mergeado) e o modelo `gemini-3.1-flash-lite` (PR #12)

---

## 1. Contexto e problema

Print de prod (pós-3.1) mostrou o Slice ainda "burro" em coisas óbvias, e o Danubio
não quer liberar assim:
- *"Pode fechar ela"* / *"Feche todas as contas em aberto"* → o bot não tem como
  fechar conta; caiu em `mark_paid`/`list_bills` e deu resposta sem sentido / só
  repetiu a lista.
- *"Me pagaram a conta da Netflix"* → `mark_paid` casa só nome de **pessoa**; o
  usuário nomeou a **conta** → "não achei ninguém pendente".
- *"Me resuma o que conversamos até agora"* → roteou pro `list_bills` (apesar de já
  ter histórico desde a Fase 2).

São **lacunas de capacidade/roteamento**, não só tom.

## 2. Escopo

**Faz parte:**
1. **Encerrar conta** (`close_bill`): "feche", "pode fechar ela", "feche todas". Tira
   das abertas (`status = CLOSED`), **sem fingir pagamento**. Se a conta tem pendente,
   **pede confirmação** antes de fechar.
2. **`mark_paid` por nome da CONTA**: "me pagaram a conta da Netflix" → marca a conta
   Netflix como paga (todos os pendentes dela).
3. **Meta-requests** ("resuma o que conversamos") → usa o histórico pra responder,
   **não** cai em `list_bills`.

**Não faz parte:** cancelar/descartar conta (≠ encerrar), reabrir conta, tunar
modelo/thinking (fica `gemini-3.1-flash-lite` + `MINIMAL`), comandos com slash.

## 3. Mudanças por componente

### 3.1 Tipos — `bill.types.ts`
- `ExtractionResult` ganha `| { intent: 'close_bill'; close: CloseInput }`.
- `CloseInput = { all?: boolean; reference?: string; confirmed?: boolean }`.
- `MarkPaidInput` ganha `bill?: string` (nome/descrição da conta nomeada como paga).

### 3.2 Schema — `gemini.ts` (`RESPONSE_SCHEMA`)
- `intent` enum += `"close_bill"`.
- Novo objeto `close` com `all` (BOOLEAN), `reference` (STRING), `confirmed` (BOOLEAN) — todos opcionais.
- `payment` ganha `bill` (STRING) opcional.
- `required` segue só `["intent"]`.

### 3.3 Prompt — `prompt.ts`
Adiciona/ajusta:
- **`== close_bill ==`**: o usuário quer ENCERRAR conta(s) (encerrar/fechar, "pode
  fechar ela", "feche todas"). Preencha `close`: `all=true` se "todas"; `reference` =
  descrição mencionada ou "ela"/"essa" (resolve pelo histórico/abertas); **`confirmed=true`
  SÓ quando o usuário está confirmando um "fecho assim mesmo?" anterior** (olhe o
  histórico). Encerrar ≠ marcar pago.
- **`mark_paid` por conta**: se o usuário disser que uma CONTA/estabelecimento foi pago
  ("me pagaram a conta da Netflix", "pagaram a pizza"), preencha `payment.bill` com o
  nome da conta — NÃO `payment.name` (que é pessoa).
- **Meta**: "resuma o que conversamos / sobre o que falávamos / o que a gente combinou"
  → intent `unknown` com `reply` usando o histórico. `list_bills` é só pra "ver minhas
  contas / quanto falta", nunca pra meta-pergunta sobre a conversa.
- Exemplos few-shot pra cada (incluindo um "fecho assim mesmo?" → "sim" com `confirmed:true`).

### 3.4 `bill.service.ts`
**`closeBills(ownerPhone, input: CloseInput): Promise<string>`** (retorna a mensagem pro histórico):
- `open = findOpenForOwner`. Vazio → "Você não tem nenhuma conta em aberto pra fechar."
- **Alvos:** `all` → todas as abertas; senão `reference` casa descrição (substring,
  case-insensitive); sem `reference` e só 1 aberta → essa; referência casa >1 ou
  nenhuma → pergunta/avisa ("Qual delas? Em aberto: …" / "Não achei a conta '…'. Em aberto: …").
- **Confirmação:** se algum alvo tem participante PENDING e `confirmed != true` →
  **não fecha**; responde "A conta {desc} ainda tem {nomes} sem pagar. Fecho assim
  mesmo? (responde 'sim')" (uma) ou "Tem conta com gente devendo ({…}). Fecho todas
  assim mesmo?" (todas).
- Senão (sem pendente, ou `confirmed=true`) → `status = CLOSED` nos alvos →
  "Encerrei a conta {desc} ✅" (uma) / "Encerrei suas {N} contas em aberto ✅" (todas).

**`markPaid` ganha o caminho por conta:** se `input.bill` → acha a aberta que casa a
descrição; 1 → marca TODOS os pendentes dela PAID (conta fecha) → "Boa! A conta {desc}
foi paga, todo mundo quitou 💸"; nenhuma → "Não achei a conta '{bill}'. Em aberto: …";
várias → "Qual conta? Em aberto: …". Sem `input.bill` → lógica por pessoa atual (intocada).

### 3.5 `dispatch-message.ts`
- Novo `case "close_bill"`: `if (!user) → askToRegister()`; senão
  `botTurn = await closeBills(senderPhone, result.close ?? {})`.
- `mark_paid`: chamada inalterada (`markPaid(senderPhone, result.payment ?? {})`) — o
  caminho por conta vive dentro de `markPaid`.

### 3.6 `voice.ts`
Strings novas (fonte única): `billClosedManually(desc)`, `billsClosedAll(n)`,
`confirmCloseOne(desc, pendingNames)`, `confirmCloseAll(billsComPendente)`,
`billPaidWhole(desc)`, e os "não achei conta/qual delas". PIX nunca aparece.

## 4. Testes (em cima da rede existente)
Determinístico/testável:
- `closeBills`: (a) 1 conta sem pendente → CLOSED + msg; (b) 1 com pendente, `confirmed`
  ausente → pede confirmação, **segue OPEN**; (c) mesma com `confirmed:true` → CLOSED;
  (d) `all` → todas CLOSED (ou confirma se houver pendente); (e) nenhuma aberta → msg;
  (f) referência ambígua → pergunta.
- `markPaid` por conta: conta nomeada, 1 match → todos pendentes PAID + CLOSED; nenhuma → msg.
- dispatcher: `close_bill` grava o `botTurn` real no histórico (sem PIX).

**Smoke (LLM ao vivo, Danubio):** classificação certa de fechar vs listar vs resumir
vs "pagaram a conta X"; o `confirmed` ser setado certo no "sim"; qualidade do resumo
da conversa. CI stuba o LLM → não cobre acurácia de classificação.

## 5. Guardrails / riscos
- **`CLOSED` passa a significar "tudo pago" OU "encerrado manualmente"** — as mensagens
  deixam claro qual (nunca mentir que pagou). `findOpenForOwner` já filtra `status='OPEN'`,
  então conta encerrada some das abertas e o scanner/expiração a ignora.
- **Fechar é sticky** (não há reabrir) → a confirmação-com-pendente é o guarda-corpo.
- **`close_bill` vs `mark_paid`-por-conta são intents próximos** (encerrar ≠ pago) —
  precisa de exemplos claros no prompt; risco de confusão que só o smoke pega.
- **Confirmação depende do `confirmed` vindo do modelo via histórico** — se ele não
  setar, o pior caso é perguntar de novo (não fecha errado). Aceitável.
- PIX nunca em log nem no histórico (mantido).

## 6. Arquivos
`bill.types.ts`, `gemini.ts`, `prompt.ts`, `bill.service.ts`, `dispatch-message.ts`,
`voice.ts`; testes novos em `bill.service` (close/settle) e `dispatch`/`conversation`.
