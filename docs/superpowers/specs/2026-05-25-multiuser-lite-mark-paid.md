# Slice — Multi-User Lite + `mark_paid` Manual Design

**Status:** approved (design phase) — implementation pending
**Date:** 2026-05-25
**Author:** Danubio + Claude (brainstorm)
**Supersedes:** `2026-05-24-multiuser-sqlite-cumbuca-multitenant.md` (Cumbuca
multi-tenant inviável — ver §1)
**Depende de:** [2026-05-23-slice-baileys-deployment-design.md](./2026-05-23-slice-baileys-deployment-design.md)

---

## 1. Contexto e decisão

Smoke fechou em 2026-05-24. Bot em produção single-user (só
`USER_WHATSAPP_NUMBER`). Pra colocar na mão de algumas pessoas e ver no que dá,
precisamos de multi-user — mas **sem bater na barreira regulatória do Open
Finance agora**.

Tentamos desenhar Cumbuca multi-tenant (cada user conecta o banco dele) e é
inviável: o MCP da Cumbuca é licenciado pra uso pessoal, rotear consent de
terceiros te torna controlador LGPD + receptor de dados não-regulado pelo BCB,
e os rate limits são teto regulatório. Cogitamos resolver com criptografia
(servidor nunca vê os valores) — **não resolve**: o blocker é a relação
jurídica (quem é o TPP registrado), não a visibilidade dos dados; e
reconciliação server-side precisa do valor em plaintext em runtime de qualquer
jeito. O desbloqueio real é um TPP regulado (Belvo/Pluggy) + advogado, que só
vale a pena **depois** de validar.

**Decisão (pivot):** simplificar ao extremo. O usuário conversa com o bot, diz
que quer dividir uma conta, o backend gera o PIX copia-e-cola **no nome dele**,
e ele mesmo marca a conta como paga quando recebe. Sem integração bancária pros
testers. Poucos usuários, validação informal. Custo R$0.

## 2. Escopo

**Faz parte:**
- Multi-user via JSON files (sem SQLite) — `users.json` + `owner_phone` nas bills
- Auto-registro mínimo via WhatsApp: **nome + chave PIX** (sem email)
- Intent dispatcher: `create_bill`, `register_account`, `mark_paid`, `unknown`
- PIX gerado no nome de cada owner (não mais do env global)
- `mark_paid` manual: user marca "fulano pagou", casa por nome/valor, fecha bill
- Bot num número dedicado; webhook processa qualquer sender (não só o Danubio)

**Não faz parte (deliberado):**
- **SQLite / migration / `better-sqlite3`** — JSON já funciona pra poucos users;
  native build no Docker é fricção. Migra-se se validar.
- **Email no registro** — era pra Belvo/touchpoints, fora de cena.
- **Testes automatizados (vitest/CI)** — mantém a convenção do projeto
  (`tsc --noEmit` + smoke manual). Nice-to-have futuro.
- **Cumbuca multi-tenant / link de banco pros testers** — inviável (§1).
- **Belvo, webapp, criptografia E2E, comandos admin** — pós-validação.

**Cumbuca permanece no código, dormindo.** Não apaga nada. Single-user pro
Danubio. Única mudança: o scanner fica owner-scoped pra não reconciliar bills de
terceiros com PIX que cai na conta do Danubio (§7).

## 3. Data layer — JSON files (sem mudança de tecnologia)

Reaproveita o `billRepository` atual (mutex in-process sobre `data/db.json`).
Duas mudanças:

### 3.1 `users.json` (novo)

`data/users.json`, keyed por phone (E.164 sem `+`):

```json
{
  "users": {
    "5588998082034": {
      "name": "Danubio",
      "pix_key": "danubio@email.com",
      "pix_merchant_name": "Danubio",
      "pix_merchant_city": "BRASIL",
      "created_at": "2026-05-25T..."
    }
  }
}
```

Novo `src/repositories/user.repository.ts` (mesmo padrão do `bill.repository`:
mutex + read/write JSON):

```typescript
export interface User {
  phone: string;
  name: string;
  pix_key: string;                 // '' enquanto não coletado
  pix_merchant_name: string;       // derivado de name (≤25 chars) quando pix salvo
  pix_merchant_city: string;       // 'BRASIL'
  created_at: string;
}
export const userRepository = {
  findByPhone(phone: string): Promise<User | null>,
  insert(user: User): Promise<void>,
  update(phone: string, partial: Partial<User>): Promise<User | null>,
};
```

### 3.2 `owner_phone` nas bills

`Bill` ganha `owner_phone: string`. `billRepository`:
- `insert(bill)` — bill já carrega `owner_phone`
- `findOpenForOwner(ownerPhone)` — substitui o uso de `findOpen()` no scanner
- `findOpen()` permanece **só** pro workflow de expiração (global, todos owners)

### 3.3 Migration

Trivial, pode ser manual ou um script pequeno (`bin/seed-danubio-user.ts`):
- Cria o user Danubio em `users.json` a partir das env vars atuais
  (`USER_WHATSAPP_NUMBER`, `PIX_KEY`, `PIX_MERCHANT_NAME`, `PIX_MERCHANT_CITY`)
- Backfill `owner_phone = USER_WHATSAPP_NUMBER` nas bills existentes do `db.json`

Roda uma vez no deploy. Não é crítico (histórico de bills do Danubio é
descartável).

## 4. Intent dispatcher

### 4.1 Intents

```typescript
type Intent =
  | { intent: 'create_bill'; bill: ExtractedBill }
  | { intent: 'register_account'; profile: { name?: string; pix_key?: string } }
  | { intent: 'mark_paid'; payment: { name?: string; amount?: number } }
  | { intent: 'unknown' };
```

`ExtractionResult` em `bill.types.ts` vira essa union (ou move pra
`intent.types.ts` — detalhe do plan).

### 4.2 Prompt do Gemini

`RESPONSE_SCHEMA` (em `gemini.ts`) e o few-shot (em `prompt.ts`) cobrem os 4
intents. Regras-chave:

- **create_bill** (já existe): "paguei 60 na pizza, divide com Ana e Beto".
- **register_account**: "sou João, pix joao@email.com" → `{name, pix_key}`.
  Tolerante a parcial e ordem livre. Nome composto = nome completo até separador
  (vírgula, "e", ponto, "pix"). Telefone do user: NUNCA extrair.
- **mark_paid**: "Maria pagou" → `{name:"Maria"}`; "recebi 20 do João" →
  `{name:"João", amount:20}`; "caiu 30 aqui" → `{amount:30}`.
- **Desambiguação create_bill vs mark_paid pela direção do dinheiro:** "paguei X"
  (ELE pagou) = create_bill; "fulano (me) pagou / recebi de fulano" = mark_paid.
- Ambíguo / saudação / lixo → `unknown`.

### 4.3 Dispatcher no webhook

```typescript
// src/routes/whatsapp.webhook.ts (pseudo)
const senderPhone = extractRemoteNumber(body);   // qualquer sender, não só Danubio
const user = await userRepository.findByPhone(senderPhone);
const result = await extractIntent(text);

switch (result.intent) {
  case 'register_account':
    return userService.handleRegistration(senderPhone, result.profile);
  case 'create_bill':
    if (!user) return userService.requireRegistrationFirst(senderPhone);
    if (!user.pix_key) return userService.requirePixFirst(senderPhone, user.name);
    return billService.createBillFromExtraction(result.bill, user);
  case 'mark_paid':
    if (!user) return userService.requireRegistrationFirst(senderPhone);
    return billService.markPaid(senderPhone, result.payment);
  default:
    return userService.notifyUnknown(senderPhone, !!user);
}
```

## 5. Auto-registro mínimo

Primeira mensagem de sender desconhecido → onboarding. Coleta **nome + chave
PIX** (sem email).

```
User (desconhecido) → "oi"
Bot: "Olá! Sou o Slice 👋 Pra dividir suas contas eu preciso do seu nome e da
      sua chave PIX (é nela que seus amigos vão te pagar). Manda algo tipo:
      'Sou João, pix joao@email.com'."
User: "Sou João Pedro Silva, pix joao@email.com"
Bot: "Tudo certo, João Pedro! 🎉 Agora é só mandar uma conta, ex: 'paguei 60 na
      pizza, divide com Ana e Beto'. Quando alguém te pagar, me avisa
      ('a Ana me pagou') que eu fecho."
```

Ao salvar o `pix_key`, deriva `pix_merchant_name = name` (truncado a 25 chars,
limite do BR Code) e `pix_merchant_city = 'BRASIL'`.

**Edge cases:**
- **Parcial** (só nome, ou só pix): bot persiste o que veio e pede o que faltou.
- **create_bill sem registro**: bot pede registro.
- **create_bill registrado mas sem pix_key**: bot pede a chave PIX, depois user
  reenvia a bill (MVP: re-envio manual; memorizar a bill pendente é futuro).
- **mark_paid sem registro**: bot pede registro.
- **Correção**: `register_account` parcial atualiza ("mudei o pix pra X").

## 6. `mark_paid` — marcação manual

`billService.markPaid(ownerPhone, { name?, amount? })`:

1. Carrega bills OPEN do owner (`findOpenForOwner`) e participantes `PENDING`.
2. **Matching** (reusa a lógica do `findMatch` atual):
   - `name` → substring case-insensitive contra nomes pendentes
   - `amount` → `|amount_due - amount| < 0.005`
   - ambos → interseção; só um → filtra por aquele
3. **Resolução:**
   - **1 match** → marca `PAID` + `paid_at`; se todos pagos → `CLOSED`. Notifica
     ("Anotado, Ana pagou! Ainda falta: Beto." / "Fechou! Conta zerada 💸").
   - **N matches** (ambíguo) → bot pergunta: "Quem pagou? Tenho Ana (R$20) e Beto
     (R$20) em aberto."
   - **0 match** → "Não achei pendência com esse nome/valor. Em aberto: Ana
     (R$20), Beto (R$20)."
4. **Idempotente**: marcar quem já é `PAID` não muda nada ("Ana já estava paga").
5. **Owner-scoped**: só mexe nas bills do `ownerPhone`. Mesmo nome em owners
   diferentes não colide.

## 7. WhatsApp multi-user + scanner

### 7.1 Canal (Baileys/Evolution)

> Premissa corrigida: o spec/plan anteriores referenciavam Cloud API
> (`sendTemplate`, janela 24h). A prod roda **Baileys via Evolution** —
> `whatsapp.ts` → `/message/sendText`. Sem janela, sem template, texto livre.

- Bot num **número dedicado**; inbound de terceiros chega `fromMe=false`, echoes
  do bot `fromMe=true` (ignorados).
- Webhook **remove** o filtro `numbersMatch(remoteNumber, env.userWhatsappNumber)`
  — qualquer sender é potencial user.
- O cache `wasSentByBot`/`sentTexts`/`sentIds` (do modelo antigo "user manda pra
  si mesmo") **sai** — com número dedicado, filtra-se por `fromMe`.
- `notifyUser(text)` (global) → `sendText(to, text)` com destinatário explícito
  (o owner relevante).

### 7.2 PIX por owner

`buildPixPayload` deixa de ler `env.pixKey/pixMerchantName/pixMerchantCity` e
passa a receber `{ key, merchantName, merchantCity }` do owner da bill.

### 7.3 Scanner (Cumbuca, só Danubio)

Mudança mínima pra correção multi-user:
- Reconciliação: `findOpen()` → `findOpenForOwner(USER_WHATSAPP_NUMBER)`. Só as
  bills do Danubio são casadas contra o Cumbuca dele. **Sem isso, PIX que cai na
  conta do Danubio fecharia bills de terceiros por engano.**
- `tryReconcile(tx, ownerPhone)` opera owner-scoped; notifica o owner.
- **Expiração de 7 dias continua global** (`findOpen()` de todos, expira > 7d) —
  independe de Cumbuca.
- Resto do scanner (cadência adaptativa, factory cumbuca|mock) inalterado.

## 8. Arquivos

**Novos:**
- `src/repositories/user.repository.ts` — JSON `users.json` (mesmo padrão de bill.repository)
- `src/services/users/user.service.ts` — handleRegistration, requireRegistrationFirst, requirePixFirst, notifyUnknown
- `bin/seed-danubio-user.ts` — seed one-shot (opcional)

**Modificados:**
- `src/services/llm/gemini.ts` — RESPONSE_SCHEMA com 4 intents
- `src/services/llm/prompt.ts` — few-shot dos novos intents
- `src/services/bills/bill.types.ts` — `Bill.owner_phone`; `ExtractionResult` vira union
- `src/repositories/bill.repository.ts` — `owner_phone`, `findOpenForOwner`
- `src/services/bills/bill.service.ts` — `createBillFromExtraction(bill, owner)`, `markPaid(ownerPhone, input)`, `tryReconcile(tx, ownerPhone)`
- `src/services/pix/pix.ts` — `buildPixPayload({ ...args, key, merchantName, merchantCity })`
- `src/services/whatsapp/whatsapp.ts` — remove `wasSentByBot`/caches/`notifyUser`; expõe `sendText(to,text)`
- `src/routes/whatsapp.webhook.ts` — dispatcher por intent; remove filtro single-user
- `src/workers/payment-scanner.worker.ts` — reconcile owner-scoped (Danubio); expiração global
- `src/config/env.ts` — `PIX_*` viram seed do user Danubio (não runtime); remove `WORKER_INTERVAL_MS` morto

**Intocado:** todo o módulo `services/cumbuca/*`, `services/ledger/*`,
`bin/cumbuca-link.ts`, `routes/cumbuca.oauth.ts`.

## 9. Riscos

- **Gemini confunde create_bill vs mark_paid** → few-shot com regra de direção do
  dinheiro; borderline → `unknown` e re-pergunta.
- **mark_paid fecha bill errada** → match owner-scoped; ambíguo → pergunta em vez
  de adivinhar.
- **Scanner do Danubio reconcilia bill de terceiro** → mitigado pelo owner-scope
  (§7.3) — é o motivo principal dessa mudança.
- **Concorrência JSON** (webhook + scanner) → mutex in-process já existente nos
  repositories; suficiente pra single-process + poucos users.
- **PIX no nome errado** → `buildPixPayload` recebe os dados do owner; smoke
  manual confirma antes de liberar.

## 10. Validação

Poucas pessoas do círculo, uso informal. Observar: (a) entendem o onboarding?
(b) o PIX gerado funciona no nome delas? (c) usam o `mark_paid`? (d) o bot
classifica certo? Se houver tração, aí sim discute-se Belvo/SQLite/webapp.
