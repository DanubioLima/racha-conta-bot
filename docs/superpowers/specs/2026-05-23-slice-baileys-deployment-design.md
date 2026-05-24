# Slice — Cloud Deployment Design (Baileys path)

**Status:** approved (design phase) — implementation pending
**Date:** 2026-05-23
**Author:** Danubio + Claude (brainstorm)
**Replaces:** [2026-05-23-slice-deployment-design.md](./2026-05-23-slice-deployment-design.md) (path Cloud API, abandonado)

---

## 1. Contexto e motivação

A primeira tentativa de migração apostou no caminho oficial Meta Cloud API
pra eliminar o risco de ban do Baileys. Resultado: ao tentar registrar o
chip Vivo secundário e submeter templates, **Meta baniu o chip
preventivamente — antes de qualquer mensagem ser enviada — e o ban foi
total (bloqueio tanto no Cloud API quanto no WhatsApp consumer).** Request
Review disparado, sem resposta.

Padrão conhecido: Meta tem scoring automático hostil a contas novas /
Business Managers recém-criados / contas individuais sem volume comercial
verificável. Pra um projeto pessoal MVP de uso próprio, esse caminho
embute fricção imprevisível e custo alto em caso de erro (perda do chip
inteiro).

Decisão: **voltar pro Baileys+Evolution**, mas mantendo todo o resto da
infra de deploy (Hetzner+Dokploy+DNS+Cumbuca refactor). O chip novo (a
ser comprado) é pareado via Evolution Baileys; risco de ban Baileys é
diferente (volume/spam patterns, não registro) e baixo pra single-user.
Se acontecer, custo é só comprar outro chip pré-pago.

Mantém-se intactos os objetivos originais:
- Bot rodando 24/7 sem depender da máquina local
- Risco de ban contido no chip secundário (não no número principal)
- Cumbuca + scanner + reconciliação inalterados

## 2. Approach escolhido

**Hetzner CPX11 + Dokploy + Compose Stack (bot + Evolution + Postgres + Redis)**

- VPS Hetzner CPX11 (2 vCPU AMD, 2GB RAM, 40GB SSD, ~€4,50/mês)
- Dokploy gerencia Docker + Traefik (TLS Let's Encrypt) + UI
- `docker-compose.yml` cloud-first com profile `prod` que ativa o serviço
  bot; em dev local o profile fica desativado e o bot roda via `npm run dev`
- Domínio `appslice.com.br` (já registrado) com subdomínios `bot.` e
  `dokploy.`
- WhatsApp via **Evolution API + Baileys** (path que já funcionava antes,
  agora hospedado em cloud em vez de local)
- Cumbuca MCP **preservado integralmente**, com o refactor de OAuth
  já cherry-picked (rota agora vive no servidor principal, re-pareamento
  sem downtime)

**Considerados e descartados:**

- **Cloud API oficial Meta** — tentado primeiro, ban preventivo do chip.
  Memória persistente desse aprendizado em
  `[[feedback-meta-cloud-api-personal-use]]`.
- **BSP intermediário (Twilio/360dialog)** — viável mas adiciona ~US$1-2/mês
  de custo do canal, vendor lock-in, e overhead de setup BSP. Pra MVP
  single-user, Baileys ganha em simplicidade total.
- **Self-host em casa (RPi/mini-PC)** — descartado anteriormente (user
  prefere cloud); decisão mantida.
- **Múltiplos Apps Dokploy separados (bot, evolution, postgres, redis cada
  um seu app)** — viável mas mais cliques de UI e config split. Compose
  Stack ganha em ergonomia.

## 3. Arquitetura

```
                       Internet
                          │
                          ▼
       ┌─────────────────────────────────────────┐
       │  VPS Hetzner CPX11 (Ubuntu 24.04)       │
       │                                         │
       │  ┌──────────────────────────────────┐   │
       │  │  Traefik (TLS, Let's Encrypt)    │◄──┼── 80/443 público
       │  │  gerenciado pelo Dokploy         │   │
       │  └──┬────────────────────────┬──────┘   │
       │     │                        │          │
       │     ▼                        ▼          │
       │  ┌────────────┐         ┌──────────┐    │
       │  │ slice_bot  │         │ Dokploy  │    │
       │  │ Node 24    │         │ admin UI │    │
       │  │ Fastify    │         └──────────┘    │
       │  │ :3000      │                         │
       │  └─────┬──────┘                         │
       │        │ http://evolution-api:8080      │
       │        ▼                                │
       │  ┌─────────────────────┐                │
       │  │ slice_evolution     │◄─── webhook    │
       │  │ Baileys + Evolution │     POST       │
       │  │ :8080 (interno)     │     /webhooks/ │
       │  └──┬──────────┬───────┘     whatsapp   │
       │     │          │                        │
       │     ▼          ▼                        │
       │  ┌──────┐  ┌────────┐                   │
       │  │redis │  │postgres│                   │
       │  └──────┘  └────────┘                   │
       │                                         │
       │  slice_bot_data (volume) ───┐           │
       │  evolution_instances        │ persistem │
       │  evolution_postgres         │ entre     │
       │  evolution_redis            │ deploys   │
       │                             ┘           │
       └───────────┬──────────┬──────────┬───────┘
                   │          │          │
                   ▼          ▼          ▼
            graph WhatsApp  Gemini   mcp.cumbuca.com
            (via Baileys —  (LLM     (Open Finance)
             pareado com    extract)
             chip Vivo)
```

### 3.1 Estado atual vs alvo

Diferenças vs main hoje:
- Hoje: tudo local (Evolution stack via `docker compose`, bot via `npm run dev`)
- Alvo: tudo em VPS via compose `--profile prod`

Diferenças vs path Cloud API (abandonado):
- Evolution+Postgres+Redis voltam como containers (não foram dropados)
- Sem `cloudapi.types.ts` / `cloudapi.client.ts` / `window.ts` / HMAC
- Sem env vars `WHATSAPP_*`
- Webhook Evolution shape preservado (não Meta shape)

### 3.2 Componentes preservados/cherry-picked do PR #3

- `services/cumbuca/cumbuca.pending-pairing.ts` (criado) — CRUD do pending OAuth state em disco
- `routes/cumbuca.oauth.ts` (refactored) — file-based, vive no servidor principal
- `bin/cumbuca-link.ts` (refactored) — não sobe Fastify próprio, escreve pending file + poll
- `server.ts` — registra OAuth + `/healthz`
- `Dockerfile` + `.dockerignore` — Node 24-alpine
- `package.json` — tsx promovido pra dependencies
- `docker-compose.yml` — refatorado pra cloud-first com profile
- `docker-compose.override.yml` — exposição local-only da porta 8080
- `PUBLIC_BASE_URL` env var
- Runbook VPS+Dokploy (com ajustes pra compose stack)

### 3.3 Componentes deletados

- Nenhum código TS — diferente do path Cloud API, esse não substitui o
  módulo WhatsApp. `services/whatsapp/whatsapp.ts` e
  `routes/whatsapp.webhook.ts` ficam como estão hoje no main.

## 4. Mudanças no servidor (já implementadas via cherry-pick)

### 4.1 Rota OAuth Cumbuca vive no main server

Antes: `cumbuca.oauth.ts` exportava callbacks in-memory consumidos só pelo
`bin/cumbuca-link.ts` (que subia seu próprio Fastify). Por isso a rota
**não** era registrada em `server.ts`.

Agora: rota usa `data/cumbuca-pending-pairing.json` como ponte. CLI escreve;
servidor lê no callback, valida state + TTL, troca code por tokens. Detalhes
em `cumbuca.pending-pairing.ts` (CRUD com TTL de 10min anti-CSRF) e nas
mudanças em `cumbuca.oauth.ts`.

### 4.2 `/healthz` endpoint

`GET /healthz` retorna `{ ok, ts }`. Pra uptime monitoring externo
(UptimeRobot a cada 5min) e debug rápido.

### 4.3 Sem rawBody parser

(Diferente do path Cloud API: lá precisávamos preservar raw body pra HMAC
do Meta. Aqui Evolution não assina, então parser default do Fastify serve.)

## 5. Stack docker-compose (já implementada)

### 5.1 Cloud (com `--profile prod`)

Stack completa: bot + evolution-api + postgres + redis. Bot expõe :3000
internamente; Traefik (Dokploy) roteia `https://bot.appslice.com.br` →
`bot:3000`. Evolution só na rede docker (sem ports no host). Volumes
persistentes pra `data/` do bot, sessions Baileys, dados Postgres e Redis.

### 5.2 Local dev (sem profile)

`docker compose up -d` sobe Evolution+Postgres+Redis (override file expõe
:8080 no host). Bot continua rodando via `npm run dev` na host com tsx
watch — mantém a velocidade de iteração que o user já está acostumado.

### 5.3 Vars de ambiente

Tudo via UI Dokploy em produção. Lista:
- `PUBLIC_BASE_URL=https://bot.appslice.com.br`
- `USER_WHATSAPP_NUMBER`
- `GEMINI_API_KEY`
- `PIX_KEY`, `PIX_MERCHANT_NAME`, `PIX_MERCHANT_CITY`
- `LEDGER_SOURCE=cumbuca`
- `EVOLUTION_API_KEY=<random>` (compose injeta no evolution AND no bot)
- `EVOLUTION_INSTANCE=slice`
- `POSTGRES_PASSWORD=<random>`

Bot não precisa de `EVOLUTION_API_URL` setada via UI — está hardcoded no
compose como `http://evolution-api:8080`.

## 6. Hosting + HTTPS

Idêntico ao spec anterior (que foi cherry-picked):

- VPS Hetzner CPX11 €4,50/mês
- Ubuntu 24.04, hardening (user não-root, SSH só chave, UFW 22/80/443)
- Dokploy via installer oficial
- Dokploy admin atrás de `dokploy.appslice.com.br` (Traefik), porta 3000
  fechada no host após setup
- DNS no Registro.br: A `bot` + A `dokploy` apontando pro IP do VPS

Runbook completo em `docs/superpowers/runbooks/2026-05-23-vps-setup.md`.

## 7. Pareamento (manual, após deploy)

### 7.1 WhatsApp (Evolution + chip Vivo novo)

Comprar chip novo amanhã. Não registrar previamente em WhatsApp consumer
(deixar pra parear via Evolution já). Sequência:

1. Subir compose stack no Dokploy
2. SSH no VPS → `docker exec slice_evolution sh -c 'curl ...'` (criar
   instância + setar webhook apontando pra `http://bot:3000/webhooks/whatsapp`
   + gerar pairing code)
3. WhatsApp no celular → Aparelhos conectados → Conectar com número →
   código

Detalhes no runbook §7.

### 7.2 Cumbuca (re-pareamento — redirect URI mudou)

```bash
docker exec -it slice_bot npm run cumbuca:link
```

Imprime URL de authorize. Abrir no celular/notebook → consentir no app do
banco → callback fecha sozinho no servidor → CLI sai com tokens persistidos.

## 8. Operations runbook (resumo)

Tudo via UI Dokploy:
- Deploy: git push em main → auto-deploy do compose stack
- Logs: UI → service → Logs (live stream + histórico)
- Env vars: UI → service → Environment
- Backups: UI → Backups → schedule diário dos volumes
- Restart: UI → Redeploy

Quando algo dá errado:
- Bot crashloop: ver logs, geralmente env var faltando
- Evolution desconecta WhatsApp (ban / token expirado): re-parear com chip
  novo (se ban) ou re-gerar pairing code
- Cumbuca disconnect: re-rodar `cumbuca:link` no container do bot

Health check externo: UptimeRobot free pingando `https://bot.appslice.com.br/healthz`.

## 9. Out of scope / follow-ups

- Rename `racha-conta-bot` → `slice` em package.json e branch names
- Deferidos #3 e #4 do review do Cumbuca (pausar scanner em disconnect;
  retry/backoff)
- Migração pra SQLite
- Comandos admin via WhatsApp (`/listar`, `/cancelar`, `/status`)
- Landing page em `appslice.com.br` (apex livre)
- CI/CD via GitHub Actions (lint + typecheck antes do auto-deploy)
- Monitoring sofisticado (Prometheus, Grafana) — UptimeRobot + UI Dokploy
  suficiente pro MVP
