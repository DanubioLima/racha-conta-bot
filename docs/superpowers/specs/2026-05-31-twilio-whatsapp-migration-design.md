# Slice — Migração Evolution/Baileys → Twilio WhatsApp API

**Status:** approved (design) — implementation pending
**Date:** 2026-05-31
**Author:** Danubio + Claude (brainstorm)
**Substitui:** o provider de WhatsApp atual (Evolution API + Baileys), mantido só como fallback de infra durante o cutover

---

## 1. Contexto e problema

O provider atual (Evolution + Baileys, WhatsApp Web não-oficial) **desconecta sozinho**.
Log de prod (2026-05-30) fechou o diagnóstico:

```
reasonNode: { tag: "conflict", attrs: { type: "device_removed" } }
stream:error code: 401  →  Instance "slice" - LOGOUT
```

`device_removed` recorrente, disparado **quando um contato externo real** (a mãe do
Danubio, via `click_to_chat_link`) escreveu — é a assinatura de anti-automação do
WhatsApp **removendo o cliente não-oficial**. O celular primário está online (causa
benigna descartada). Baileys/Evolution **pode ser endurecido, mas não tornado
confiável** — é não-oficial e o WhatsApp combate ativamente. O instável aparece justo
quando mais gente usa (o pior momento pra validação).

**Decisão:** migrar pro provider oficial via **Twilio** (BSP). Custo ~US$1/mês a 2-3
users (o Slice é 100% reativo → só manda texto livre dentro da janela de 24h → as
mensagens são grátis pela Meta; paga-se só a taxa de plataforma do Twilio de
US$0,005/msg). Resolve a instabilidade na raiz.

Cloud-API-direta (R$0) foi considerada e preterida: o que derrubou o PR #3 foi o
onboarding cru da Meta (BM não-verificado); o Twilio guia esse passo por ~US$1/mês.

## 2. Escopo

**Faz parte (troca só a borda de provider):**
1. **Receber** via webhook do Twilio (`whatsapp.webhook.ts`).
2. **Enviar** via SDK oficial do Twilio (`whatsapp.ts`).
3. Config (`env.ts`, `.env.example`) e o helper de telefone pro endereço E.164.
4. Testes da nova borda.

**Não faz parte:**
- **`docker-compose.yml` NÃO é tocado** — Evolution/Postgres/Redis ficam de pé como
  fallback durante a transição. A injeção dos `TWILIO_*` no bot de prod é passo do
  cutover (env do Dokploy), não edição de compose. Rollback = reverter a branch (os
  containers Evolution continuam no ar).
- Sem **toggle de runtime** Evolution↔Twilio (não pedido; YAGNI).
- Remover código morto da Cumbuca (PR separado já mapeado), rename
  `racha-conta-bot`→`slice`, badge verificado pago, abstração de provider.

## 3. O miolo não encosta

Tudo a jusante de `dispatchIncomingMessage(senderPhone, text)` — Gemini, SQLite,
`voice`, bills, histórico — é **agnóstico de provider** e fica intocado. A migração é
contida aos dois arquivos finos da borda + config.

**Identidade interna preservada:** `normalizeBrNumber` faz `replace(/\D/g)` + dropa o
nono dígito, então `whatsapp:+5588994963067` → `558894963067` = a mesma chave já no
SQLite. **Usuários existentes continuam casando, sem migração de dados.**

## 4. Mudanças por componente

### 4.1 `env.ts` + `.env.example`
- Remove do `required`: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`.
- Adiciona ao `required`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
  (= `whatsapp:+5588994963067`).
- `env` exporta `twilioAccountSid`, `twilioAuthToken`, `twilioWhatsAppFrom`.
- `USER_WHATSAPP_NUMBER`, `PIX_*`, `GEMINI_API_KEY`, `LEDGER_SOURCE` ficam.
- `.env.example` documenta os novos vars e remove os de Evolution.

### 4.2 `phone.ts` — helper de endereço
Novo `toBrazilWhatsAppAddress(normalized: string): string`: re-insere o nono dígito
(inverso de `normalizeBrNumber`) e prefixa `whatsapp:+`. Ex: `558894963067` →
`whatsapp:+5588994963067`. BR-only por design (o app inteiro é BR). Comentário explica
o porquê do 9. Edge nº raro sem 9 é ignorado conscientemente.

### 4.3 `whatsapp.ts` — enviar via SDK Twilio
- Substitui o cliente axios/Evolution pelo SDK oficial `twilio`
  (`twilio(accountSid, authToken)`).
- `sendText(to, text)`: **mantém a assinatura** (dispatch não muda). Internamente:
  `client.messages.create({ from: env.twilioWhatsAppFrom, to: toBrazilWhatsAppAddress(to), body: text })`.
- `sendImage` fica como stub/no-op ou é removido — a UX é só texto (PR #2) e nada o
  chama no caminho atual. Decisão de implementação: removê-lo se não houver caller.
- **Redação de PIX no log mantida** (`logPreview`).

### 4.4 `whatsapp.webhook.ts` — receber do Twilio
- Twilio manda `application/x-www-form-urlencoded` (não JSON) → registra
  **`@fastify/formbody`** no `server.ts`.
- `extractSender`: do campo `From` (`whatsapp:+55...`); `normalizeBrNumber` limpa o
  `whatsapp:+` e o 9 (já tira `\D`).
- `extractText`: do campo `Body`.
- **Remove o filtro `fromMe`** — quirk do Baileys; o Twilio só entrega mensagem de
  entrada, nunca o eco do próprio bot.
- **Validação de assinatura `X-Twilio-Signature`** (novo, crítico): o webhook agora é
  **público** e dispara fluxo de dinheiro. Usa `twilio.validateRequest(authToken,
  signature, fullUrl, params)`. Assinatura inválida → `403` e ignora. Reconstrói a URL
  pública honrando `x-forwarded-proto`/`host` (atrás do Traefik do Dokploy).
- Mantém: responde `200` cedo e roda `dispatchIncomingMessage` em background.

### 4.5 `server.ts`
- Registra `@fastify/formbody` antes das rotas.
- Resto inalterado (healthz, cumbuca oauth e payment-scanner dormentes ficam).

### 4.6 Dependências
- `+ twilio` (SDK oficial), `+ @fastify/formbody`.
- `- axios` **só se** nenhum outro módulo usar (a Cumbuca/cliente MCP pode usar —
  checar antes de remover; default: manter axios).

## 5. Testes (escopados à borda + dinheiro, conforme a política)

Os testes de integração de dinheiro/conversa **continuam passando** sem mudança
(stubam `sendText`/`extractIntent`; o seam `dispatchIncomingMessage` é agnóstico).

**Novos:**
- **Parser do webhook (Twilio):** corpo urlencoded com `From=whatsapp:+5588994963067` &
  `Body=...` → `dispatchIncomingMessage` chamado com sender normalizado (`558894963067`)
  e texto certo. Sem `From`/`Body` → `200` ignorado.
- **Assinatura:** request sem/`X-Twilio-Signature` errada → `403`, dispatch NÃO roda;
  assinatura válida → processa.
- **`toBrazilWhatsAppAddress`:** round-trip com `normalizeBrNumber`
  (`5588994963067` → normaliza → denormaliza → `whatsapp:+5588994963067`).

**Smoke (Danubio, ao vivo):** mensagem real ponta-a-ponta pelo número migrado;
recebimento, resposta, e estabilidade (não cai mais com `device_removed`). CI não cobre
a entrega real nem o pareamento.

## 6. Cutover operacional ⚠️ (runbook, não código — porta de mão única)

Ordem segura, executada pelo Danubio:
1. Criar conta Twilio + WABA via **embedded signup** (Meta) no console Twilio.
2. **Migrar o `5588994963067`:** apagar a conta WhatsApp consumer/Business desse chip →
   registrar como Twilio WhatsApp sender → verificar pelo código recebido no chip.
   **Depois disso o número não volta a ser WhatsApp comum.**
3. Verificação Meta Business com o **CNPJ** (58.450.899/0001-24) — pode vir depois;
   começa no tier não-verificado (~250 conversas/24h, sobra pra 2-3 users) e verifica
   pra ganhar display name "Slice" + limites maiores.
4. Apontar o webhook do número no console Twilio → `https://bot.appslice.com.br/webhooks/whatsapp`.
5. Setar `TWILIO_*` no env do bot (Dokploy) e fazer deploy da branch.
6. Confirmar smoke. Só então (em PR futuro) desligar a stack Evolution.

Os links da landing (`wa.me/558894963067`) usam esse número → **migrar mantém as CTAs
válidas**; nada na landing muda.

## 7. Guardrails / riscos

- **Webhook público + dinheiro** → a validação de assinatura do Twilio é obrigatória
  (sem ela, qualquer um forja mensagem). É o guarda-corpo de segurança da migração.
- **URL atrás do Traefik:** a assinatura é sobre a URL *pública* — reconstruir errado
  (http vs https, host interno) invalida assinaturas legítimas. Honrar
  `x-forwarded-proto`/`x-forwarded-host`. Testável com a URL stubada.
- **Quirk do nono dígito na saída:** enviar pro E.164 errado = mensagem não entregue.
  `toBrazilWhatsAppAddress` + round-trip test cobrem o caminho comum.
- **Número é porta de mão única:** migrar tira o chip do WhatsApp consumer. Aceito
  (já é chip dedicado de bot).
- **Dev local muda:** sem stack Evolution; `npm run dev` + túnel (Twilio CLI /
  cloudflared) apontando o webhook do número de teste pro `localhost:3000`. Documentar.

## 8. Arquivos

`src/config/env.ts`, `.env.example`, `src/lib/phone.ts`, `src/services/whatsapp/whatsapp.ts`,
`src/routes/whatsapp.webhook.ts`, `src/server.ts`, `package.json` (deps); testes novos
da borda do webhook + `phone`. **`docker-compose.yml` intocado.**
