# Slice — Fase 1: harness de testes integrados + caracterização

**Status:** approved (design) — implementation pending
**Date:** 2026-05-30
**Author:** Danubio + Claude (brainstorm)
**Contexto maior:** Fase 1 de 2 rumo ao **Nível 1.5** (conversa com estado:
histórico + `reply` sempre + `cancel_bill`). Esta fase **não muda comportamento** —
monta a rede de regressão ANTES de a Fase 2 tocar no caminho do dinheiro/conversa.

---

## 1. Contexto e decisão

O projeto sempre foi "sem testes automatizados" (legibilidade como única
salvaguarda). A Fase 2 vai introduzir estado de conversa + dinheiro + papo livre —
exatamente onde um erro silencioso custa caro. **Decisão consciente (reversão de
política, escopada a este trabalho): introduzir testes de integração cobrindo os
fluxos críticos**, montados ANTES da mudança de comportamento.

Fase 1 entrega: ferramenta de teste (vitest), a costura de testabilidade
(extrair a lógica do webhook), DB isolável em teste, e **testes de caracterização
do comportamento ATUAL** (pós-PR #8/#9). Nada de comportamento muda em prod.

## 2. Escopo

**Faz parte:**
- `vitest` como devDependency + config + script `test`.
- `db.ts`: caminho do banco via env (`SLICE_DB_PATH`) pra teste usar banco efêmero.
- **Refactor de testabilidade:** extrair a IIFE de background do webhook numa função
  exportada `dispatchIncomingMessage(senderPhone, text)` (separa HTTP da lógica).
- Harness de teste: stub de `extractIntent` (Gemini) e `sendText` (WhatsApp) via
  mock de módulo do vitest; helper de reset do banco entre casos.
- **Testes de caracterização** dos fluxos críticos atuais (lista em §5).

**Não faz parte (é Fase 2):**
- Histórico de conversa, `reply` sempre presente, `cancel_bill`, confirmação.
- Qualquer mudança de comportamento do bot.
- Testar acurácia do LLM ao vivo (fica no smoke; CI usa Gemini stubado).

## 3. Mudanças por componente

### 3.1 `package.json`
- devDependency `vitest`. Script `"test": "vitest run"` (e `"test:watch": "vitest"`).

### 3.2 `vitest.config.ts` (novo)
- Ambiente `node`, `setupFiles: ['./test/setup.ts']`. Sem transform especial — vitest
  lida com TS/ESM nativo (o projeto já é ESM + tsx).

### 3.3 `test/setup.ts` (novo)
- **Primeira linha**, antes de qualquer import que toque o banco:
  `process.env.SLICE_DB_PATH = ':memory:'` (garante que o singleton do `db.ts` abra
  em memória quando importado pelos testes).
- Exporta/instala um `resetDb()` que limpa todas as tabelas (ordem respeitando FK:
  participants → bills → users, + processed_transactions, unknown_intents), chamado
  em `beforeEach`.

### 3.4 `src/repositories/db.ts`
- Caminho via env, default inalterado:
  `const DB_PATH = process.env.SLICE_DB_PATH ?? path.join(DATA_DIR, 'slice.db');`
- Só faz `mkdirSync(DATA_DIR)` quando o path NÃO é `':memory:'` (e idealmente do
  `dirname` do path). Prod segue idêntico (sem env → mesmo arquivo, mesmo mkdir).

### 3.5 `src/services/dispatch/dispatch-message.ts` (novo)
- Exporta `async function dispatchIncomingMessage(senderPhone: string, text: string): Promise<void>`
  contendo EXATAMENTE a lógica de hoje da IIFE do webhook (linhas 58-140):
  carrega user, monta `ctx`, `extractIntent` com try/catch de instabilidade, e o
  `switch` de despacho. Sem mudança de comportamento — é recorte literal.
- Imports migram do webhook pra cá (gemini, bill.service, user.service, repos, voice,
  `ExtractionResult`). Nome `dispatch*` (verbo do domínio; evita `handle`/`process`).

### 3.6 `src/routes/whatsapp.webhook.ts`
- Passa a só: parsear o body, guards (`fromMe`/sender/text), disparar
  `void dispatchIncomingMessage(senderPhone, text).catch((err) => console.error("[webhook] dispatch failed", err));`
  e responder 200. Mantém `EvolutionWebhookBody`, `extractText`, `extractSender`.
- Remove os imports que migraram pra `dispatch-message.ts` (mantém só os que a rota
  usa: `normalizeBrNumber`, tipos do Fastify).

## 4. Harness de teste (como os testes rodam)

- **Gemini stubado:** `vi.mock('../src/services/llm/gemini.js', ...)` (ou caminho
  equivalente) expondo `extractIntent` como `vi.fn()` que cada teste configura pra
  devolver um `ExtractionResult` canônico (ou lançar `GeminiUnavailableError`). Re-exporta
  `GeminiUnavailableError` real.
- **WhatsApp stubado:** `vi.mock` de `whatsapp.js` com `sendText` = `vi.fn()` que
  captura `(to, text)`. Como `bill.service`/`user.service`/dispatcher importam `sendText`
  desse módulo, o mock vale em toda a cadeia. Asserção: inspeciona as chamadas capturadas.
- **DB real, efêmero:** `:memory:` via `SLICE_DB_PATH` (§3.3). `resetDb()` no `beforeEach`.
  Os testes inserem o estado de partida via os repositórios reais (`userRepository.insert`,
  `billRepository.insert`) e depois chamam `dispatchIncomingMessage`.
- **Asserções:** (a) mensagens enviadas (conteúdo via o spy de `sendText`); (b) estado
  do banco (consultando os repositórios reais).

### 4.1 Convenção de estrutura dos testes (ARRANGE/ACT/ASSERT)

Todo teste segue **ARRANGE/ACT/ASSERT**: título do `it` descreve o cenário e o corpo
tem as três seções marcadas por comentário. Padroniza leitura e deixa o caso
auto-documentado.

```typescript
describe('dispatchIncomingMessage — criar conta', () => {
  beforeEach(() => {
    resetDb();
    sentMessages.length = 0;        // limpa o captador do sendText stubado
    extractIntent.mockReset();
  });

  it('cria conta de 2 pessoas e gera 1 PIX por participante', async () => {
    // ARRANGE — user cadastrado e a classificação que o Gemini devolveria
    await userRepository.insert({
      phone: '558899990000', name: 'Ana', pix_key: 'ana@email.com',
      pix_merchant_name: 'Ana', pix_merchant_city: 'BRASIL', created_at: '2026-05-30T00:00:00Z',
    });
    extractIntent.mockResolvedValue({
      intent: 'create_bill',
      bill: { description: 'Pizza', total_amount: 60, headcount: 3,
        participants: [{ name: 'Beto', amount_due: 20 }, { name: 'Carla', amount_due: 20 }] },
    });

    // ACT — chega a mensagem
    await dispatchIncomingMessage('558899990000', 'paguei 60 na pizza, divide com Beto e Carla');

    // ASSERT — estado do banco e mensagens enviadas
    const bills = await billRepository.findOpenForOwner('558899990000');
    expect(bills).toHaveLength(1);
    expect(bills[0]!.participants).toHaveLength(2);
    expect(sentMessages[0]!.text).toContain('Te mando o PIX de Beto e Carla');
    expect(sentMessages.filter((m) => m.text.includes('br.gov.bcb.pix'))).toHaveLength(2);
  });
});
```

Regra: **um cenário por `it`**, título descritivo do que o caso garante, e os três
blocos `// ARRANGE` / `// ACT` / `// ASSERT` no corpo (sem misturar arrange no meio
do assert).

## 5. Testes de caracterização — fluxos críticos (definição de pronto)

Cada caso: arranja estado + configura o retorno do `extractIntent` stubado + chama
`dispatchIncomingMessage` + asserta mensagens e/ou banco. Cobrir o comportamento
ATUAL (pós #8/#9):

**Cadastro**
- profile só com nome (user novo) → user inserido sem PIX; envia `welcomeNeedPix`.
- profile nome+PIX (user novo) → user com PIX; envia `welcomeReady`.
- `register_account` com profile vazio `{}` (user existente) → fallback, **sem** silêncio.

**Criar conta**
- registrado + com PIX, 2 participantes → bill OPEN no banco com valores corretos;
  headline plural ("Te mando o PIX de Ana e Beto"); 1 mensagem de PIX por participante;
  o payload PIX enviado é exatamente `participant.pix_payload`.
- 1 participante → headline singular ("Te mando o PIX de João", sem "(João)").
- descrição vazia → headline sem "em ..." .
- não cadastrado → `askToRegister`; cadastrado sem PIX → `askForPix`.
- intent misto (create_bill + profile, sem PIX) → registra nome (silencioso) + `askForPix`.

**Marcar pago**
- 1 de 2 pendentes paga → participante PAID, bill segue OPEN, mensagem "X pagou...".
- último pendente paga → bill CLOSED, mensagem `billClosed`.
- nome ambíguo (casa >1) → pergunta "Quem pagou?".

**Listar**
- com contas abertas → resumo compacto correto; sem contas → "nenhuma conta em aberto 🎉";
  não cadastrado → `askToRegister`.

**Conversa / guarda-corpos**
- `unknown` com `reply` válido (≤300) → envia o reply; **não** grava em `unknown_intents`.
- `unknown` sem reply (ou >300) → `fallbackReply` + grava em `unknown_intents`.
- `extractIntent` lança `GeminiUnavailableError` → envia `instability()`.
- nenhuma mensagem de dinheiro vaza PIX no texto não-PIX (headline não contém `br.gov.bcb.pix`).

## 6. Guardrails / notas
- Fase 1 é **behavior-preserving**: o refactor é recorte literal; os testes
  caracterizam o que já existe. `npx tsc --noEmit` + `vitest run` ambos limpos.
- O que os testes **não** cobrem: acurácia de classificação do LLM (stubado) — isso
  é smoke. Cobrem o **código** dado um resultado classificado.
- Sem rede/Evolution/Gemini reais nos testes (tudo stubado) → CI determinístico, rápido.

## 7. Testing (meta)
- `npm test` (= `vitest run`) verde + `npx tsc --noEmit` limpo são o gate desta fase
  e das próximas. A partir daqui, teste integrado vira parte do checkpoint de cada task
  (não só o `tsc`).
- Smoke manual não é necessário na Fase 1 (não muda comportamento); um `npm run dev`
  rápido confirma que o webhook ainda sobe e despacha (o refactor não quebrou o boot).
