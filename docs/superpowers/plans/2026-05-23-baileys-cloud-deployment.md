# Slice Baileys Cloud Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans pra tasks operacionais (deploy, smoke). Maioria deste plano é human-driven (provisioning, pairing, smoke); só Task 1 é code-side.

**Goal:** Subir o Slice 24/7 num VPS Hetzner via Dokploy compose stack (bot + Evolution + Postgres + Redis), pareado a um chip Vivo novo via Baileys, com Cumbuca preservado.

**Architecture:** ver `docs/superpowers/specs/2026-05-23-slice-baileys-deployment-design.md`.

**Tech Stack:** Node 24, TypeScript, Fastify, axios, @modelcontextprotocol/sdk, Evolution API (Baileys), Postgres 15, Redis 7, Hetzner CPX11, Dokploy, Traefik.

**Project convention:** Sem testes automatizados — checkpoints via `npx tsc --noEmit` + git commit nas tasks code-side, validação manual nas operacionais.

---

## Estado atual da branch `feat/baileys-cloud-deployment`

Já commitado nesta branch (cherry-picks + adaptações):
- `cfd6156` PUBLIC_BASE_URL env var
- `f7e125b` Cumbuca OAuth refactor (file-based pending pairing) [cherry-pick]
- `44c2264` cumbuca-link CLI refactor (sem Fastify próprio) [cherry-pick]
- `5ac137e` server.ts: registra OAuth + /healthz
- `cd73eee` Dockerfile + .dockerignore + tsx em deps
- `17b8194` docker-compose refactor (cloud-first com profile prod) + override pra dev
- `db5849e` runbook VPS+Dokploy [cherry-pick]
- `0f9865d` runbook adaptado pra compose stack Baileys
- `aec8e14` spec do path Baileys

Restante são as tasks abaixo — quase tudo manual/operacional.

---

## Task 1: Validar compose stack subindo localmente com `--profile prod`

Antes de gastar dinheiro com VPS + chip, valida que o stack em modo prod
sobe limpo na sua máquina. Não precisa de chip nem de domínio ainda.

**Files:** (nenhum — só validação)

- [ ] **Step 1: Subir tudo com profile prod**

```bash
# Garante que dev compose não está rodando
docker compose down 2>/dev/null

# Sobe stack completa com profile prod (igual cloud)
PUBLIC_BASE_URL=http://localhost:3000 \
USER_WHATSAPP_NUMBER=5588998082034 \
GEMINI_API_KEY=$(grep ^GEMINI_API_KEY .env | cut -d= -f2) \
PIX_KEY=$(grep ^PIX_KEY .env | cut -d= -f2) \
PIX_MERCHANT_NAME=$(grep ^PIX_MERCHANT_NAME .env | cut -d= -f2) \
PIX_MERCHANT_CITY=$(grep ^PIX_MERCHANT_CITY .env | cut -d= -f2) \
EVOLUTION_API_KEY=test-local \
EVOLUTION_INSTANCE=slice \
POSTGRES_PASSWORD=test-local \
docker compose --profile prod up -d --build
```

Expected: `slice_postgres`, `slice_redis`, `slice_evolution`, `slice_bot`
todos com status `Up`/`healthy`. O build da imagem do bot acontece na
primeira execução (cached depois).

- [ ] **Step 2: Verificar healthz do bot**

Como o profile prod não expõe a porta 3000 do bot publicamente, precisa
entrar via docker:

```bash
docker exec slice_bot wget -qO- http://localhost:3000/healthz
```

Expected: `{"ok":true,"ts":"..."}`. Se falhar (env var faltando, etc), o
container vai estar em restarting — checar logs:

```bash
docker logs slice_bot --tail 30
```

- [ ] **Step 3: Validar que o bot enxerga o Evolution**

```bash
docker exec slice_bot wget -qO- http://evolution-api:8080
```

Expected: HTML/JSON do Evolution (status quem-sabe-o-quê, mas algo
responde). Se "name resolution failed", as networks estão erradas.

- [ ] **Step 4: Derrubar a stack**

```bash
docker compose --profile prod down
```

(Volumes nomeados sobrevivem — pra limpar bem: `down -v`. Cuidado pra
não apagar dados de dev real se você tiver.)

- [ ] **Step 5: Commit (sem código, mas vale registro)**

Se algum ajuste foi necessário no compose pra subir limpo, commita.
Caso contrário, pular este step.

---

## Task 2 (HUMAN): Comprar chip novo

Pré-requisito de todas as próximas tasks. Lojas abrem amanhã. Recomendado
manter Vivo (mesma operadora) pra evitar surpresas, mas qualquer pré-pago
nacional serve.

**Importante:** NÃO registrar o chip em WhatsApp consumer antes — vamos
parear direto via Evolution Baileys.

- [ ] Comprar chip pré-pago
- [ ] Ativar a linha (chamada teste, recarga inicial)
- [ ] Inserir num celular pra receber SMS de pairing

---

## Task 3 (HUMAN): Provisionar VPS Hetzner + Dokploy

Seguir o runbook completo em
`docs/superpowers/runbooks/2026-05-23-vps-setup.md`, seções 1-5:

- [ ] Hetzner Console → projeto + server CPX11 + SSH key + firewall
- [ ] DNS Registro.br: A `bot.appslice.com.br` + A `dokploy.appslice.com.br`
- [ ] Hardening: user `slice`, SSH só chave, UFW 22/80/443
- [ ] Instalar Dokploy via instalador oficial
- [ ] Amarrar Dokploy admin em `dokploy.appslice.com.br` com TLS Let's Encrypt
- [ ] Fechar porta 3000 no UFW

**Dica:** tudo isso pode ser feito **hoje à noite ainda**, antes do chip
chegar. Não depende do chip pra subir VPS.

---

## Task 4 (HUMAN): Mergear `feat/baileys-cloud-deployment` → main

Quando aprovar o PR (vou abrir após push), mergeia. Dokploy vai detectar
o webhook GitHub assim que o app/compose-stack for criado (Task 5).

- [ ] Revisar o PR no GitHub
- [ ] Merge → main

---

## Task 5 (HUMAN): Criar Compose Stack no Dokploy

Seguir o runbook em `docs/superpowers/runbooks/2026-05-23-vps-setup.md`
seção 6:

- [ ] UI Dokploy → New Project "slice" → Add Compose
- [ ] Source: GitHub `DanubioLima/racha-conta-bot`, branch `main`,
      compose path `docker-compose.yml`
- [ ] Compose profile: `prod`
- [ ] Project name: `slice`
- [ ] Environment: colar as 10+ vars listadas no runbook
- [ ] Domains: `bot` service → `bot.appslice.com.br` port 3000 + HTTPS
- [ ] Auto Deploy: on
- [ ] Save → click Deploy

Aguardar build + start. Logs visíveis na UI Dokploy. Esperar todos os 4
containers ficarem `running`.

- [ ] Validar healthz externo: `curl https://bot.appslice.com.br/healthz`
      retorna `{"ok":true,"ts":"..."}`

---

## Task 6 (HUMAN): Parear chip novo no Evolution

Runbook §7. Sequência:

- [ ] SSH no VPS
- [ ] `docker exec slice_evolution sh -c 'curl -s -X POST .../instance/create ...'`
      (cria instância "slice")
- [ ] `docker exec slice_evolution sh -c 'curl -s -X POST .../webhook/set/slice ...'`
      (webhook apontando pra `http://bot:3000/webhooks/whatsapp`)
- [ ] `docker exec slice_evolution sh -c 'curl -s ".../instance/connect/slice?number=<NOVO_CHIP>" ...'`
      → imprime pairing code
- [ ] Celular com chip novo: WhatsApp → Aparelhos conectados → Conectar com
      número → digita código → conectado
- [ ] Validar logs do `slice_evolution`: deve mostrar "Connected" pro
      número

---

## Task 7 (HUMAN): Re-parear Cumbuca

```bash
docker exec -it slice_bot npm run cumbuca:link
```

- [ ] CLI imprime authorize URL
- [ ] Abrir no celular ou notebook
- [ ] Consentir no app do banco (Nubank, no caso atual)
- [ ] Callback fecha sozinho no servidor (rota OAuth registrada no bot)
- [ ] CLI lista contas, escolhe a conta certa
- [ ] CLI sai com ✅ — tokens em `/app/data/cumbuca-tokens.json` (volume
      persistente)

---

## Task 8 (HUMAN): Smoke ponta-a-ponta

Do seu WhatsApp principal (5588998082034), mandar uma mensagem pro número
do chip novo:

```
Paguei 10 no almoço, divide com Maria, 10 cada
```

Esperado, em ordem:
- [ ] Evolution recebe MESSAGES_UPSERT, dispara webhook pro bot
- [ ] Bot loga `[webhook] event received` e `[webhook] processing user message`
- [ ] Gemini extrai bill, bot loga `[bill] createBill from extraction`
- [ ] Bot envia 2 mensagens de volta no seu WhatsApp:
  - Resumo ("Anotei sua conta de R$ 10 em 'almoço'...")
  - String PIX da Maria
- [ ] Maria paga R$ 10 via PIX real
- [ ] Scanner detecta no próximo tick (5-15min), loga `[scanner] credits returned: 1`
- [ ] Bot manda mensagem de bill fechada ("Fechou a conta de 'almoço'...")

Se tudo verde: smoke ✅. Slice tá em produção.

Se algo falha:
- HTTPS quebrado: ver Dokploy → Domains → cert status
- Webhook não chega: confere que webhook URL é `http://bot:3000/webhooks/whatsapp`
  (NÃO `host.docker.internal` em cloud)
- Bot crashloop: ver logs, geralmente env var faltando
- Cumbuca não reconcilia: ver `[cumbuca] list_account_transactions` nos
  logs do bot pra confirmar que está chamando, com janela correta de datas

---

## Self-review

Cobertura do spec novo:

| Spec section | Task que implementa |
|---|---|
| §2 Approach (Hetzner+Dokploy+compose) | Tasks 3, 5 |
| §3 Arquitetura | Já implementado via cherry-picks na branch |
| §4 Mudanças no servidor | Já implementado (commits 5ac137e, f7e125b, 44c2264) |
| §5 Stack compose | Já implementado (commits cd73eee, 17b8194); validado em Task 1 |
| §6 Hosting + HTTPS | Task 3 |
| §7.1 Pareamento WhatsApp | Task 6 |
| §7.2 Re-pareamento Cumbuca | Task 7 |
| §8 Operations (deploy, logs, etc) | Coberto pelo runbook + UI Dokploy |
| §9 Out of scope / follow-ups | Não implementado por design |

Lacunas conscientes: rename do projeto, deferidos #3/#4 do Cumbuca, SQLite,
comandos admin — todos out-of-scope per §9 do spec.

Sequencing realista: Task 1 esta noite (validação local); Tasks 3 e 4 (VPS
+ merge) esta noite também se o PR estiver pronto; Tasks 5-8 amanhã após o
chip chegar.
