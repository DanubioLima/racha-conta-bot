# Cumbuca Real Integration — Design

**Status:** approved (design phase) — implementation pending
**Date:** 2026-05-17
**Author:** Danubio + Claude (brainstorm)
**Replaces:** mock-based ledger source (`src/mock/incoming-transactions.json`)

---

## 1. Contexto e motivação

O MVP atual do Racha-Conta reconcilia pagamentos de entrada lendo um arquivo
JSON local (`src/mock/incoming-transactions.json`). O shape do mock foi
desenhado pra espelhar o payload que viria de uma integração real com o
Cumbuca, deixando essa substituição como evolução natural.

Investigação de 2026-05-17 confirmou que o Cumbuca expõe um MCP server
público em `https://mcp.cumbuca.com/mcp` que age como bridge Open Finance
contra as instituições financeiras autorizadas pelo usuário (no caso atual,
Nubank). O server suporta Dynamic Client Registration (DCR), permitindo que
qualquer aplicação se registre como MCP client sem cadastro manual no
Cumbuca.

Essa descoberta desbloqueia uma integração nativa: o bot Node.js passa a
ser um MCP client direto, sem precisar de Claude/agente no caminho.

## 2. Approach escolhido

**A. Bot Node como MCP client direto** (via `@modelcontextprotocol/sdk`),
fazendo OAuth/DCR uma vez no setup, persistindo tokens localmente, e
consumindo `list_account_transactions` durante a operação normal.

**Considerados e descartados:**

- **`claude -p` headless in-process** — funciona, mas insere LLM num caminho
  determinístico, gera custo de API Anthropic e acopla o bot à instalação
  do Claude Code na máquina.
- **Script separado + Anthropic SDK com `mcp_servers` connector** — mesmas
  desvantagens da opção acima, mais a complicação extra de orquestrar cron
  externo.
- **Open Finance direto (bypass Cumbuca, virar TPP registrado no BCB)** —
  inviável pra MVP: exige cert ICP-Brasil, processo de registro junto ao
  Banco Central, meses de prazo.

## 3. Arquitetura

```
┌──────────────────────────────────────────────────────────────┐
│                          Bot Node                            │
│                                                              │
│  ┌────────────────┐   ┌──────────────────┐   ┌────────────┐  │
│  │ Webhook        │   │ Payment Scanner  │   │ OAuth      │  │
│  │ /webhooks/     │   │ (adaptive sched) │   │ Callback   │  │
│  │ whatsapp       │   └────────┬─────────┘   │ /oauth/    │  │
│  └───────┬────────┘            │             │ cumbuca/cb │  │
│          │                     │             └─────┬──────┘  │
│          ▼                     ▼                   │         │
│  ┌─────────────────────────────────────────┐       │         │
│  │            bill.service                 │       │         │
│  │  createBillFromExtraction / reconcile   │       │         │
│  └────────────┬────────────────────────────┘       │         │
│               │                                    │         │
│               ▼                                    ▼         │
│  ┌────────────────────────┐         ┌────────────────────┐   │
│  │ bill.repository        │         │ cumbuca.client     │   │
│  │ (data/db.json)         │         │ (MCP client + OAuth│   │
│  └────────────────────────┘         │  + token store)    │   │
│  ┌────────────────────────┐         └─────────┬──────────┘   │
│  │ processed-transactions │                   │              │
│  │ .repository            │                   │              │
│  └────────────────────────┘                   │              │
└───────────────────────────────────────────────┼──────────────┘
                                                │
                                                ▼
                              https://mcp.cumbuca.com/mcp
```

### 3.1 Componentes novos

| Caminho | Responsabilidade |
|---------|------------------|
| `services/cumbuca/cumbuca.client.ts` | Envolve `@modelcontextprotocol/sdk`. Faz DCR + OAuth, persiste tokens, refresh transparente, expõe `listRecentCredits({sinceISO})`. |
| `services/cumbuca/cumbuca.tokens.ts` | Leitura/escrita de `data/cumbuca-tokens.json`. |
| `services/cumbuca/cumbuca.mapper.ts` | Conversão de payload Open Finance pra `IncomingTransaction`. Sem regras de negócio. |
| `services/ledger/ledger.source.ts` | Factory que devolve `cumbucaLedgerSource` ou `mockLedgerSource` baseado em env + estado dos tokens. |
| `services/ledger/mock.source.ts` | Reaproveita o JSON existente como `LedgerSource`. |
| `repositories/processed-transactions.repository.ts` | Conjunto persistente de transactionIds já reconciliados. |
| `routes/cumbuca.oauth.ts` | Rota `GET /oauth/cumbuca/callback` usada pelo script de pareamento. |
| `bin/cumbuca-link.ts` | Script `npm run cumbuca:link` — DCR, abre browser, captura callback, persiste tokens. |
| `workers/payment-scanner.worker.ts` | Substitui `ledger.worker.ts`. Polling adaptativo com `setTimeout` recursivo. |

### 3.2 Componentes modificados

| Caminho | Mudança |
|---------|---------|
| `config/env.ts` | Adiciona `LEDGER_SOURCE` (default `cumbuca`). |
| `services/bills/bill.types.ts` | `BillStatus` ganha valor `'EXPIRED'` (auto-CLOSE de bill > 7 dias). |
| `services/bills/bill.service.ts` | `createBillFromExtraction` chama `paymentScanner.notifyNewBillCreated()` no final. |
| `server.ts` | Registra rota OAuth e troca import de `startLedgerWorker` por `startPaymentScanner`. |

### 3.3 Componentes deletados

| Caminho | Razão |
|---------|-------|
| `workers/ledger.worker.ts` | Substituído por `payment-scanner.worker.ts`. |

O arquivo `src/mock/incoming-transactions.json` **permanece** — passa a ser
o backing store do `mockLedgerSource`.

## 4. Setup OAuth (first-run UX)

```
$ npm run cumbuca:link

[oauth] Registrando MCP client no Cumbuca (DCR)...
[oauth] client_id obtido: abc-123
[oauth] Subindo callback em http://localhost:3000/oauth/cumbuca/callback
[oauth] Abra esta URL no browser:
        https://mcp.cumbuca.com/authorize?...

  (Browser abre automaticamente quando possível; em servidor headless,
   o usuário copia a URL manualmente. O script aguarda o callback.)

[oauth] Code recebido, trocando por token...
[oauth] Listando contas para escolha de default...
[oauth] Conta selecionada: Nu Pagamentos S.A. (611d86ba-...)
[oauth] Tokens persistidos em data/cumbuca-tokens.json
[oauth] ✅ Pareamento concluído. Você pode iniciar o bot (npm run dev).
```

### 4.1 Shape de `data/cumbuca-tokens.json`

```json
{
  "client_id": "...",
  "client_secret": "...",
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": "2026-05-17T15:30:00Z",
  "account_id": "611d86ba-44e0-4a6d-85c0-a947b4e0a860"
}
```

`account_id` é resolvido no setup (1 chamada de `list_accounts`) e cacheado
no arquivo. Em runtime o bot nunca chama `list_accounts` de novo — preserva
a quota apertada de 8/mês desse endpoint. Se a conta mudar (caso raro),
o usuário roda `cumbuca:link` novamente.

### 4.2 Múltiplas contas

Se o usuário tiver mais de uma conta acessível via Open Finance, o script
de pareamento lista todas e pede que ele escolha qual será usada pela
operação do bot. Suporte multi-conta simultâneo fica fora de escopo.

### 4.3 Reconexão

Quando o cliente Cumbuca detecta refresh inválido (consent revogado ou
expirado pelo banco), ele marca um flag em memória `connected = false`
(não persistido — relê tokens em cada boot) e dispara uma mensagem
WhatsApp única para o `USER_WHATSAPP_NUMBER`:

> 🔒 Cumbuca desconectado. Rode `npm run cumbuca:link` pra reconectar.

O scanner para de pollar até a reconexão. Bills permanecem abertas (não
expiram só por causa de desconexão).

## 5. Polling adaptativo

A cadência é recalculada a cada execução baseada na bill OPEN criada mais
recentemente (a de maior `created_at`):

| Idade da bill OPEN mais recente | Delay até próximo scan |
|------------------------------|------------------------|
| 0 – 60 min | 5 min |
| 60 min – 6 h | 15 min |
| 6 h – 24 h | 1 h |
| 24 h – 7 dias | 6 h |
| > 7 dias | scanner faz auto-CLOSE com status `EXPIRED` e recalcula |
| Nenhuma bill OPEN | scanner idle (sem timer agendado) |

### 5.1 Trigger imediato em bill nova

Quando `bill.service.createBillFromExtraction` cria uma bill, chama
`paymentScanner.notifyNewBillCreated()`. Esse handler:

1. Cancela o `setTimeout` atual.
2. Dispara `scanForBillPayments()` imediatamente.
3. Agenda o próximo scan via tabela acima (vai cair em 5 min, já que a
   bill recém-criada tem idade ~0).

Isso garante que o cooldown longo (ex: idle ou 6h) seja interrompido
assim que aparece nova bill, sem precisar persistir cronograma.

### 5.2 Budget de quota (worst-case, 1 bill aberta o dia inteiro)

- `list_account_transactions` (≤7d, 240/mês): cache server-side por dia faz
  com que múltiplos scans no mesmo dia custem **1 chamada** (cache miss
  apenas na virada). Custo mensal: ~30/240 ≈ 12% do budget.
- `list_account_transactions` (>7d, 8/mês): **0**, pois auto-CLOSE em 7 dias
  garante que a janela nunca extrapola.
- `list_accounts` (8/mês): **0** em runtime — `account_id` cacheado no
  setup.

## 6. Mapeamento, dedup e estado

### 6.1 Conversão de payload

```ts
// cumbuca.mapper.ts — tradução pura, sem regras de negócio

export function isReceivedPix(transaction: CumbucaTransaction): boolean {
  return transaction.creditDebitType === "CREDITO"
      && transaction.type === "PIX";
}

export function extractPayerName(transactionName: string): string {
  // Open Finance: "Transferência Recebida|NOME DO PAGADOR"
  const [, name] = transactionName.split("|");
  return (name ?? "").trim();
}

export function toIncomingTransaction(
  transaction: CumbucaTransaction,
): IncomingTransaction {
  return {
    id: transaction.transactionId,
    amount: parseFloat(transaction.transactionAmount.amount),
    payer_name: extractPayerName(transaction.transactionName),
    occurred_at: transaction.transactionDateTime,
  };
}
```

### 6.2 Dedup persistente

Conjunto em arquivo separado `data/processed-transaction-ids.json`,
mantido em memória durante runtime e gravado após cada reconciliação.
Cap em 1000 IDs (FIFO) — janela do Cumbuca é de poucos dias, não há
risco de reabrir uma transação antiga que já saiu do conjunto.

### 6.3 Loop principal

```ts
// payment-scanner.worker.ts (excerto)

async function scanForBillPayments(): Promise<void> {
  const openBills = await bills.listOpen();
  if (openBills.length === 0) {
    log("scanner idle — no open bills");
    return;
  }

  const earliestOpenBillTimestamp = oldestCreatedAt(openBills);
  const rawTransactions = await ledgerSource.listRecentCredits({
    sinceISO: earliestOpenBillTimestamp,
  });

  for (const transaction of rawTransactions) {
    if (await processedTransactions.wasAlreadyProcessed(transaction.id)) continue;
    await bills.tryReconcile(transaction);
    await processedTransactions.markAsProcessed(transaction.id);
  }

  await expireBillsOlderThanSevenDays(openBills);
}
```

### 6.4 Scheduler (funções separadas, mesmo arquivo)

```ts
function scheduleNextScan(): void {
  const delay = computeNextScanDelay();
  scanTimer = setTimeout(runScanAndReschedule, delay);
}

async function runScanAndReschedule(): Promise<void> {
  try {
    await scanForBillPayments();
  } catch (error) {
    console.error("[scanner] scan failed", error);
  } finally {
    scheduleNextScan();
  }
}

export function notifyNewBillCreated(): void {
  if (scanTimer) clearTimeout(scanTimer);
  void runScanAndReschedule();
}

function computeNextScanDelay(): number { /* tabela §5 */ }
```

Cada função tem uma responsabilidade. O scanner não conhece tempo, o
scheduler não conhece bills.

### 6.5 Auto-CLOSE de bills antigas

Bills com `created_at` > 7 dias são marcadas com novo status `EXPIRED`
(`'OPEN' | 'CLOSED' | 'EXPIRED'`) e o usuário recebe uma mensagem:

> ⏱️ Bill "Pizzaria" expirou após 7 dias. Pendentes: João, Maria.

Isso preserva a quota do endpoint barato (≤7d) e dá fechamento de UX
para bills que nunca pagaram.

## 7. Erros, observabilidade e toggle dev/prod

### 7.1 Tratamento de erros

| Erro | Reação |
|------|--------|
| Access token expirado | Refresh transparente. |
| Refresh falha (consent revogado) | Marca `connected = false`, manda alerta WhatsApp único, scanner pausa. |
| Quota mensal estourada (HTTP 429) | Loga warning, dobra o próximo delay (cap em 6 h). Sem alerta ao user — resolve sozinho na virada do mês. |
| Rede/timeout | Retry com backoff exponencial (3 tentativas: 1 s, 3 s, 9 s). Próximo scan no cronograma normal. |
| Payload mal-formado | Loga payload em DEBUG mode e segue. Não derruba scanner. |

### 7.2 Toggle `LEDGER_SOURCE`

```ts
// services/ledger/ledger.source.ts

export interface LedgerSource {
  listRecentCredits(options: { sinceISO: string }): Promise<IncomingTransaction[]>;
}

export function createLedgerSource(): LedgerSource {
  if (env.ledgerSource === "mock") return mockLedgerSource;
  if (!cumbucaClient.hasTokens()) {
    console.warn("[ledger] no Cumbuca tokens — falling back to mock source");
    return mockLedgerSource;
  }
  return cumbucaLedgerSource;
}
```

- Env nova: `LEDGER_SOURCE=cumbuca` (default) | `mock`. Default fica em
  cumbuca, mas fallback automático pra mock se ainda não rodou
  `cumbuca:link` — preserva a experiência atual de "rodar o bot
  imediatamente" sem setup obrigatório.
- O scanner depende da interface, não dos módulos concretos.

### 7.3 Logs

Prefixos consistentes pra grep fácil:

- `[scanner]` — payment scanner
- `[cumbuca]` — cliente MCP
- `[oauth]` — fluxo de pareamento
- `[ledger]` — factory

Conteúdo: 1 linha por evento relevante. Dump de payload só em
`DEBUG=racha:*`.

## 8. Pontos abertos / riscos

1. **DCR de fato funciona como descrito?** A página de launch fala em
   Dynamic Client Registration, mas não há doc técnica linkada. Se o
   Cumbuca exigir cliente pré-registrado, o script `cumbuca:link` falha
   no primeiro passo — vamos descobrir só rodando. Plano B: pedir ao
   suporte do Cumbuca, ou abrir o devtools no fluxo do claude.ai pra
   ver como ele faz.
2. **Browser em servidor headless** — pra MVP roda local, sem problema.
   Se for hospedar, vamos precisar redirect URL pública.
3. **Open Finance consent expira (~90 dias típico no Brasil)** — o
   mecanismo de re-link existe e foi desenhado, mas só vamos validar
   em uso real.
4. **Múltiplos PIX iguais no mesmo dia** — se duas pessoas mandam o
   mesmo valor com o mesmo primeiro nome no mesmo dia, o `tryReconcile`
   pode bater na bill errada. O risco era o mesmo no mock; fica como
   limitação documentada.

## 9. Out of scope

- Múltiplas contas Cumbuca simultâneas.
- Múltiplos usuários do bot (continua single-user — gated em
  `USER_WHATSAPP_NUMBER`).
- Reconciliação por boleto, débito, ou outros tipos de crédito (TED,
  DOC). Só PIX recebido.
- UI/painel de administração — gerenciamento continua via WhatsApp e
  CLI.
- Migração de `db.json` pra SQLite (próximo item do roadmap, separado).
