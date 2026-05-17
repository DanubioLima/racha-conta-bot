# Racha-Conta WhatsApp Bot — MVP Design

**Date:** 2026-05-16
**Status:** Approved
**Author:** brainstorm session with user

## Goal

Build a single-user WhatsApp bot that lets the user split a bill via a free-text
message, generates PIX codes for each participant, and closes the bill as
incoming payments are detected. The goal of this MVP is to validate the
conversational flow against the user's own bank account within hours, not
to build a production-ready system.

The Cumbuca MCP integration is deferred: incoming payment detection is mocked
via a local JSON file shaped like the future Cumbuca payload, so the rest of
the system can be validated independently.

## Scope (in / out)

**In scope**

- Inbound webhook from Evolution API (single user, single WhatsApp number).
- LLM-based extraction of bill description, total amount, and participants
  from Portuguese free text.
- Static PIX Copia-e-Cola generation per participant.
- Local JSON persistence of bills and participants.
- Background worker that polls a mocked incoming-transactions file and
  reconciles payments against open bills.
- Humanized Portuguese reply messages on bill creation, individual payment,
  and bill closure.

**Out of scope (deferred)**

- Real Cumbuca MCP integration (rate-limit + auth flow blockers).
- Multi-user support — only the configured `USER_WHATSAPP_NUMBER` is served.
- Editing or cancelling an open bill via chat.
- Authentication on the webhook (assumed local / trusted network for MVP).
- Idempotency on webhook redelivery.
- Automated tests — validation is manual via WhatsApp + editing the mock file.

## Architecture

Single Node.js 24 process running Fastify:

- HTTP server exposes `POST /webhooks/whatsapp` to receive Evolution API events.
- A background worker (`setInterval`) ticks every `WORKER_INTERVAL_MS` and
  reconciles entries from the mocked incoming-transactions file against
  participants of `OPEN` bills.
- A JSON file repository at `data/db.json` holds all bills. All reads and
  writes go through a single in-process mutex to avoid interleaved writes
  between the webhook handler and the worker.

External services:

- **Gemini 2.0 Flash** for natural-language extraction (JSON mode).
- **Evolution API** for outbound WhatsApp messages.
- **qrcode-pix** (local library) to build static PIX payloads from a configured
  PIX key.

## Folder structure

```
whats-test/
├── src/
│   ├── server.ts                        # Fastify bootstrap + worker boot
│   ├── config/env.ts                    # Loads + validates env vars
│   ├── routes/whatsapp.webhook.ts       # POST /webhooks/whatsapp
│   ├── services/
│   │   ├── llm/gemini.ts                # extractBillFromText(text)
│   │   ├── pix/pix.ts                   # buildPixPayload(amount, txid)
│   │   ├── evolution/evolution.ts       # sendText(to, message)
│   │   └── bills/
│   │       ├── bill.service.ts          # createBill, matchPayment, closeBill
│   │       └── bill.types.ts            # Bill, Participant, status enums
│   ├── repositories/bill.repository.ts  # read/write db.json (mutex-guarded)
│   ├── workers/ledger.worker.ts         # checkIncomingTransactions()
│   └── mock/incoming-transactions.json  # seeded payments
├── data/db.json                         # gitignored
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Data model

```ts
type BillStatus = 'OPEN' | 'CLOSED';
type ParticipantStatus = 'PENDING' | 'PAID';

interface Participant {
  name: string;
  amount_due: number;
  status: ParticipantStatus;
  pix_payload: string;
  paid_at?: string;       // ISO timestamp when status flipped to PAID
}

interface Bill {
  id: string;             // ulid
  description: string;
  total_amount: number;
  amount_per_person: number;
  status: BillStatus;
  created_at: string;     // ISO timestamp
  participants: Participant[];
}
```

Mocked incoming transaction (kept close to the expected future Cumbuca shape):

```ts
interface IncomingTransaction {
  id: string;
  amount: number;
  payer_name: string;
  occurred_at: string;    // ISO timestamp
  consumed?: boolean;     // worker sets to true after reconciling
}
```

The mock file ships pre-populated with 2–3 sample entries that match the
participants of an example bill the user will create on first run.

## End-to-end flow

1. User sends in WhatsApp:
   *"Paguei 60 reais em uma pizzaria, dividir com João e Maria, 20 cada."*
2. Evolution API forwards the `MESSAGES_UPSERT` event to
   `POST /webhooks/whatsapp`.
3. The route extracts the message text and calls
   `gemini.extractBillFromText(text)`, which returns
   `{ description, total_amount, participants[] }`. If extraction fails or
   returns malformed JSON, the bot replies asking the user to rephrase and
   the flow stops.
4. `bill.service.createBill()` computes `amount_per_person` (defaults to
   `total_amount / participants.length` when not provided), builds a static
   PIX payload per participant via `pix.buildPixPayload()`, and persists the
   bill with `status: 'OPEN'`.
5. `evolution.sendText()` posts a humanized reply containing the description,
   per-person amount, and each participant's PIX code clearly separated.
6. The ledger worker ticks every `WORKER_INTERVAL_MS`, reads
   `mock/incoming-transactions.json`, and for each non-consumed transaction
   looks for a participant in any `OPEN` bill whose `amount_due` equals the
   transaction `amount`. Name is used as a tiebreaker when multiple
   participants share the same amount.
7. On match, the participant's `status` flips to `PAID`, the transaction is
   marked `consumed: true`, and a humanized notification is sent.
8. When every participant on a bill is `PAID`, the bill's `status` flips to
   `CLOSED` and a closing message is sent.

## LLM contract

Prompt instructs Gemini 2.0 Flash to return strict JSON matching:

```json
{
  "description": "Pizzaria",
  "total_amount": 60.00,
  "participants": [
    { "name": "João", "amount_due": 20.00 },
    { "name": "Maria", "amount_due": 20.00 }
  ]
}
```

Rules baked into the prompt:

- Currency is BRL; amounts are numbers, not strings.
- If the user gives a count instead of names ("dividir por 4"), generate
  placeholder names `Pessoa 1`…`Pessoa N`.
- If amounts per person are not stated, divide `total_amount` evenly,
  rounding to two decimals; the last participant absorbs any rounding remainder.
- If the message is not a bill-creation intent, return
  `{ "intent": "unknown" }` so the route can reply with a clarification.

## Outbound message templates (Portuguese, humanized)

- **Bill created:** "Anotei a sua conta de R$ 60,00 na Pizzaria. Ficou R$ 20,00
  pra cada um. Te mando os PIX abaixo, é só repassar pro João e pra Maria:
  …"
- **Participant paid:** "O João acabou de pagar! R$ 20,00 caíram aqui.
  Falta só a Maria pra fechar essa conta."
- **Bill closed:** "Fechou! Todos pagaram a conta da Pizzaria.
  Saldo zerado 💸"

The exact wording lives in `services/bills/bill.service.ts` and can be tuned
without changing the contract.

## Environment variables

```
PORT=3000
EVOLUTION_API_URL=
EVOLUTION_API_KEY=
EVOLUTION_INSTANCE=
USER_WHATSAPP_NUMBER=             # destination for outbound notifications
GEMINI_API_KEY=
PIX_KEY=
PIX_MERCHANT_NAME=
PIX_MERCHANT_CITY=
WORKER_INTERVAL_MS=30000
```

`config/env.ts` validates required vars at boot and exits with a clear error
if any are missing.

## Error handling

- Webhook handler validates only the shape of the incoming payload
  (sender id + text). Anything else is logged and ignored.
- LLM failures (network, parse) reply with a "não entendi, pode reformular?"
  message and do not persist anything.
- Worker errors are logged and do not crash the process — the next tick tries
  again.
- Repository writes are serialized via an in-memory mutex; corrupted
  `db.json` causes a startup error rather than silent recovery.

## Dependencies

Runtime:

- `fastify`
- `axios`
- `dotenv`
- `qrcode-pix`
- `ulid`
- `@google/genai` (Gemini SDK)

Dev:

- `typescript`
- `tsx` (run TS directly during MVP)
- `@types/node`

## Validation plan

- Send a real WhatsApp message from the user's phone and confirm a bill is
  created and PIX codes are returned.
- Manually edit `mock/incoming-transactions.json` to simulate a participant
  paying; confirm the worker notifies and updates state on the next tick.
- Repeat for the last remaining participant; confirm the bill closes and the
  closing message is sent.
