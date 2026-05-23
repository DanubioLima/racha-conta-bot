# Slice — Cloud Deployment Design

**Status:** approved (design phase) — implementation pending
**Date:** 2026-05-23
**Author:** Danubio + Claude (brainstorm)
**Replaces:** stack local (Evolution API + Postgres + Redis pareados via Baileys com número principal)

---

## 1. Contexto e motivação

Hoje o bot Racha-Conta (a partir desta migração rebrandeado para **Slice**)
roda exclusivamente na máquina pessoal do user via `docker compose`, pareado
ao WhatsApp principal dele via Evolution API + Baileys. Isso traz dois
limitadores cruciais pra ele querer usar o bot de fato no dia a dia:

1. **Não roda 24/7** — depende da máquina estar ligada, com Docker subido,
   stack pareada. Qualquer reboot/desligamento derruba o bot.
2. **Risco de ban** — Baileys viola ToS do WhatsApp; Meta persegue ativamente
   e bane sem aviso. Como hoje o bot está pareado com o número *principal*
   do user, um ban tomaria a conta WhatsApp dele inteira.

Esta migração ataca os dois problemas simultaneamente:

- Move a stack pra **VPS na Hetzner** (Cloud), com Dokploy gerenciando deploys
- Substitui **Evolution+Baileys** pela **WhatsApp Cloud API oficial** (Meta-hosted)
- Pareia o canal com o **chip Vivo secundário** que o user já possui (não no WhatsApp ainda)

## 2. Approach escolhido

**A. Hetzner CPX11 + Dokploy + WhatsApp Cloud API**

Stack final do servidor:
- VPS Hetzner CPX11 (2 vCPU AMD, 2GB RAM, 40GB SSD, ~€4,50/mês)
- Dokploy gerencia containers, TLS (Traefik+Let's Encrypt), env vars, backups, logs
- Bot Node 24 (Fastify) num container, deploy via git push em `main`
- Domínio `appslice.com.br` (já registrado no nome do user) com subdomínio `bot.appslice.com.br`
- WhatsApp Cloud API (API REST do Meta + webhook entrante)
- Cumbuca MCP **preservado integralmente** — único ajuste é re-pareamento com novo redirect URI

**Considerados e descartados:**

- **Self-host em casa (RPi/mini-PC/PC velho)** — user explicitamente preferiu
  cloud sobre hardware doméstico. IP residencial reduziria o risco de ban no
  Baileys, mas como vamos abandonar Baileys de qualquer jeito, esse benefício
  some.
- **Manter Evolution+Baileys mesmo na cloud** — datacenter IP + Baileys
  combinam o pior cenário de ban (ToS violation + fingerprint suspeito). E
  custos do canal oficial são ~zero pro nosso volume.
- **Caddy+systemd manual em vez de Dokploy** — mais simples no setup
  inicial mas adiciona fricção crônica em deploys/observabilidade. Dokploy
  ganha pela UX de longo prazo.
- **WhatsApp Payments API (offsite PIX via PSP)** — daria botão nativo
  "copiar PIX" dentro da conversa, mas exigiria conta intermediária num PSP
  brasileiro (PagSeguro/MP/etc) com taxa por transação, e quebraria a
  reconciliação com Cumbuca/Open Finance que reconcilia *direto na conta do
  user*. Rejeitado.
- **Oracle Cloud Always Free** — 4 ARM cores + 24GB RAM grátis é tentador,
  mas (1) provisionamento "out of capacity" é frequente; (2) política do
  free tier pode mudar; (3) ARM exige cuidados extras na pipeline de
  build. CPX11 a R$25/mês compensa.

## 3. Arquitetura

```
                       Internet
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │  VPS Hetzner CPX11 (Ubuntu 24.04)   │
        │                                     │
        │  ┌──────────────────────────────┐   │
        │  │  Traefik (TLS, Let's Encrypt)│◄──┼── 80/443 público
        │  │  gerenciado pelo Dokploy     │   │
        │  └────────────┬─────────────────┘   │
        │               │                     │
        │      ┌────────┴────────┐            │
        │      ▼                 ▼            │
        │  ┌────────────────┐ ┌────────────┐  │
        │  │  Slice bot     │ │  Dokploy   │  │
        │  │  (Node 24)     │ │  admin UI  │  │
        │  │  Fastify :3000 │ │  :3000     │  │
        │  │                │ │  (interno) │  │
        │  │  Routes:       │ └────────────┘  │
        │  │  /webhooks/    │                 │
        │  │   whatsapp     │                 │
        │  │  /oauth/       │                 │
        │  │   cumbuca/cb   │                 │
        │  │  /healthz      │                 │
        │  └───┬────────┬───┘                 │
        │      │        │                     │
        │      ▼        ▼                     │
        │  data/ vol  .env vol                │
        │  - db.json    (Dokploy gerencia)    │
        │  - cumbuca-tokens.json              │
        │  - processed-transaction-ids.json   │
        │  - cumbuca-pending-pairing.json     │
        └───────┬──────────┬──────────┬───────┘
                │          │          │
                ▼          ▼          ▼
       graph.facebook  Gemini   mcp.cumbuca.com/mcp
       (Cloud API +    (LLM     (Open Finance)
        webhook)       extract)
```

### 3.1 Componentes preservados

- `services/cumbuca/*` — cliente MCP, DCR, OAuth, refresh
- `services/ledger/*` — interface + sources (mock + cumbuca)
- `services/bills/*` — lógica de bills, reconciliação
- `repositories/*` — bill repo + processed-transactions repo
- `workers/payment-scanner.worker.ts` — scanner adaptativo
- `services/pix/pix.ts` — geração de Copia-e-Cola PIX
- `bin/cumbuca-link.ts` — CLI de pareamento (com refactor — ver §5)

### 3.2 Componentes substituídos

| Antes | Depois |
|---|---|
| `services/whatsapp/whatsapp.ts` — implementação Evolution (`notifyUser`, `notifyUnknown`, `wasSentByBot`) | mesmo arquivo, **interface pública preservada**, internals reescritos pra Cloud API. Bill service e demais callers ficam imunes. |
| `routes/whatsapp.webhook.ts` (shape Evolution) | `routes/whatsapp.webhook.ts` (shape Meta + HMAC verify) |
| Evolution API container | (removido) — Meta hospeda |
| Postgres container | (removido) — não usávamos pra dados do bot, era só Evolution |
| Redis container | (removido) — idem |
| `routes/cumbuca.oauth.ts` registrada só no CLI | Registrada no `server.ts` principal (refactor — ver §5) |

### 3.3 Componentes novos

| Caminho | Responsabilidade |
|---|---|
| `services/whatsapp/cloudapi.client.ts` | Cliente REST do graph.facebook.com (Bearer token, send text, send template) |
| `services/whatsapp/cloudapi.types.ts` | Shapes do webhook do Meta + payloads outbound |
| `services/whatsapp/window.ts` | Persiste `last_inbound_at` por usuário; decide free-form vs template |
| `Dockerfile` (na raiz) | Imagem Node 24-alpine pro deploy via Dokploy |
| `Caddyfile`/Traefik config | Não necessário — Dokploy gerencia Traefik internamente |

## 4. WhatsApp Cloud API

### 4.1 Webhook entrante

**`GET /webhooks/whatsapp`** — verificação inicial. Meta envia query params
`hub.mode=subscribe`, `hub.verify_token=<token>`, `hub.challenge=<random>`.
Bot ecoa `hub.challenge` se `hub.verify_token === WHATSAPP_VERIFY_TOKEN`,
caso contrário 403.

**`POST /webhooks/whatsapp`** — entrega de mensagens. Body do Meta:

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "5588998082034",
          "id": "wamid.HBg...",
          "timestamp": "1779495412",
          "type": "text",
          "text": { "body": "Paguei 30 na pizza, divide com Maria" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

**Verificação HMAC obrigatória:** header `X-Hub-Signature-256: sha256=<hex>` =
`HMAC-SHA256(WHATSAPP_APP_SECRET, rawBody)`. Rejeita 401 se não bate. A
verificação deve usar comparação constant-time pra evitar timing attacks.

Cada POST pode trazer várias mensagens em batch. O handler itera, filtra por
`from === USER_WHATSAPP_NUMBER` (allowlist atual), normaliza o número, e
delega pro pipeline atual (Gemini → bill → reconciliação).

### 4.2 Outbound REST

`POST https://graph.facebook.com/v21.0/{WHATSAPP_PHONE_NUMBER_ID}/messages`
com header `Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}`.

**Mensagem livre** (dentro da janela 24h):
```json
{
  "messaging_product": "whatsapp",
  "to": "5588998082034",
  "type": "text",
  "text": { "body": "Anotei sua conta de R$ 30..." }
}
```

**Template** (fora da janela):
```json
{
  "messaging_product": "whatsapp",
  "to": "5588998082034",
  "type": "template",
  "template": {
    "name": "bill_partial_paid",
    "language": { "code": "pt_BR" },
    "components": [{
      "type": "body",
      "parameters": [
        {"type": "text", "text": "Maria"},
        {"type": "text", "text": "10,00"},
        {"type": "text", "text": "Pizza"},
        {"type": "text", "text": "João"}
      ]
    }]
  }
}
```

### 4.3 Janela 24h

Cada mensagem entrante do user reseta a janela (24h a partir do `timestamp`
da inbound). Dentro da janela, qualquer outbound é gratuito e livre-forma.
Fora dela, só templates pré-aprovados.

Implementação:
- `services/whatsapp/window.ts` persiste `last_inbound_at: ISO8601` por
  user em `data/whatsapp-window.json` (file leve, atualizado a cada
  inbound)
- Antes de enviar outbound, `isWindowOpen(userNumber)` checa se diff < 24h
- Se aberta → `sendText()`. Se fechada → `sendTemplate(name, args)`

Eventos do bot e quando precisam de template:

| Evento | Janela tipicamente | Solução |
|---|---|---|
| User manda bill → bot confirma e envia PIX | sim (acabou de mandar) | texto livre |
| Maria paga 1h depois → bot avisa | sim (provavelmente) | texto livre |
| Maria paga >24h depois → bot avisa | provavelmente não | template `bill_partial_paid` ou `bill_settled` |
| Bill expira em 7 dias → bot avisa | não | template `bill_expired` |

### 4.4 Templates pra submeter ao Meta (utility, pt_BR)

1. **`bill_partial_paid`** — quando 1 participante paga mas falta outro
   > `💸 {{1}} pagou R$ {{2}} da conta {{3}}. Ainda falta: {{4}}.`

2. **`bill_settled`** — quando todo mundo quitou
   > `💸 Fechou a conta {{1}}! Todo mundo já pagou.`

3. **`bill_expired`** — bill > 7 dias sem fechar
   > `⏱️ A conta {{1}} expirou após 7 dias. Pendentes: {{2}}.`

Aprovação leva minutos a horas. Plano B caso rejeitem: simplificar copy
(sem markdown/emoji), resubmeter.

### 4.5 UX do PIX preservada

A bubble do PIX continua sendo **texto livre** (`participant.pix_payload`),
igual à UX que mergeou no PR #2. WhatsApp Cloud API não tem botão nativo
de "copiar código" pra strings longas (limite de 15 chars existe só em
auth templates). O caminho Payments API + PSP foi descartado em §2.

## 5. Refactor da rota OAuth do Cumbuca

Hoje `bin/cumbuca-link.ts` sobe seu próprio Fastify na :3000 pra receber o
callback OAuth. Esse atalho fazia sentido em dev local (state in-memory
dentro do CLI), mas em produção significa parar o bot toda vez que precisa
re-parear — gotcha indesejado num servidor 24/7.

**Mudança:** a rota de callback passa a viver no servidor principal do bot.

### 5.1 CLI (`bin/cumbuca-link.ts`)

1. DCR — registra o cliente no Cumbuca com
   `redirect_uri=https://bot.appslice.com.br/oauth/cumbuca/callback`
2. Gera `state` (random) e `code_verifier` (PKCE)
3. Persiste pending pairing em `data/cumbuca-pending-pairing.json`:
   ```json
   {
     "state": "...",
     "client_id": "...",
     "client_secret": "...",
     "code_verifier": "...",
     "created_at": "ISO8601"
   }
   ```
4. Imprime authorize URL (abre browser quando possível)
5. Aguarda — polla `data/cumbuca-tokens.json` periodicamente até aparecer
   com tokens válidos pro `client_id` corrente
6. Loga ✅ e sai

### 5.2 Rota no `server.ts`

`src/routes/cumbuca.oauth.ts` é registrada via
`app.register(registerCumbucaOAuthRoutes)`. Handler `GET /oauth/cumbuca/callback`:

1. Lê `data/cumbuca-pending-pairing.json`. Se não existe → 409 ("nenhum
   pareamento ativo")
2. Valida `state` query param contra o do arquivo. Rejeita se não bate
3. Rejeita se `created_at` > 10min atrás (TTL anti-CSRF expirou)
4. Troca `code` por tokens via auth server (usa `code_verifier` armazenado)
5. Persiste `data/cumbuca-tokens.json` com os tokens novos
6. Apaga `data/cumbuca-pending-pairing.json`
7. Renderiza `text/plain` de sucesso

Permite re-parear sem downtime e remove o port-conflict gotcha.

## 6. Hosting + HTTPS + secrets

### 6.1 VPS Hetzner CPX11

- 2 vCPU AMD + 2GB RAM + 40GB SSD, ~€4,50/mês
- Ubuntu 24.04 LTS
- Datacenter EU (Falkenstein/Helsinki/Nuremberg) — latência ~150-200ms
  pra BR, irrelevante pra mensageria assíncrona
- Hardening: usuário não-root `slice`, SSH só via chave (sem senha), UFW
  com 22/80/443 abertos, fail2ban opcional

### 6.2 Dokploy

Instalado via o instalador oficial do Dokploy (one-liner shell na home page
deles; comando exato pego durante o setup pra evitar deriva). Sobe Docker
+ Traefik + Dokploy UI. UI inicialmente exposta em
`http://<ip>:3000`; primeiro passo é amarrá-la a um subdomínio próprio
(`dokploy.appslice.com.br`) via UI do Dokploy, e **fechar o host port
3000 no UFW** depois disso. Resultado:

- Bot público em `https://bot.appslice.com.br` (porta 443)
- Dokploy admin em `https://dokploy.appslice.com.br` (porta 443) com
  autenticação do Dokploy
- Nenhuma porta de aplicação exposta diretamente no host (só 443 via
  Traefik)

### 6.3 Domínio + DNS

Domínio `appslice.com.br` já registrado no Registro.br. Adicionar dois
registros A apontando pro IP do VPS:

- `bot.appslice.com.br` → `<IP>`
- `dokploy.appslice.com.br` → `<IP>`

Propagação ~30min. Apex `appslice.com.br` fica livre pra futura landing.

### 6.4 HTTPS

Traefik (incluído no Dokploy) provisiona certificados via Let's Encrypt
automaticamente quando você associa um domínio a um app na UI. Renovação
automática. Zero config explícito.

### 6.5 Env vars

Configuradas via UI do Dokploy (não em `.env` no FS pra evitar SSH manual):

| Variável | Origem | Notas |
|---|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Meta Business UI | ID do número do bot |
| `WHATSAPP_ACCESS_TOKEN` | Meta Business — System User token | Long-lived (sem expiração se System User Permanent) |
| `WHATSAPP_APP_SECRET` | Meta Business App settings | Pra verificar HMAC dos webhooks |
| `WHATSAPP_VERIFY_TOKEN` | random gerado por você | Ecoado no GET de verificação |
| `USER_WHATSAPP_NUMBER` | seu número principal | Allowlist do sender |
| `GEMINI_API_KEY` | Google AI Studio | Inalterado |
| `LEDGER_SOURCE` | `cumbuca` | Inalterado |
| `EVOLUTION_*` | (removidas) | Stack Evolution morreu |

Backup dos secrets fora do servidor: 1Password ou Bitwarden. Perda do
`WHATSAPP_ACCESS_TOKEN` exige regerar no Meta — custo só de tempo.

## 7. Migration plan

### 7.1 Estratégia: big-bang com rollback git

Branch `feat/cloud-deployment` (esta) carrega:
1. Esta spec
2. Implementação Cloud API (nova rota webhook, novo cliente)
3. Refactor da rota OAuth Cumbuca
4. `Dockerfile`
5. Limpeza de código Evolution-específico

Sequência:

1. **Setup Meta primeiro** (fora do código) — Business Manager, App,
   registro do chip Vivo no Cloud API, templates submetidos, tokens
   obtidos. Documentado em `docs/superpowers/specs/meta-setup-runbook.md`
   (artefato separado, escrito durante a implementação)
2. **Implementação local com tunnel** — `cloudflared tunnel` apontando
   pra `localhost:3000` permite o Meta entregar webhooks na sua máquina
   pra testes antes de provisionar VPS
3. **Provisionar VPS** Hetzner + instalar Dokploy + configurar dois
   subdomínios
4. **Deploy via Dokploy** — conectar repo, configurar env vars, primeiro
   deploy
5. **Re-pareamento Cumbuca** no servidor (`docker exec npm run cumbuca:link`)
6. **Smoke ponta-a-ponta** — você manda bill pro chip Vivo, bot reage,
   Maria paga em PIX real, scanner reconcilia, notificação chega
7. **Merge → main** depois do smoke verde

Rollback: se o smoke remoto falhar, branch antiga continua em `main` com
stack Baileys local funcionando. Não destrutivo.

### 7.2 Migração de dados

`data/` na sua máquina hoje contém:
- `db.json` — bills (no momento provavelmente vazio ou com bills
  antigas/expiradas)
- `cumbuca-tokens.json` — tokens do Cumbuca (vão ser invalidados pelo
  re-pareamento)
- `processed-transaction-ids.json` — IDs de tx já reconciliadas

E vai ganhar mais um arquivo durante a implementação (citado em §4.3 e §5.1):
- `whatsapp-window.json` — `last_inbound_at` por user, decide free-form vs template
- `cumbuca-pending-pairing.json` — efêmero, só existe durante o flow OAuth

Recomendo começar com `data/` vazio no servidor — re-pareamento gera
tokens novos do zero, e bills antigas locais não tem valor de migrar.

### 7.3 Limpeza do chip Vivo

O chip Vivo secundário do user **não pode estar registrado no WhatsApp
consumer ou WhatsApp Business app** quando for cadastrado no Cloud API.
Se já estiver registrado em algum desses, fazer logout antes. Cadastro no
Cloud API: número → SMS/voz de OTP → confirmado no Meta Business.

### 7.4 Cumbuca

Tokens antigos do Cumbuca (locais) **não migram**. Re-pareamento via CLI
no servidor gera novos client credentials via DCR (já que o redirect URI
muda), e tokens novos. Cumbuca não tem registry persistente das
credenciais antigas — não há limpeza necessária do lado de lá.

## 8. Operations runbook

### 8.1 Deploy recorrente

```bash
git push origin main
```

Dokploy detecta via webhook do GitHub, puxa, builda, derruba container
antigo e sobe novo. ~30s. Logs do build visíveis na UI.

Manual via UI: botão "Redeploy" sem precisar de commit novo.

### 8.2 Logs

- Bot: UI Dokploy → app → Logs (stream live + histórico filtrado)
- Traefik (HTTPS access/errors): UI Dokploy → System → Traefik logs
- Acesso SSH ainda funciona: `docker logs slice-bot -f`

### 8.3 Health check

Adicionar `GET /healthz` no Fastify retornando
`200 {ok: true, scanner: 'running'|'idle'}`. Externamente: UptimeRobot
(free tier, 50 endpoints) pingando `https://bot.appslice.com.br/healthz`
a cada 5min com alerta por email se falhar.

### 8.4 Backups

UI Dokploy → app → Backups → schedule diário do volume `data/` + dump
das env vars. Storage: local + S3-compat externo (Backblaze B2 ou
Cloudflare R2, ambos com free tier). Retenção: 14 dias rotativos.

Restore: UI → escolhe snapshot → apply. ~1min.

### 8.5 Re-pareamento Cumbuca

```bash
ssh slice@bot.appslice.com.br
docker exec -it $(docker ps -qf "name=slice") npm run cumbuca:link
# OU via UI Dokploy → app → Terminal → mesmo comando (sem precisar adivinhar o container name)
```

Nome do container é definido pelo Dokploy e pode variar; o `docker ps -qf`
acima resolve sem precisar memorizar.

Bot continua up durante o flow. Tokens novos em `data/cumbuca-tokens.json`
após o callback.

### 8.6 Quando algo dá errado

- **Bot em crashloop:** UI Dokploy → Logs. Restart automático. Crashes
  recorrentes típicos: env var faltando, token expirado, dep com problema.
- **Build falhou:** UI → Build Logs. Dockerfile errado, dep com
  conflito, etc.
- **Dokploy em pane:** bot continua up (Docker normal). Pode reiniciar
  via SSH com `docker restart slice-bot`. Update Dokploy via
  `dokploy upgrade` ou re-rodar o installer.
- **VPS perdido:** novo VPS, instalar Dokploy, restaurar backup do volume
  `data/`, atualizar DNS pro novo IP. RTO ~30min.
- **WhatsApp token expirado:** regerar no Meta Business, atualizar env
  var via UI Dokploy, redeploy.
- **Webhook do Meta retorna 401/403:** 401 indica HMAC errado
  (`WHATSAPP_APP_SECRET` divergente); 403 no GET indica
  `WHATSAPP_VERIFY_TOKEN` errado.

### 8.7 Updates de sistema

- **Bot:** git push → auto-deploy
- **Dokploy:** UI → System → Update (ou re-rodar o installer)
- **OS:** `unattended-upgrades` automatiza patches de segurança Ubuntu

## 9. Out of scope / follow-ups

Não fazem parte desta migração; ficam pro roadmap:

- **Rename do código** (`racha-conta-bot` → `slice` em `package.json`,
  branch names, etc) — user explicitamente disse pra deixar pra depois
- **Deferidos #3 e #4 do review do Cumbuca** (pausar scanner em
  disconnect; retry/backoff + 429) — independentes do deploy
- **Migração pra SQLite** (substituir JSON files) — independente
- **Comandos administrativos via WhatsApp** (`/listar`, `/cancelar`,
  `/status`)
- **Multi-user** — fora de escopo MVP
- **Landing page em `appslice.com.br`** — depois, sem urgência
- **Monitoring mais sofisticado** (Prometheus, Grafana) — UptimeRobot +
  Dokploy UI já cobrem o MVP
- **CI/CD via GitHub Actions** (lint + typecheck antes do auto-deploy do
  Dokploy) — vale a pena adicionar logo após o deploy estabilizar
