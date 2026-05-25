# Slice — Multi-User + SQLite + Cumbuca Multi-Tenant Design

**Status:** approved (design phase) — implementation pending
**Date:** 2026-05-24
**Author:** Danubio + Claude (brainstorm)
**Depende de:** [2026-05-23-slice-baileys-deployment-design.md](./2026-05-23-slice-baileys-deployment-design.md)
**Habilita:** [docs/product/2026-05-24-validation-experiment.md](../../product/2026-05-24-validation-experiment.md) (experimento de validação self-serve)

---

## 1. Contexto e motivação

Smoke do Slice fechou em 2026-05-24 ponta-a-ponta. Bot em produção,
mas **single-user**: hoje só `USER_WHATSAPP_NUMBER` (5588998082034 do
Danubio) é processado, PIX vai pra conta dele, Cumbuca dele reconcilia.

Pra rodar o experimento de validação com 5-10 testers reais sem
intermediação manual em cada interação, precisamos que cada tester
possa:

- Se auto-registrar via WhatsApp (sem JSON na mão)
- Ter o PIX gerado **no nome dele** (não do Danubio)
- Conectar **o banco dele** ao Cumbuca pra ter auto-reconciliação completa
- Receber respostas do bot diretamente (não pro Danubio)

Em paralelo, a evolução natural do storage: hoje os 4 arquivos JSON em
`data/` (`db.json`, `cumbuca-tokens.json`, `processed-transaction-ids.json`,
`whatsapp-window.json` e `cumbuca-pending-pairing.json`) não escalam pra
multi-tenant — concorrência, queries, integridade. **SQLite com colunas
JSON** entrega flexibilidade de NoSQL + ACID + zero infra extra.

## 2. Approach escolhido

**Pilares:**

1. **Data layer**: SQLite (arquivo único, embedded) usado como
   document-store via colunas JSON + indexes em colunas virtuais. Bind
   mount em `/home/slice/slice-data/` no host pra arquivo ser visível e
   backup-ável sem `docker exec`. **Repository pattern estrito**:
   `services/*` nunca importa `better-sqlite3`; toda a camada SQL fica
   confinada em `src/repositories/`.

2. **Intent dispatcher via Gemini**: o classificador atual já retorna
   `intent: 'create_bill'`. Expandimos pra mais intents
   (`register_account`, `link_bank`, `unknown`) e o webhook vira um
   dispatcher leve por intent.

3. **Auto-registro via WhatsApp**: primeira mensagem de sender
   desconhecido dispara onboarding curto (nome + chave PIX). Persistido
   em `users` table.

4. **Cumbuca multi-tenant**: DCR é feito **uma vez** no bootstrap da
   aplicação (Danubio); o `client_id`/`client_secret` ficam app-wide.
   Cada user faz seu próprio OAuth Authorization Code flow usando esse
   client; tokens próprios são persistidos keyed por user phone.

5. **Scanner multi-user**: itera owners com OPEN bills, chama Cumbuca
   com os tokens daquele owner, respeitando cadence adaptativa por
   owner pra não estourar rate limit.

**Considerados e descartados:**

- **MongoDB via Dokploy** — cabe na RAM (4GB), mas overhead operacional
  (container extra, backup, healthcheck, driver) não compensa pro
  estágio (validação primeiro, otimização depois)
- **Postgres com JSONB** — robusto pro futuro mas mistura responsabilidades
  com o Postgres do Evolution e adiciona migration ceremony
- **State machine de onboarding em código** (steps: awaiting_name, awaiting_pix,
  etc.) — mais robusto que self-classified, mas explode arquivos pra ganho
  marginal. Gemini self-classified é suficiente; se misclassificar, bot
  re-pergunta. Iteramos depois se feedback dos testers exigir
- **Multi-instance horizontal scaling** — SQLite trava em ~1 instance;
  out-of-scope pro estágio. Quando precisar escalar horizontalmente,
  migra-se pra Postgres/Mongo. Repository pattern garante que mudança
  só atinge a camada de persistência

## 3. Arquitetura

### 3.1 Diagrama lógico

```
                  [WhatsApp Cloud]
                         │ inbound
                         ▼
              [Evolution webhook → bot]
                         │
                         ▼
                ┌─────────────────┐
                │ webhook handler │
                └────────┬────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  intent dispatcher   │  ← Gemini classify
              └─┬────────┬────────┬──┘
                │        │        │
       register_      link_     create_
       account       bank      bill     (etc)
                │        │        │
                ▼        ▼        ▼
        userService  cumbuca   billService
                       Service
                │        │        │
                ▼        ▼        ▼
            ┌─────────────────────────────┐
            │       Repositories          │  ← única camada que conhece SQLite
            │  users / bills / cumbuca... │
            └─────────────┬───────────────┘
                          │
                          ▼
                  data/slice.db
                  (bind mount: /home/slice/slice-data/slice.db)
```

### 3.2 Camadas e regras de dependência

| Camada | Pode importar de | Não pode importar de |
|---|---|---|
| `routes/` | services | repositories diretamente, sqlite3 |
| `workers/` | services | repositories diretamente, sqlite3 |
| `services/` | services + repositories (via interface) | sqlite3, `better-sqlite3` |
| `repositories/` | (raiz, importa sqlite) | services, routes, workers |
| `bin/` | services | (mesma regra que routes) |

**Repository pattern: cada repository exporta uma instância e a interface
pública é só métodos de domínio.** `usersRepository.findByPhone(p)`,
`billsRepository.findOpenForOwner(p)`, `cumbucaTokensRepository.getForUser(p)`.
Linguagem SQL fica encapsulada.

## 4. Data layer — SQLite + bind mount

### 4.1 Bind mount

Mudança em `docker-compose.yml` no serviço `bot`:

```yaml
bot:
  volumes:
    - /home/slice/slice-data:/app/data  # bind mount (era named volume)
```

Remove a declaração `volumes: slice_bot_data:` lá embaixo (não usada mais).

Pré-requisito operacional no VPS (runbook):
```bash
sudo mkdir -p /home/slice/slice-data
sudo chown -R 1000:1000 /home/slice/slice-data  # UID/GID do user node-alpine
```

Backup vira simples:
```bash
tar czf /backup/slice-$(date +%F).tar.gz /home/slice/slice-data/
```

Restore: substitui o arquivo, restart do container.

### 4.2 Schema SQLite

Arquivo: `/app/data/slice.db` (em produção: `/home/slice/slice-data/slice.db`).

```sql
-- App-level Cumbuca client (1 row apenas)
CREATE TABLE cumbuca_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Users (multi-tenant)
CREATE TABLE users (
  phone TEXT PRIMARY KEY,                  -- E.164 sem +, ex: 5588998082034
  data JSON NOT NULL,                      -- { name, pix_key, pix_merchant_name, pix_merchant_city, created_at, ... }
  updated_at TEXT NOT NULL
);

-- Cumbuca tokens por user
CREATE TABLE cumbuca_tokens (
  user_phone TEXT PRIMARY KEY REFERENCES users(phone),
  data JSON NOT NULL,                      -- { access_token, refresh_token, expires_at, account_id }
  updated_at TEXT NOT NULL
);

-- Cumbuca OAuth pending pairing (efêmero, TTL 10min)
CREATE TABLE cumbuca_pending_pairing (
  user_phone TEXT PRIMARY KEY,
  data JSON NOT NULL,                      -- { state, code_verifier, redirect_uri, created_at }
  created_at TEXT NOT NULL
);

-- Bills
CREATE TABLE bills (
  id TEXT PRIMARY KEY,                     -- ULID
  owner_phone TEXT NOT NULL REFERENCES users(phone),
  data JSON NOT NULL,                      -- { description, total_amount, amount_per_person, status, participants, created_at }
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_owner ON bills(owner_phone);
CREATE INDEX idx_bills_owner_status ON bills(owner_phone, status);

-- IDs de transações já reconciliadas (dedup)
CREATE TABLE processed_transactions (
  transaction_id TEXT PRIMARY KEY,
  user_phone TEXT NOT NULL REFERENCES users(phone),
  processed_at TEXT NOT NULL
);
CREATE INDEX idx_processed_user ON processed_transactions(user_phone);

-- WhatsApp 24h window tracker
CREATE TABLE whatsapp_window (
  user_phone TEXT PRIMARY KEY REFERENCES users(phone),
  last_inbound_at TEXT NOT NULL
);
```

### 4.3 Bibliotecas

- `better-sqlite3` (npm) — driver síncrono, fast, nativo. Sync API
  combina bem com o estilo do código atual (Promise async só onde HTTP/FS
  exige). Versão recente compila com Node 24.
- Sem ORM. Queries SQL escritas à mão dentro dos repositories — 80%
  delas são select por PK ou insert/update simples.

### 4.4 Repositories — interface pública

Localização: `src/repositories/*.repository.ts`.

```typescript
// src/repositories/users.repository.ts
export interface User {
  phone: string;
  name: string;
  pix_key: string;
  pix_merchant_name: string;
  pix_merchant_city: string;
  created_at: string;
}
export const usersRepository = {
  findByPhone(phone: string): User | null,
  insert(user: User): void,
  update(phone: string, partial: Partial<User>): User | null,
  list(): User[],
};

// src/repositories/bills.repository.ts
// (interface igual à atual + filtros por owner_phone)
export const billsRepository = {
  findById(id: string): Bill | null,
  findOpenForOwner(ownerPhone: string): Bill[],
  findAllOpen(): Bill[],                              // pro scanner iterar todos owners
  insert(bill: Bill): void,
  update(id: string, mutator: (bill: Bill) => void): Bill | null,
};

// src/repositories/cumbuca-app.repository.ts
export interface CumbucaAppCredentials { client_id: string; client_secret: string; }
export const cumbucaAppRepository = {
  get(): CumbucaAppCredentials | null,
  set(creds: CumbucaAppCredentials): void,
};

// src/repositories/cumbuca-tokens.repository.ts
export interface CumbucaUserTokens {
  user_phone: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_id: string;
}
export const cumbucaTokensRepository = {
  getForUser(userPhone: string): CumbucaUserTokens | null,
  set(tokens: CumbucaUserTokens): void,
  listUsersWithTokens(): string[],                    // pra scanner saber quem tem cumbuca conectado
};

// src/repositories/cumbuca-pending-pairing.repository.ts
// (igual ao atual mas keyed por user_phone)

// src/repositories/processed-transactions.repository.ts
// (igual ao atual mas com user_phone)

// src/repositories/whatsapp-window.repository.ts
// (substitui o arquivo whatsapp-window.json)
```

### 4.5 Migration dos JSON files

Único script `bin/migrate-json-to-sqlite.ts`, roda manualmente uma vez:

1. Lê os 5 arquivos JSON existentes em `data/`
2. Cria o `slice.db` com schema acima
3. Insere dados existentes:
   - `cumbuca-tokens.json` (single user atual = Danubio) → cria user `5588998082034` e tokens dele
   - `db.json` bills → todas viram `owner_phone = '5588998082034'`
   - `processed-transaction-ids.json` → cada ID com `user_phone = '5588998082034'`
   - `whatsapp-window.json` → para cada entry vira row
   - `cumbuca-pending-pairing.json` → ignora (efêmero, expirado)
4. Move JSONs antigos pra `data/.json-archive/` (não apaga, fica de backup local)

Roda manualmente após deploy do código novo. Bind mount pré-existente
do path host `/home/slice/slice-data/` recebe o novo `.db`.

## 5. Intent dispatcher

### 5.1 Intents suportados

```typescript
type Intent =
  | { intent: 'create_bill'; bill: ExtractedBill }
  | { intent: 'register_account'; profile: Partial<RegisterProfile> }
  | { intent: 'link_bank' }   // recovery/manual: user diz "reconectar banco",
                              // "meu nubank desconectou", etc. NÃO é a porta
                              // de entrada do bank linking — o bot DRIVES
                              // o linking proativamente após register.
  | { intent: 'unknown' };

interface RegisterProfile {
  name: string;
  pix_key: string;
  // Fields NOT coletados do user — derivados automaticamente pra reduzir
  // fricção do onboarding:
  //   pix_merchant_name = name (truncado a 25 chars se exceder o limite BR Code)
  //   pix_merchant_city = 'BRASIL' (15 chars, valor genérico aceito por todos os bancos)
  // Esses defaults aparecem no app do banco do pagador como info do recebedor.
  // Se virar UX issue (tester reclamar), promove a campos coletados explicitamente.
}
```

### 5.2 Prompt do Gemini

Atualizar o system prompt em `src/services/llm/gemini.ts` pra:

- Reconhecer cada um dos intents acima
- Extrair os fields apropriados
- Em caso de ambiguidade, retornar `unknown`

Exemplos no prompt (few-shot):
- "Paguei 60 na pizza, divide com Ana e Beto" → `create_bill`
- "Oi, sou João, minha chave pix é joao@email.com" → `register_account` com name + pix_key
- "Sou Maria" (sem PIX) → `register_account` parcial (só name)
- "Meu nubank desconectou" / "preciso reconectar" / "reconectar banco" → `link_bank` (raro — só recovery)
- "Bom dia" / mensagem genérica → `unknown`

Note: usuário em onboarding **não precisa pedir** pra conectar banco. O
bot conduz proativamente (ver §6.1). `link_bank` é safety-net pra casos
em que o user expressa explicitamente que algo deu errado e quer
re-conectar.

### 5.3 Dispatcher no webhook

```typescript
// src/routes/whatsapp.webhook.ts pseudo
const user = usersRepository.findByPhone(senderPhone);
const intent = await extractIntentFromText(text, { knownUser: !!user });

switch (intent.intent) {
  case 'register_account':
    return userService.handleRegistration(senderPhone, intent.profile);
  case 'link_bank':
    if (!user) return userService.requireRegistrationFirst(senderPhone);
    return cumbucaService.startOAuthForUser(user);
  case 'create_bill':
    if (!user) return userService.requireRegistrationFirst(senderPhone);
    if (!user.pix_key) return userService.requirePixFirst(senderPhone);
    return billService.createBillFromExtraction(intent.bill, user);
  case 'unknown':
  default:
    return userService.notifyUnknown(senderPhone, !!user);  // texto contextual: se novo, instrui registro; se conhecido, instrui formato de bill
}
```

## 6. Auto-registro de user via WhatsApp

### 6.1 Fluxo conceitual — bot conduzindo proativamente

```
User (desconhecido) → "oi"
  ↓
Bot: "Bem-vindo ao Slice 👋 Pra começar, me responde com:
       Nome: Seu Nome
       PIX: sua-chave"
  ↓
User: "João Silva, joao@email.com"
  ↓
Gemini → { intent: 'register_account', profile: { name, pix_key } }
  ↓
userService.persist(user)
  ↓
Bot envia 2 mensagens em sequência:
  ↓
  [1] "Tudo certo, João! Já pode criar contas — manda algo tipo
      'paguei 60 na pizza, divide com Ana e Beto'."
  ↓
  [2] "Antes de você começar, falta um passo curto. Pra eu te avisar
      automaticamente quando alguém te pagar via PIX, preciso conectar
      com seu banco. Funciona via Open Finance:
      
      • Você autoriza direto no app do seu banco (~30s)
      • Eu só vejo as entradas (não vejo saídas, saldo, nem nada pessoal)
      • Pode revogar a qualquer momento no app do banco
      
      Toque aqui pra autorizar:
      <authorize_url>
      
      Depois é só voltar pro WhatsApp."
  ↓
User abre URL → consent no banco → callback Cumbuca → callback Slice
  ↓
cumbucaService.handleCallback(state, code):
  → tokens persistem keyed por user.phone
  → account selection automática
  ↓
Bot envia mensagem WhatsApp:
  ↓
  "Pronto, conectado! 🎉 Agora vou te avisar automaticamente quando
   seus contatos pagarem. Pode criar sua primeira conta aí."
```

**Decisão importante:** o link é mandado no MESMO momento da confirmação
de cadastro, antes do user pedir. Reduz fricção e capitaliza no momento
de mais engajamento (user acabou de se cadastrar, ainda focado no bot).

### 6.2 Edge cases

- **Profile parcial no primeiro registro**: user manda só "Sou João" sem
  PIX. Bot persiste o nome e pede o PIX especificamente ("Falta só sua
  chave PIX"). Quando completar, dispara o fluxo de link banco da §6.1.
- **User ignora o link e cria bill antes de conectar**: bot **não bloqueia**
  a criação. Manda PIX normalmente e adiciona um lembrete sutil ao final
  da mensagem inicial: "💡 Pra eu detectar pagamentos automaticamente,
  conecte seu banco: <authorize_url>". A bill fica OPEN e pode ser
  fechada manualmente (item futuro de admin commands) ou expira em 7 dias.
- **User clica no link, autoriza, mas falha o callback** (rede caiu, etc.):
  na próxima mensagem do user, bot detecta sem tokens persistidos +
  pending pairing expirado, e re-driva o link: "Algo deu errado no último
  pareamento. Tenta de novo: <novo_authorize_url>".
- **User com pending pairing ativo** (clicou link, ainda não voltou): bot
  reconhece pending não-expirado e responde "Tá esperando você terminar
  no banco. Volta aqui depois de autorizar." em vez de gerar URL nova.
- **Tentativa de criar bill sem registro**: bot responde "Pra usar o
  Slice preciso te cadastrar primeiro. Me responde com Nome: X, PIX: y".
- **Tentativa de criar bill sem PIX cadastrado**: bot pede PIX antes.
- **`link_bank` explícito (recovery)**: user diz "reconectar banco" /
  "meu nubank desconectou" → bot apaga tokens antigos (se houver),
  dispara nova URL com explicação reduzida ("Reconectando seu banco.
  Toque aqui: <url>").
- **Reenvio de PIX numa segunda mensagem**: aceitamos update via
  `register_account` intent — útil pra correção. ("Minha chave PIX mudou
  pra X" → update do PIX no profile).

### 6.3 Bot não bloqueia bill por banco não conectado

User pode usar Slice sem nunca conectar Cumbuca. Single trade-off: não
tem auto-reconciliação dele. Estado das bills de user sem Cumbuca:

- Bill criada normalmente, status OPEN
- PIX gerado normalmente, mandado pros participantes
- **Scanner pula o owner** (não chama Cumbuca pra ele — não tem tokens)
- Bill permanece OPEN indefinidamente, sem mudança de status automática
- **Expira em 7 dias normalmente** (workflow de expiração não depende do
  scanner — corre no mesmo cron mas só usa o timestamp da bill, não
  consulta Cumbuca)
- Pra fechar a bill antes da expiração, user precisará usar um comando
  admin futuro (`/fechar <bill_id>`, fora deste escopo)

Cenário esperado: maioria dos testers conecta o banco (é o "wow"); alguns
podem testar sem conectar e isso é tolerável.

## 7. Cumbuca multi-tenant

### 7.1 Bootstrap (uma vez por instalação do Slice)

Pra inicializar o app, alguém (Danubio) precisa popular `cumbuca_app`
com `client_id` + `client_secret`. Opções:

- **Lazy bootstrap**: na primeira chamada de `cumbucaService.startOAuthForUser()`,
  se `cumbucaAppRepository.get()` for null, faz DCR e persiste. Mais limpo
  porque acontece naturalmente.
- **CLI bootstrap**: `npm run cumbuca:bootstrap` faz DCR explicitamente.
  Mais controlado.

Decisão: **lazy bootstrap, persistido permanentemente**. Na primeira
vez **na história da instância** que qualquer user pede `link_bank`,
o app faz DCR uma vez. As credenciais ficam em `cumbuca_app` (single
row, PK fixa = 1). Em todos os requests futuros (mesmo após restarts
ou redeploys), `cumbucaAppRepository.get()` lê do DB e reusa.

DCR é idempotente do nosso lado: o repository checa existência antes
de chamar `registerClient()`. Re-registro só aconteceria se alguém
truncar a tabela `cumbuca_app` manualmente.

### 7.2 OAuth flow por user

Reaproveita o refactor que já está na branch (file-based pending pairing
→ DB-backed pending pairing keyed por user_phone):

1. Bot decide gerar link — proativamente após register (caminho principal,
   ver §6.1) **OU** quando user emite `intent=link_bank` (caminho de
   recovery)
2. `cumbucaService.startOAuthForUser(user)`:
   - `cumbucaAppRepository.get()` ou lazy-bootstrap
   - Gera state random + code_verifier (PKCE)
   - `cumbucaPendingPairingRepository.set({ user_phone, state, code_verifier, ... })`
   - Monta authorize URL com app `client_id`, state, code_challenge,
     redirect_uri `https://bot.appslice.com.br/oauth/cumbuca/callback`
3. Bot manda URL pro user via WhatsApp envolto na mensagem explicativa
   (texto completo da §6.1; em caso de recovery, versão curta)
4. User abre URL → consent no banco → callback Cumbuca → callback Slice
5. Rota `/oauth/cumbuca/callback`:
   - Recebe `code` + `state`
   - `cumbucaPendingPairingRepository.findByState(state)` → identifica user
   - Valida TTL
   - Exchange code for tokens
   - `cumbucaTokensRepository.set({ user_phone, access_token, refresh_token,
     expires_at, account_id: '' })`
   - Apaga pending
   - Responde HTML branded (placeholder por enquanto, ver §10)
6. **Account selection no servidor (não no CLI)**: depois de persistir tokens
   sem account_id, fazer `list_accounts` automaticamente e:
   - Se 1 conta → pega ela
   - Se múltiplas → loga warning e pega a primeira (pra MVP). Multi-conta
     no produto fica como UX debt
7. Bot manda mensagem WhatsApp confirmando: "Tudo conectado! Vou te avisar
   quando seus contatos pagarem."

### 7.3 Refresh por user

Atual `refreshAccessToken` opera sobre `CumbucaTokens` único. Refator:
recebe `userPhone`, lê do `cumbucaTokensRepository`, faz refresh, persiste.

**Lock per-user**: o `inFlightRefresh: Promise<CumbucaTokens> | null`
atual vira `Map<userPhone, Promise<CumbucaUserTokens>>`. Garante que dois
chamadores concorrentes pro mesmo user compartilham o refresh; users
diferentes refresham em paralelo sem conflito.

### 7.4 isConnected per user

`isConnected: () => boolean` global vira `isConnectedFor(userPhone): boolean`.
Estado persistido implicitamente: `cumbucaTokensRepository.getForUser(phone)`
existe = conectado; se refresh falha repetidamente, podemos limpar tokens
(deferido — fica como follow-up #3 do roadmap do Cumbuca, agora aplicável
por user).

## 8. Scanner refactor pra multi-user

### 8.1 Comportamento atual (single-user)

```
loop:
  bills = billsRepository.findOpen()       // todas as bills OPEN
  scanForCredits(allBills)
  scheduleNextScan(based-on-newest-bill)
```

### 8.2 Comportamento alvo (multi-user)

```
loop:
  for ownerPhone in usersWithOpenBills():
    if !cumbucaTokensRepository.getForUser(ownerPhone): continue  // sem cumbuca, skip
    bills = billsRepository.findOpenForOwner(ownerPhone)
    sinceISO = computeSince(bills)
    credits = listAccountTransactionsForUser(ownerPhone, sinceISO)
    for credit in credits:
      if processedTransactionsRepository.wasAlreadyProcessed(credit.id, ownerPhone):
        continue
      matched = billService.tryReconcile(credit, ownerScope: ownerPhone)
      if matched: processedTransactionsRepository.markAsProcessed(credit.id, ownerPhone)
  scheduleNextScan(based-on-newest-bill-globally)
```

### 8.3 Rate limit awareness

Limite Cumbuca: `list_account_transactions` ≤7d = 240/mês por user
(≈8/dia). Cache server-side por `(account_id, from, to)`.

Pra N users com bills ativas concorrentemente:
- Cadence por owner ainda 5/15/60/360min adaptativa
- Cache vai naturalmente reduzir chamadas reais quando múltiplos scans
  pedem mesma janela
- Worst case com 10 users e bills frescas: 10 × 12 scans/hora = 120
  scans/hora. Boa parte cacheada. Sob o limite.

Se virar problema em escala maior, adicionar:
- Coalescing de scans próximos no tempo
- Sleep curto entre chamadas pra mesmo user (evitar burst)
- Fallback: scan menos frequente quando bill > 1h

### 8.4 Re-entrancy e scheduling

`scanInFlight` global vira `Set<userPhone>` — múltiplos users podem
scanear em paralelo, mas o mesmo user só roda um scan por vez. O timer
global (`setTimeout`) continua único: dispara um ciclo que itera os
users elegíveis.

## 9. Migração JSON → SQLite (one-shot)

Tarefa operacional pós-deploy:

```bash
# No VPS, dentro do container do bot, uma vez:
docker exec slice_bot npm run migrate:json-to-sqlite

# Output esperado:
# [migrate] reading data/cumbuca-tokens.json...
# [migrate] inserting user 5588998082034
# [migrate] inserting 3 bills (all owned by 5588998082034)
# [migrate] inserting 2 processed transactions
# [migrate] inserting 1 whatsapp window entry
# [migrate] backing up JSONs to data/.json-archive/
# [migrate] done — slice.db has 1 user, 3 bills, 2 processed_tx
```

Idempotente: re-rodar não duplica (cada insert verifica existência via PK).

Bind mount precisa estar configurado antes (ver §4.1).

## 10. Out of scope / follow-ups

Não fazem parte desta migração — capturados separadamente:

- **Landing page** (`appslice.com.br` apex) — você desenhando UX em
  paralelo, deploy via Dokploy tipo Static, integra-se depois. CTA
  aponta pro WhatsApp do bot que agora sabe receber user novo.
- **Estado-da-arte UX no callback OAuth** (HTML branded de sucesso/erro)
  — placeholder text/plain até virar produto.
- **Multi-conta Cumbuca por user** — hoje pega primeira; UX de "qual
  conta?" fica pra depois.
- **Limpeza de tokens Cumbuca em refresh failure persistente** —
  hoje só loga; deferido item #3 do roadmap Cumbuca, agora aplicável
  por user.
- **Comandos admin via WhatsApp** (`/listar`, `/cancelar`, `/status`)
  — futuros intents adicionais.
- **Multi-instance horizontal scaling** — SQLite trava em 1 instance.
  Quando precisar, migra repository implementation pra Postgres/Mongo.
- **Rename `racha-conta-bot` → `slice`** em package.json e similar
  (incluir `client_name` do DCR — fica visível na tela de consent do
  banco).
- **Auto-reconnect tooling de WhatsApp** — se Baileys cair, hoje
  re-pareamento é manual via curl docker exec. Comando WhatsApp ou
  scheduled health-check podem automatizar.
- **Métricas/observabilidade** (Prometheus, etc.) — UI Dokploy +
  /healthz cobrem o MVP.
- **Telegram como fallback de canal** — se WhatsApp/Baileys virar
  blocker, ter um plano B é estratégico mas fora deste escopo.

## 11. Estrutura final de arquivos

**Novos:**
- `src/repositories/sqlite.ts` — singleton do `Database` (better-sqlite3)
- `src/repositories/users.repository.ts`
- `src/repositories/bills.repository.ts` (substitui o atual)
- `src/repositories/cumbuca-app.repository.ts`
- `src/repositories/cumbuca-tokens.repository.ts` (substitui `cumbuca.tokens.ts`)
- `src/repositories/cumbuca-pending-pairing.repository.ts` (substitui o módulo atual)
- `src/repositories/processed-transactions.repository.ts` (substitui o atual)
- `src/repositories/whatsapp-window.repository.ts` (substitui o módulo atual)
- `src/repositories/schema.ts` — SQL CREATE TABLE strings + função `migrate()` aplicada no boot
- `src/services/users/user.service.ts` — handleRegistration, requireRegistrationFirst, etc.
- `bin/migrate-json-to-sqlite.ts` — script one-shot

**Modificados substancialmente:**
- `src/services/llm/gemini.ts` — system prompt com novos intents
- `src/services/llm/intent.types.ts` (NOVO se não existir) — discriminated union de intents
- `src/routes/whatsapp.webhook.ts` — vira dispatcher por intent
- `src/services/bills/bill.service.ts` — aceita owner User como contexto
- `src/services/cumbuca/cumbuca.client.ts` — split DCR app-level de OAuth per-user; refresh per-user com lock
- `src/services/whatsapp/whatsapp.ts` — `notifyUser(to, text)` (já preparado se ajustarmos)
- `src/workers/payment-scanner.worker.ts` — itera users
- `src/routes/cumbuca.oauth.ts` — callback resolve user via state, faz account selection automática
- `docker-compose.yml` — bot volume vira bind mount
- `package.json` — adiciona `better-sqlite3` em deps; adiciona `vitest` em devDeps; scripts `migrate:json-to-sqlite` e `test`

**Adicionados pra testing (ver §13):**
- `tests/helpers/test-db.ts`
- `tests/helpers/fake-cumbuca-client.ts`
- `tests/helpers/fake-gemini.ts`
- `tests/helpers/fake-whatsapp.ts`
- `tests/integration/*.test.ts` (7 arquivos)
- `vitest.config.ts`
- `.github/workflows/test.yml` (CI básico)

**Removidos:**
- `src/services/cumbuca/cumbuca.tokens.ts` (substituído por repository)
- `src/services/cumbuca/cumbuca.pending-pairing.ts` (substituído por repository)
- `src/services/whatsapp/window.ts` (substituído por repository)
- `src/bin/cumbuca-link.ts` (CLI deprecated; link via WhatsApp agora)

## 12. Riscos e mitigações

**Risco:** Gemini misclassifica intent (ex: "Sou João" interpreta como
nome quando user na verdade quis dizer "Soou João" sobre alguém).
**Mitigação:** intent disambiguation em casos borderline retorna
`unknown` e bot pede pra reformular. Iterar prompt com base nos
misclassifications observados em testers.

**Risco:** SQLite locking sob concorrência (webhook + scanner escrevendo
simultaneamente).
**Mitigação:** WAL mode habilitado no boot (`PRAGMA journal_mode = WAL`).
Permite leitura concorrente + 1 writer; suficiente pra single-process
node.

**Risco:** bind mount com permissões erradas → container não escreve.
**Mitigação:** runbook prevê `chown -R 1000:1000` do path no host. Bot
roda como user 1000 no node-alpine. Documentado e validado no smoke
local antes do deploy.

**Risco:** Cumbuca rate limit estourado em multi-user com muitas bills
frescas.
**Mitigação:** scanner já adaptativo; cache server-side; pra escala
maior, item de roadmap.

**Risco:** Migração JSON → SQLite perde algum dado.
**Mitigação:** script idempotente, JSONs antigos backed up em
`.json-archive/`, roda manualmente com inspeção do output. Pra MVP
single-user atual, os dados perdidos seriam mínimos (essencialmente o
seu próprio histórico de bills, que você pode perder sem dor — ou
preservar com o script).

**Risco:** OAuth callback de um user mata pending de outro (race).
**Mitigação:** pending keyed por user_phone (PK), não compartilha.
State token único por flow correlaciona corretamente.

## 13. Testing strategy

Convenção do projeto vinha sendo **sem testes automatizados** (apenas
`tsc --noEmit + commit`), trade-off consciente pra velocidade no MVP
single-user. Com o multi-user refactor — superfície de regressão muito
maior, especialmente em isolamento de tenant — o trade-off muda:
**integration tests nos fluxos críticos viram seguro contra regressão
silenciosa** que destruiria a fase de validação com testers.

### 13.1 Escopo deliberado

**Vamos testar:**
- Integration tests nos service-boundary com SQLite real (in-memory) +
  stubs simples pros HTTP externos
- Foco em fluxos onde regressão seria silenciosa e cara (isolamento de
  tenant, refresh de token concorrente, callback OAuth de múltiplos users)

**Não vamos testar:**
- Unit tests de coisas triviais (config parsing, formatBRL, normalize
  de número) — baixo valor, custo de manutenção
- E2E contra serviços reais (Cumbuca, Gemini, Meta) — caro,
  não-determinístico, risco de ban
- Mocking exagerado que testa "o mock funciona" em vez do comportamento real

### 13.2 Stack

- **Vitest** — rápido, ESM-friendly, zero build extra, syntax familiar
  (jest-like). Adicionado a `devDependencies`.
- **SQLite real em `:memory:`** ou arquivo temp (`/tmp/slice-test-xxx.db`)
  por teste isolado. Sem fakes de DB — SQLite é leve o suficiente pra
  ser real em teste.
- **Stubs simples** pros HTTP externos: helpers que substituem as
  funções de `cumbuca.client.ts`, `gemini.ts`, `whatsapp/cloudapi.client.ts`
  no test setup. Sem `nock` / `msw` pra começar — over-engineering.

### 13.3 Cenários cobertos (mínimo útil — ~20-30 testes em 7 arquivos)

**A. Bill creation isola owner** (`bill-creation.test.ts`)
- PIX gerado usa chave do owner, não do env nem de outro user
- `owner_phone` setado corretamente na bill
- Headcount + per-person amount corretos com edge cases (1 participante,
  N participantes incluindo o owner, decimal repetente)

**B. Reconciliation respeita owner isolation** (`reconciliation.test.ts`)
- Credit que entrou na conta do A só reconcilia bills DO A, nunca do B
- Match por amount + preferência por nome
- All-paid → status CLOSED + notification
- Credit órfão não marca processado (pode retentar)

**C. Scanner pula owners sem tokens Cumbuca** (`scanner-multiuser.test.ts`)
- Owners com tokens são scaneados em paralelo
- Owners sem tokens: pulados silenciosamente (não erro)
- Dedup de processed_transactions é per-user (mesmo tx_id em users
  diferentes não conflita — porém improvável no real)

**D. Token refresh per-user com lock** (`token-refresh.test.ts`)
- Dois calls concorrentes pro user A → uma única HTTP request,
  ambos recebem mesmo token
- Calls concorrentes pra A e B → duas HTTP requests paralelas, sem
  bloqueio mútuo
- Refresh fail → marca disconnected, próximo call respeita

**E. OAuth callback identifica user via state** (`oauth-callback.test.ts`)
- Two users com pending simultâneo: callback do A não bagunça pending do B
- State desconhecido → 401, nenhum user mexido
- Pending expirado (>10min) → 410 + cleanup do pending
- Code exchange fail → 500, pending NÃO é apagado (user pode retentar)

**F. Auto-registro via intent dispatcher** (`user-registration.test.ts`)
- Stub do Gemini retorna `register_account` → user persiste com defaults
  derivados (`pix_merchant_name` = nome, `pix_merchant_city` = 'BRASIL')
- Profile parcial (só nome) → user persiste, bot prompta PIX faltante
- Re-registro com mesmo phone → update do profile, não duplicação
- Após registro completo, bot dispara mensagem proativa de link com URL
  Cumbuca válida (mock sendText assertable)

**G. Migration JSON → SQLite preserva dados e é idempotente** (`migration.test.ts`)
- Setup com 4 JSONs conhecidos → migration → SQLite tem counts/fields certos
- Re-run da migration → nada duplica, counts iguais
- JSONs antigos movidos pra `.json-archive/`, paths corretos

### 13.4 Estrutura de arquivos

```
tests/
  helpers/
    test-db.ts             # cria :memory: DB com schema + applyMigrations()
    fake-cumbuca-client.ts # versão de cumbuca.client.ts pra teste
    fake-gemini.ts         # extractIntent stub controlável
    fake-whatsapp.ts       # sendText/sendTemplate stubs com assertion helpers
  integration/
    bill-creation.test.ts
    reconciliation.test.ts
    scanner-multiuser.test.ts
    token-refresh.test.ts
    oauth-callback.test.ts
    user-registration.test.ts
    migration.test.ts
vitest.config.ts
```

### 13.5 Workflow durante desenvolvimento

Convenção revista pro epic multi-user:
- Implementa repository → escreve 1-2 testes do repo
- Implementa service usando repo → escreve 2-3 testes do flow
- `npx tsc --noEmit && npm test` (ambos limpos) → commit

Pra tasks de infra/config (Docker, env vars) testes não se aplicam —
mantém `tsc + commit`.

### 13.6 CI

GitHub Actions workflow simples rodando `npm ci && npm test` em todo
push. Bloqueia auto-deploy do Dokploy via webhook? Não bloqueia —
Dokploy continua deployando em main. CI é sinal verde/vermelho, não
gate. Quando virar bloqueante (pós-validação 🟢), promove a required
check.

### 13.7 Que regressão isso pega

Casos reais que esses testes capturariam antes de chegar em testers:
- Esqueci de filtrar `owner_phone` numa query do scanner → testes C/B
  pegam
- Trocar `env.pixKey` por `user.pix_key` mas esquecer de propagar pro
  generator do PIX → teste A pega
- Refresh token concorrente sem lock vaza credenciais inválidas pro
  segundo caller → teste D pega
- Bug de regex no normalize-number → não pega (mas o impacto é
  pequeno; já validado manualmente)

O nível de cobertura é "smoke automatizado", não "exhaustive QA".
Suficiente pro estágio.
