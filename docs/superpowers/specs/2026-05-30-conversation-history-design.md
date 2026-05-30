# Slice — Fase 2: Nível 1.5 (memória de conversa)

**Status:** approved (design) — implementation pending
**Date:** 2026-05-30
**Author:** Danubio + Claude (brainstorm)
**Depende de:** Fase 1 (PR #10 mergeado — `dispatchIncomingMessage` testável + rede de testes,
spec `2026-05-30-integration-test-harness-design.md`)

---

## 1. Contexto e decisão

O Slice classifica uma mensagem por vez, sem memória. Pro usuário jovem acostumado
com IA isso soa robótico. Decidimos o **Nível 1.5** (meio-termo entre o bot atual e
um agente ChatGPT; agente cheio e LangChain foram descartados como over-engineering):
**adicionar memória de conversa (histórico)** mantendo `classify → dispatch` e o
caminho do dinheiro determinístico.

A virada é o **histórico**. Turnos de **ação** seguem idênticos (confirmação
determinística; decisão do Danubio: ação não fica "conversada"). O `reply` continua
sendo o canal dos turnos de **conversa**, mas agora **ciente do histórico**, o que
entrega:
- **A (referências):** "e o do João?" → o modelo vê a conta recém-criada no histórico.
- **B (perguntar o que falta):** falta dado → pede no `reply`; o histórico deixa o
  turno seguinte completar o `create_bill`. Sem máquina de estados.
- **D (papo):** o `reply` sustenta vai-e-vem natural e contextual.

## 2. Escopo

**Faz parte:** tabela/repo de histórico; dispatcher carrega+grava histórico;
`extractIntent` recebe o histórico; prompt orientado a usar histórico; testes (em
cima da rede da Fase 1).

**Não faz parte:** `cancel_bill` (adiado), confirmação de dinheiro (estava amarrada
ao cancel; ação determinística não precisa), edição de conta, qualquer mudança nos
turnos de ação.

## 3. Mudanças por componente

### 3.1 Histórico — `db.ts` + `conversation.repository.ts` (novo)

Tabela nova em `db.ts`:
```sql
CREATE TABLE IF NOT EXISTS conversation_turns (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  role  TEXT NOT NULL,   -- 'user' | 'bot'
  text  TEXT NOT NULL,
  at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_phone ON conversation_turns(phone, id);
```

`conversationRepository`:
- `append(phone, role: 'user' | 'bot', text)`: corta `text` em **500 chars** (limite
  contra tokens/injection), insere, e **trim FIFO** por telefone (mantém os últimos
  **16** por `phone`).
- `recent(phone, limit = 8): Promise<HistoryTurn[]>`: últimos `limit` turnos do
  telefone com `at` dentro do **TTL de 6h**, em ordem cronológica.
- `HistoryTurn = { role: 'user' | 'bot'; text: string }` — tipo exportado por este
  repo (o produtor); `gemini.ts` e o dispatcher importam como **type-only** (sem
  acoplamento de runtime entre camadas).

### 3.2 `gemini.ts` — `extractIntent(text, ctx, history)`

- Assinatura: `extractIntent(text: string, ctx: UserContext, history: HistoryTurn[] = [])`.
  `history` é opcional/default `[]` (mantém chamadas antigas e simplifica testes).
- `contents` passa a incluir o histórico ANTES da mensagem atual, mapeando role
  `'bot' → 'model'`:
  ```
  contents: [
    ...history.map((t) => ({ role: t.role === 'bot' ? 'model' : 'user', parts: [{ text: t.text }] })),
    { role: 'user', parts: [{ text }] },
  ]
  ```
- `systemInstruction`, `responseSchema`, retry/backoff: inalterados. Custo extra
  baixo (janela curta).

### 3.3 `prompt.ts` — usar o histórico

Adiciona orientação (o modelo agora recebe turnos anteriores):
- **Referências:** resolva menções ao que veio antes ("e o do João?", "muda?") usando
  o histórico.
- **Dado faltando (slot-filling):** se a pessoa claramente quer dividir mas falta um
  dado essencial (valor ou com quem), **não** invente — responda no `reply` (intent
  `unknown`) pedindo só o que falta; o histórico deixa o próximo turno completar.
- **Conversa:** pode sustentar um papo natural e contextual no `reply`, dentro do
  escopo (persona + anti-tutorial mantidos).

### 3.4 `dispatch-message.ts` — carregar + gravar histórico

`dispatchIncomingMessage(senderPhone, text)`:
1. carrega `history = conversationRepository.recent(senderPhone, 8)`;
2. `extractIntent(text, ctx, history)` (resto do try/catch de instabilidade igual);
3. despacha pelo `switch` como hoje, mas cada ramo define um `botTurn: string` pro
   histórico:
   - conversa/`unknown` e gates (`askToRegister`/`askForPix`): `botTurn` = o texto
     enviado (verbatim — importa pro slot-filling, ex: "quanto foi?");
   - ações (create/mark/list/register, que enviam por dentro do service): `botTurn` =
     um **resumo curto sem PIX** (ex: `'[criei a conta]'`, `'[registrei o pagamento]'`,
     `'[mostrei as contas]'`, `'[registrei seu cadastro]'`);
4. **só em sucesso** (não na instabilidade), grava `append(phone,'user',text)` e
   `append(phone,'bot',botTurn)`.

Money continua determinístico; nenhum PIX entra no histórico.

### 3.5 `test/setup.ts` — `resetDb` + builder

- `resetDb()` passa a limpar também `conversation_turns`.
- Builder `addTurn(phone, role, text)` (ou inserir via `conversationRepository.append`)
  pros testes de histórico.

## 4. Testes (em cima da rede da Fase 1)

Os testes da Fase 1 seguem verdes (o dispatch agora grava histórico, mas eles não
asseram isso; `resetDb` limpa a tabela nova). Novos testes cobrem o **encanamento**
(não a acurácia do LLM):
- após criar conta, o histórico tem 1 turno `user` (a mensagem) + 1 turno `bot`
  (resumo) e o turno do bot **não contém** `br.gov.bcb.pix`.
- após um `unknown` com reply, o turno do bot guarda o `reply` verbatim.
- `extractIntent` é chamado **com** o histórico recente (spy no mock confirma o 3º
  argumento com os turnos anteriores).
- cap de 500 chars por turno e cap FIFO de 16/telefone respeitados; `recent` respeita
  o TTL (turno "velho" não volta) — usar timestamps fixos no arrange.
- instabilidade do Gemini → **não** grava turno (histórico fica vazio).

**Fora do CI (smoke):** qualidade da resolução de referência, do slot-filling e do
papo — dependem do LLM ao vivo.

## 5. Guardrails / riscos
- PIX nunca no histórico (resumo de ação) nem em log (mantido).
- Texto de cada turno capado em 500 chars (tokens + superfície de injection).
- Janela 8 / TTL 6h / cap 16 — custo de tokens baixo; contexto velho não polui.
- `sanitizeName` no nome segue valendo; o histórico amplia a superfície de injection,
  mas dinheiro-por-código + persona de escopo seguram.
- Shim da rota (`whatsapp.webhook.ts`) segue sem teste — não muda nesta fase (o
  histórico vive no dispatcher); cobrir só se a rota mudar.

## 6. Arquivos
**Novos:** `src/repositories/conversation.repository.ts`, `test/conversation-history.test.ts`.
**Modificados:** `src/repositories/db.ts` (tabela), `src/services/llm/gemini.ts`
(`history` no `contents`), `src/services/llm/prompt.ts` (usar histórico),
`src/services/dispatch/dispatch-message.ts` (carrega/grava), `test/setup.ts`
(`resetDb` + builder).

## 7. Testing (meta)
Gate: `npx tsc --noEmit` limpo + `npm test` verde (Fase 1 + novos). Teste de
integração faz parte do checkpoint de cada task. Smoke manual ao vivo valida a
sensação conversacional (referências, slot-filling, papo) — fica com o Danubio.
