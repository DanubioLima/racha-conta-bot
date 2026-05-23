# Meta Business / WhatsApp Cloud API — Setup Runbook

**Pré-requisito:** chip Vivo secundário disponível, NÃO registrado em
WhatsApp consumer nem WhatsApp Business app.

## 1. Criar Meta Business Manager

1. Acesse https://business.facebook.com
2. "Create Account" — usar nome pessoal (Slice) já que é uso individual
3. Confirmar email

## 2. Criar Meta App

1. Acesse https://developers.facebook.com/apps
2. "Create App" → tipo "Business"
3. Vincular ao Business Manager criado acima
4. Em "Add products to your app", adicionar "WhatsApp"

## 3. Registrar o número Vivo no Cloud API

1. WhatsApp → "API Setup"
2. "Add phone number" → digitar o número Vivo (com código do país)
3. Receber código OTP via SMS ou ligação → confirmar
4. **Anotar o `Phone number ID`** (não é o número em si — é um UUID-like
   gerado pelo Meta). Vai no `WHATSAPP_PHONE_NUMBER_ID`.

## 4. Pegar Access Token long-lived

Token temporário (24h) aparece na tela do "API Setup". **Não usar em
produção.** Pra long-lived:

1. Business Settings → System Users → "Add"
2. Criar System User com role Admin
3. Generate token → escolher o App + permissões `whatsapp_business_messaging`
   e `whatsapp_business_management`
4. Token "Never" (permanent) — anotar. Vai no `WHATSAPP_ACCESS_TOKEN`.

## 5. App Secret

1. App → Settings → Basic
2. Copiar "App Secret". Vai no `WHATSAPP_APP_SECRET`.

## 6. Verify Token (você define)

Gerar uma string random — `openssl rand -hex 32` por ex. Vai no
`WHATSAPP_VERIFY_TOKEN`. Vai ser usado também na configuração do webhook
no Meta (passo 8).

## 7. Submeter templates

Acessar Meta Business → WhatsApp Manager → Message Templates → Create.

### Template 1: `bill_partial_paid`
- Category: Utility
- Language: Portuguese (BR)
- Body:
  ```
  💸 {{1}} pagou R$ {{2}} da conta {{3}}. Ainda falta: {{4}}.
  ```
- Example parameters (Meta exige exemplo):
  - {{1}} = Maria
  - {{2}} = 10,00
  - {{3}} = Pizza
  - {{4}} = João

### Template 2: `bill_settled`
- Category: Utility
- Language: Portuguese (BR)
- Body:
  ```
  💸 Fechou a conta {{1}}! Todo mundo já pagou.
  ```
- Example:
  - {{1}} = Pizza

### Template 3: `bill_expired`
- Category: Utility
- Language: Portuguese (BR)
- Body:
  ```
  ⏱️ A conta {{1}} expirou após 7 dias. Pendentes: {{2}}.
  ```
- Example:
  - {{1}} = Pizza
  - {{2}} = Maria, João

Submeter os 3. Aprovação típica: minutos a algumas horas. **Status fica
"In review" → "Approved" ou "Rejected".** Se rejeitado, simplificar copy
(sem markdown, sem emoji) e resubmeter.

## 8. Configurar webhook no Meta

**Após o deploy estar de pé** (Task 15), com a URL pública conhecida:

1. App → WhatsApp → Configuration → Webhook
2. "Callback URL": `https://bot.appslice.com.br/webhooks/whatsapp`
3. "Verify Token": o que você setou no `WHATSAPP_VERIFY_TOKEN`
4. Subscribe to: `messages` (pelo menos)
5. Click "Verify and save" — Meta vai fazer um GET no callback, que deve
   responder com o `hub.challenge` (rota nossa em `whatsapp.webhook.ts`).
   Se a verificação falhar:
   - Webhook URL inalcançável (DNS? Caddy/Traefik?)
   - VERIFY_TOKEN diferente no Meta vs. servidor → conferir env
   - 403 do servidor: checar logs em Dokploy

## 9. Pronto pro deploy

Vars que você deve ter coletado:
- `WHATSAPP_PHONE_NUMBER_ID` — passo 3
- `WHATSAPP_ACCESS_TOKEN` — passo 4
- `WHATSAPP_APP_SECRET` — passo 5
- `WHATSAPP_VERIFY_TOKEN` — passo 6 (você definiu)

Templates aprovados:
- bill_partial_paid
- bill_settled
- bill_expired

Próxima coisa: provisionar VPS (runbook em
`docs/superpowers/runbooks/2026-05-23-vps-setup.md`).
