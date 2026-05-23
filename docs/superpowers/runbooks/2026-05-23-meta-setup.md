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
3. **Atribuir o System User ao App** (ver gotcha abaixo — sem isso, próximo
   passo trava com "Nenhuma permissão disponível")
4. Generate token → escolher o App + permissões `whatsapp_business_messaging`
   e `whatsapp_business_management`
5. Token "Never" (permanent) — anotar. Vai no `WHATSAPP_ACCESS_TOKEN`.

### Gotcha — "Nenhuma permissão disponível" ao gerar token

Sintoma: você seleciona o App em "Generate Token" mas a lista de permissões
fica vazia e aparece a mensagem "Atribua uma função do app ao usuário do
sistema ou selecione outro app para continuar."

Causa: o System User precisa ser atribuído ao App antes — Meta liga os dois
mundos manualmente.

Fix (escolha um dos dois caminhos, são equivalentes):

**Pelo lado do System User:**
1. Business Settings → System Users → seu System User
2. Painel direito "Assigned Assets" / "Recursos atribuídos" → "Add Assets"
3. Apps → marque o App → role "Manage app" (Full Control)
4. Save → volte pro Generate Token; permissões agora aparecem

**Pelo lado do App:**
1. Business Settings → Apps → seu App
2. Painel "People" / "Pessoas" → "Add People"
3. Escolha o System User → role "Manage app" / "Develop App"
4. Save → volte pro Generate Token

Se mesmo após isso só algumas permissões aparecem: confere se você é Admin
do Business Portfolio (não só Employee). Business Verification pode ser
exigida pra liberar todas as permissões em contas novas, mas pro nosso
volume baixo as permissões básicas servem.

## 5. App Secret

1. App → Settings → Basic
2. Copiar "App Secret". Vai no `WHATSAPP_APP_SECRET`.

## 6. Verify Token (você define)

Gerar uma string random — `openssl rand -hex 32` por ex. Vai no
`WHATSAPP_VERIFY_TOKEN`. Vai ser usado também na configuração do webhook
no Meta (passo 8).

## 7. Submeter templates

Acessar Meta Business → WhatsApp Manager → Message Templates → Create.

### Gotcha — "Esse modelo contém muitas variáveis para sua extensão"

Meta valida o ratio texto-fixo × variáveis. Templates curtos com muitas
variáveis levam esse erro. Solução: expandir o texto fixo (mais contexto
em volta dos placeholders). Os 3 templates abaixo já estão dimensionados
pra passar nessa validação.

### Template 1: `bill_partial_paid`
- Category: Utility
- Language: Portuguese (BR)
- Body:
  ```
  💸 Atualização do seu Slice: {{1}} acabou de pagar R$ {{2}} referente à conta "{{3}}". Ainda está pendente o pagamento de: {{4}}.
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
  💸 Boas notícias! A sua conta "{{1}}" foi quitada — todos os participantes já enviaram o pagamento via PIX. Saldo zerado.
  ```
- Example:
  - {{1}} = Pizza

### Template 3: `bill_expired`
- Category: Utility
- Language: Portuguese (BR)
- Body:
  ```
  ⏱️ A sua conta "{{1}}" foi marcada como expirada após 7 dias sem fechar. Participantes que ainda não pagaram: {{2}}.
  ```
- Example:
  - {{1}} = Pizza
  - {{2}} = Maria, João

Submeter os 3. Aprovação típica: minutos a algumas horas. **Status fica
"In review" → "Approved" ou "Rejected".** Se rejeitado por outro motivo
(copy spam-like, etc): simplificar copy (sem markdown, sem emoji exagerado)
e resubmeter.

**Slots posicionais ficam os mesmos** (Maria → {{1}}, valor → {{2}},
conta → {{3}}, pendentes → {{4}}), então o código que monta os
`bodyParameters` no `sendTemplate` não muda.

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
