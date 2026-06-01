# Slice — WhatsApp Bot pra dividir conta

(repo ainda chamado `racha-conta-bot`; rebrand pro Slice em andamento.)

Bot de WhatsApp que recebe uma frase em português — "Paguei 60 na pizzaria,
divide com João e Maria, 20 cada" — extrai os dados via Gemini, gera um **PIX
Copia-e-Cola por participante** e responde no chat. Multi-user lite: quem manda
mensagem se auto-registra (nome + chave PIX) e o PIX sai no nome do dono da conta.
A reconciliação é **manual** — o dono marca a conta como paga (`mark_paid`).

WhatsApp via **Twilio** (API oficial). O setup do número fica no runbook
`docs/superpowers/runbooks/2026-05-31-twilio-setup.md`.

---

## Como funciona

```
WhatsApp do usuário
   │  (mensagem de texto)
   ▼
Twilio  ──webhook POST (urlencoded + X-Twilio-Signature)──▶  /webhooks/whatsapp
                                                                   │
                                          valida assinatura, parseia From/Body
                                                                   ▼
                                          dispatchIncomingMessage(phone, text)
                                                                   │
                              extractIntent (Gemini 3.1-flash-lite + histórico)
                                                                   ▼
        create_bill · register_account · mark_paid · list_bills · close_bill · unknown
                                                                   │
                                        ação determinística (SQLite) + resposta
                                                                   ▼
                                        sendText → Twilio → WhatsApp do usuário
```

- **Caminho do dinheiro é determinístico** — o Gemini só classifica/extrai; quem cria
  conta, gera PIX e marca pago é o código.
- **Histórico de conversa** (tabela `conversation_turns`) alimenta o Gemini pra
  follow-ups com contexto e slot-filling. Ações continuam stateless.

---

## Stack

- **Runtime:** Node 20+, TypeScript, [Fastify](https://fastify.dev).
- **WhatsApp:** Twilio (SDK oficial `twilio`; webhook `@fastify/formbody`).
- **LLM:** `@google/genai` → `gemini-3.1-flash-lite` (thinking `MINIMAL`).
- **Persistência:** SQLite via `better-sqlite3` (`data/slice.db`).
- **PIX:** `qrcode-pix` (BR Code Copia-e-Cola, só texto).
- **Testes:** vitest (integração: SQLite efêmero + Gemini/sendText stubados).

---

## Rodar localmente

O bot não gerencia mais conexão de WhatsApp (a Twilio cuida disso). Pra desenvolver,
você expõe o webhook local com um túnel e usa o **Sandbox da Twilio**.

```bash
npm install
cp .env.example .env
# preencha TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
#          USER_WHATSAPP_NUMBER, GEMINI_API_KEY, PIX_KEY, PIX_MERCHANT_NAME, PIX_MERCHANT_CITY

# 1. Suba um túnel pro localhost:3000 (ex.: cloudflared)
cloudflared tunnel --url http://localhost:3000

# 2. No console Twilio (Messaging → Try it out → Send a WhatsApp message),
#    aponte "When a message comes in" pra https://<tunel>/webhooks/whatsapp
#    e entre no Sandbox mandando "join <código>" do seu WhatsApp.
#    Use TWILIO_WHATSAPP_FROM=whatsapp:+14155238886 (número do Sandbox) no .env.

# 3. Rode o bot
npm run dev
```

Detalhes (Sandbox vs número de produção, migração do chip, gotchas de assinatura):
`docs/superpowers/runbooks/2026-05-31-twilio-setup.md`.

> O `docker-compose.yml` ainda traz Evolution/Postgres/Redis — é o **provider
> antigo (Baileys)**, mantido como fallback durante a transição pro Twilio. Não é
> mais necessário pro fluxo de WhatsApp.

---

## Variáveis de ambiente

| Var | O que é |
|-----|---------|
| `TWILIO_ACCOUNT_SID` | Account SID (Console → Account Info) |
| `TWILIO_AUTH_TOKEN` | Auth Token — **segredo**; usado também pra validar a assinatura do webhook |
| `TWILIO_WHATSAPP_FROM` | número do bot em `whatsapp:+E.164` (Sandbox ou produção) |
| `USER_WHATSAPP_NUMBER` | número do operador (Danubio), E.164 sem `+` |
| `GEMINI_API_KEY` | https://aistudio.google.com/app/apikey |
| `PIX_KEY`, `PIX_MERCHANT_NAME`, `PIX_MERCHANT_CITY` | dados do PIX estático |
| `PORT`, `PUBLIC_BASE_URL` | porta e URL pública do bot |
| `LEDGER_SOURCE` | `cumbuca` \| `mock` — legado dormente (ver nota no fim) |
| `SLICE_DB_PATH` | caminho do SQLite; os testes usam `:memory:` |

---

## Testes

```bash
npm test         # vitest run
npm run typecheck # tsc --noEmit
```

Testes de integração rodam contra um SQLite efêmero, com o Gemini (`extractIntent`)
e o `sendText` stubados — asserta as mensagens enviadas **e** o estado do banco. A
acurácia de classificação do LLM e o feel conversacional ficam pro smoke ao vivo
(o CI stuba o modelo).

---

## Deploy

Hetzner + Dokploy. `git push` na `main` → Dokploy auto-deploya via webhook do
GitHub (bot + landing). Em produção o webhook da Twilio aponta pra
`https://bot.appslice.com.br/webhooks/whatsapp`.

---

## Layout

```
src/
  server.ts                         Fastify bootstrap (formbody) + scanner boot
  config/env.ts                     carrega + valida env
  lib/phone.ts                      normalização BR (nono dígito) + endereço whatsapp:+E.164
  routes/whatsapp.webhook.ts        POST /webhooks/whatsapp (parse Twilio + valida assinatura)
  services/
    dispatch/dispatch-message.ts    dispatchIncomingMessage: roteia intent → ação
    llm/
      gemini.ts                     extractIntent(text, ctx, history)
      prompt.ts                     prompt + few-shots
    bills/
      bill.types.ts                 Bill, Participant, ExtractionResult, enums
      bill.service.ts               createBillFromExtraction, markPaid, listOpenBills, closeBills
    users/user.service.ts           handleRegistration
    pix/pix.ts                      BR Code Copia-e-Cola
    messaging/voice.ts              fonte única das mensagens do bot
    whatsapp/whatsapp.ts            sendText via SDK Twilio
  repositories/                     SQLite (db, user, bill, conversation, unknown-intents)
  workers/payment-scanner.worker.ts reconciliação (dormente — ver Cumbuca)
docker-compose.yml                  stack do provider antigo (Evolution) — fallback
```

---

## Docs

- Specs e planos: `docs/superpowers/specs/` e `docs/superpowers/plans/`.
- Runbooks (Twilio, VPS): `docs/superpowers/runbooks/`.

## Nota: Cumbuca (legado dormente)

O código em `src/services/cumbuca/`, `src/services/ledger/`,
`workers/payment-scanner.worker.ts` e `routes/cumbuca.oauth.ts` é de uma fase
anterior (reconciliação automática via Open Finance). **Cumbuca saiu do escopo** em
2026-05-26; o código continua no repo mas está dormente e será removido. A
reconciliação hoje é manual (`mark_paid`).
