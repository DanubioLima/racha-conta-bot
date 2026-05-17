# Racha-Conta WhatsApp Bot (MVP)

Bot single-user de WhatsApp que recebe uma mensagem em texto livre,
divide a conta e gera PIX Copia-e-Cola por participante. As entradas de
pagamento ficam mockadas em um JSON local nessa fase do MVP.

Design completo: `docs/superpowers/specs/2026-05-16-racha-conta-whatsapp-bot-design.md`.
Plano de implementação: `docs/superpowers/plans/2026-05-16-racha-conta-whatsapp-bot.md`.

---

## TL;DR — subir tudo localmente

```bash
# 1. Subir Evolution API + Postgres + Redis
docker compose up -d

# 2. Instalar deps do bot e configurar .env
npm install
cp .env.example .env   # já vem apontando para o Evolution local
# preencha USER_WHATSAPP_NUMBER, GEMINI_API_KEY, PIX_KEY, PIX_MERCHANT_NAME, PIX_MERCHANT_CITY

# 3. Criar e parear a instância do Evolution (passo único)
#    Veja a seção "Parear o WhatsApp" abaixo.

# 4. Rodar o bot
npm run dev
```

---

## Componentes do stack local

`docker compose up -d` sobe três containers:

| Serviço | Porta no host | O que é |
|---------|---------------|---------|
| `evolution_api` | `8080` | API do Evolution (recebe webhooks, envia mensagens) |
| `evolution_postgres` | `5432` | Banco interno do Evolution |
| `evolution_redis` | `6379` | Cache do Evolution |

**Credenciais de dev (apenas para a stack local):**
- `AUTHENTICATION_API_KEY` da Evolution = `change-me-local-dev` — já está no `docker-compose.yml` e no `.env.example`. **Troque antes de expor a stack pra fora do localhost.**
- Postgres: `evolution` / `evolution`.

> O container oficial `evoapicloud/evolution-manager` (UI web) está com o
> nginx quebrado nas tags atuais e foi removido do compose. Use o fluxo via
> curl abaixo, ou — se quiser uma UI — aponte o manager hospedado em
> https://manager.evoapicloud.com para `http://localhost:8080` com a key
> `change-me-local-dev`.

---

## Parear o WhatsApp (uma vez)

Você precisa criar uma "instância" no Evolution e parear ela com o seu número
de WhatsApp escaneando um QR Code.

```bash
# 1. Criar a instância (o nome precisa bater com EVOLUTION_INSTANCE do .env)
curl -s -X POST http://localhost:8080/instance/create \
  -H "apikey: change-me-local-dev" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceName": "racha-conta",
    "qrcode": true,
    "integration": "WHATSAPP-BAILEYS"
  }' | jq
```

A resposta inclui um campo `qrcode.base64` no formato `data:image/png;base64,...`.
Cole esse data URL na barra de endereço do Chrome (ou em qualquer visualizador
de PNG base64), abra o WhatsApp do celular em
**Configurações → Aparelhos conectados → Conectar um aparelho** e escaneie.

Se o QR expirar antes de você escanear, gere um novo:

```bash
curl -s http://localhost:8080/instance/connect/racha-conta \
  -H "apikey: change-me-local-dev" | jq
```

Para checar o status da instância depois:

```bash
curl -s http://localhost:8080/instance/connectionState/racha-conta \
  -H "apikey: change-me-local-dev" | jq
```

Quando aparecer `state: "open"`, está pareado.

---

## Configurar o webhook (uma vez por instância)

O Evolution precisa saber pra onde mandar as mensagens recebidas. Aponte ele
pro bot rodando no host.

```bash
curl -s -X POST http://localhost:8080/webhook/set/racha-conta \
  -H "apikey: change-me-local-dev" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "http://host.docker.internal:3000/webhooks/whatsapp",
      "byEvents": false,
      "base64": false,
      "events": ["MESSAGES_UPSERT"]
    }
  }' | jq
```

`host.docker.internal` resolve para a sua máquina hospedeira a partir de
dentro do container do Evolution (o `extra_hosts` do compose configura isso
automaticamente no Linux). Se você preferir não usar Docker DNS, substitua
por `http://<seu-IP-da-LAN>:3000/webhooks/whatsapp`.

---

## Rodar o bot

```bash
npm install
cp .env.example .env
# preencha USER_WHATSAPP_NUMBER, GEMINI_API_KEY, PIX_KEY, PIX_MERCHANT_NAME, PIX_MERCHANT_CITY
npm run dev
```

Logs esperados:

```
Server listening at http://0.0.0.0:3000
[worker] ledger worker starting (interval 30000ms)
```

---

## Smoke test ponta-a-ponta

1. Pelo seu WhatsApp (o mesmo `USER_WHATSAPP_NUMBER` do `.env`), envie pra
   **o próprio número** que você pareou no Evolution:

   > Paguei 40 reais na pizzaria, dividir entre João e Maria, 20 cada.

2. Em poucos segundos o bot responde no mesmo chat com a confirmação e dois
   códigos PIX Copia-e-Cola — um pro João, um pra Maria.

3. O arquivo `src/mock/incoming-transactions.json` já vem com dois pagamentos
   simulados (João e Maria, R$ 20 cada). Dentro do intervalo
   `WORKER_INTERVAL_MS` (default 30 s) o worker reconcilia ambos e fecha a
   conta — você recebe uma notificação a cada pagamento e a mensagem final
   de fechamento.

4. Pra testar outros cenários, edite `src/mock/incoming-transactions.json`
   (adicione entradas com `consumed: false`). O worker re-lê o arquivo a cada
   tick.

---

## Resetar estado

```bash
rm -f data/db.json                              # apaga as bills criadas
git checkout src/mock/incoming-transactions.json  # reseta o mock seedado
docker compose down -v                          # apaga TAMBÉM Postgres/Redis e
                                                #   a sessão WhatsApp pareada
```

---

## Layout

```
src/
  server.ts                       Fastify bootstrap + worker boot
  config/env.ts                   loads + validates env
  routes/whatsapp.webhook.ts      POST /webhooks/whatsapp
  services/
    llm/gemini.ts                 extractBillFromText
    pix/pix.ts                    buildPixPayload
    whatsapp/whatsapp.ts          sendText, notifyUser, wasSentByBot
    bills/
      bill.types.ts               Bill, Participant, enums
      bill.service.ts             createBill, tryReconcile, notifyUnknown
  repositories/bill.repository.ts read/write data/db.json (mutex)
  workers/ledger.worker.ts        roda a cada WORKER_INTERVAL_MS
  mock/incoming-transactions.json pagamentos fake pra reconciliação
docker-compose.yml                stack local do Evolution (api, manager, pg, redis)
```
