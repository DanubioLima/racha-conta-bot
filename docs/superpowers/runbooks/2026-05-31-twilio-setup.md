# Runbook — Configurar o WhatsApp do Slice na Twilio

**Date:** 2026-05-31
**Contexto:** migração Evolution/Baileys → Twilio (ver
`docs/superpowers/specs/2026-05-31-twilio-whatsapp-migration-design.md`).
**Quem executa:** Danubio (o código já está pronto na branch `feat/twilio-whatsapp`;
o que falta é operação no console da Twilio + Meta).

Duas fases. **Faça a Fase A primeiro** — valida o bot inteiro sem migrar o número
nem depender de aprovação da Meta. Só depois a Fase B (cutover irreversível do chip).

---

## Fase A — Sandbox (teste rápido, reversível)

O Sandbox usa um número compartilhado da Twilio; confirma webhook + envio + validação
de assinatura ponta-a-ponta antes de tocar no chip.

1. **Criar conta:** https://www.twilio.com/try-twilio (trial basta pro Sandbox).
2. **Credenciais:** Console (home) → painel **Account Info** → copiar **Account SID**
   e **Auth Token** ("show"). São `TWILIO_ACCOUNT_SID` e `TWILIO_AUTH_TOKEN`.
3. **Abrir o Sandbox:** **Messaging → Try it out → Send a WhatsApp message**. Mostra o
   número `+1 415 523 8886` e um código `join <duas-palavras>`.
4. **Entrar:** do seu WhatsApp, mandar `join <as-duas-palavras>` pro `+1 415 523 8886`.
   Quem for testar (você, irmão) precisa mandar esse `join`; o Sandbox só fala com quem
   entrou, e a sessão expira em **3 dias** (reentrar com o `join` se parar de responder).
5. **Apontar o webhook:** aba **Sandbox settings** → campo **"When a message comes in"**
   → URL pública do bot, **HTTP POST**:
   - prod: `https://bot.appslice.com.br/webhooks/whatsapp`
   - dev local: URL do túnel (cloudflared/ngrok) + `/webhooks/whatsapp`
6. **Env do bot** (Dokploy em prod, ou `.env` local):
   ```
   TWILIO_ACCOUNT_SID=AC...                     (passo 2)
   TWILIO_AUTH_TOKEN=...                         (passo 2)
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886    ← número DO SANDBOX nesta fase
   ```
   Deploy/restart.
7. **Testar:** mandar "oi" pro número do Sandbox → o bot recebe, valida a assinatura e
   responde. ✅ Integração validada.

---

## Fase B — Número de produção (migrar o `5588994963067`) ⚠️ porta de mão única

Só depois que a Fase A funcionar.

1. **Upgrade da conta:** **Admin / Account billing → Upgrade** (sender real não roda em
   trial). Adicionar crédito (~US$20 dura meses a 2-3 users).
2. **Liberar o chip do WhatsApp consumer:** no celular, **apagar a conta WhatsApp** do
   `5588994963067` (Ajustes → Conta → Apagar minha conta) ou desvincular. O número não
   pode estar no WhatsApp comum/Business ao registrar, e o chip precisa **receber
   SMS/ligação** (Meta manda OTP de verificação de posse).
3. **Meta Business:** ter (ou criar no fluxo) um **Meta Business Portfolio** com acesso
   admin. Vincular o **CNPJ 58.450.899/0001-24** depois → ganha display name "Slice" +
   limites maiores.
4. **Criar o sender:** **Messaging → Senders → WhatsApp senders → Create new sender**
   (Self Sign-up). Abre o **embedded signup da Meta**:
   - selecionar/criar a **WABA** (uma conta Twilio = **uma** WABA — reusar essa se um dia
     adicionar outro número);
   - informar `+55 88 99496-3067`;
   - receber o **OTP** no chip (SMS/ligação) e confirmar;
   - definir **display name** ("Slice").
5. **Aguardar aprovação** do número/display name (minutos a algumas horas).
6. **Webhook do sender:** na config do **WhatsApp sender** (ou de um Messaging Service
   ligado a ele) → **"When a message comes in"** → `https://bot.appslice.com.br/webhooks/whatsapp`,
   **HTTP POST**.
7. **Trocar o env pro número real:**
   ```
   TWILIO_WHATSAPP_FROM=whatsapp:+558894963067
   ```
   ⚠️ **SEM o nono dígito** — o canal é endereçado pelo **wa_id** (que no BR roteia sem
   o 9), não pelo E.164 digitado no registro. Com o 9 o envio falha com **63007**
   "could not find a Channel with the specified From address". Fonte da verdade pro
   endereço exato: campo **To** de qualquer mensagem inbound em **Monitor → Logs →
   Messaging**. (SID e Auth Token iguais.) Deploy.
8. **Smoke real:** mensagem pro `5588994963067` de outro celular → bot responde, não cai
   mais. As CTAs `wa.me/558894963067` da landing seguem válidas.

---

## Onde cada valor vai parar no bot

| Env var | De onde tirar |
|---|---|
| `TWILIO_ACCOUNT_SID` | Account Info (começa com `AC`) — não é segredo |
| `TWILIO_AUTH_TOKEN` | Account Info ("show") — **segredo**, só no Dokploy/.env |
| `TWILIO_WHATSAPP_FROM` | Sandbox: `whatsapp:+14155238886` → Prod: `whatsapp:+558894963067` (wa_id, **sem o 9**) |

## Erros que vão morder

- **Nono dígito no FROM (63007):** o sender é registrado com o 9 (`+5588994963067`),
  mas o canal responde pelo wa_id **sem** o 9 (`whatsapp:+558894963067`). FROM com o 9 →
  `63007` em todo envio. Mordeu no cutover da Fase B (2026-06-03).
- **URL exata:** o bot valida a `X-Twilio-Signature` reconstruindo a URL pública. Tem que
  bater **exatamente**: `https://bot.appslice.com.br/webhooks/whatsapp`, **sem barra no
  fim, sem querystring**. Divergiu → bot responde **403** e a Twilio mostra falha de
  entrega. (O Traefik do Dokploy já manda `x-forwarded-proto/host` certos.)
- **Trial só fala com números verificados** — testar a Fase B ainda em trial dá erro; por
  isso o upgrade no passo 1.
- **Sandbox expira em 3 dias** — reenviar o `join`.
- **Janela de 24h:** o Slice só responde quem escreveu → nunca esbarra. Bot iniciar
  conversa exigiria template aprovado (fora de escopo).

## Rollback

> ⚠️ **OBSOLETO desde a Fase B (2026-06-03).** O `5588994963067` saiu do WhatsApp
> consumer ao virar sender da API (porta de mão única) — não dá mais pra re-parear
> via Baileys com esse número. Rollback agora seria só de código (reverter commit),
> trocando de número, o que não faz sentido. Mantido só como registro histórico.

Como o `docker-compose.yml` não foi tocado, a stack Evolution continua no ar. Reverter =
voltar a branch (`git revert`/redeploy da versão anterior) e re-parear o Baileys pelo
runbook antigo. Ver `docs/superpowers/runbooks/2026-05-23-vps-setup.md`.
