# Slice — Conversa natural (persona + anti-tutorial) e resiliência do Gemini

**Status:** approved (design) — implementation pending
**Date:** 2026-05-29
**Author:** Danubio + Claude (brainstorm)
**Estende:** [`2026-05-26-soft-replies-conversational-fluidity.md`](./2026-05-26-soft-replies-conversational-fluidity.md)
(introduziu o campo `reply`, já em produção; **adiou de propósito** a persona — §5
daquele spec — e não tratou falha do Gemini)

---

## 1. Contexto e problema

A validação com testers (irmãos do Danubio) gerou prints reais que expõem três
classes de problema. O spec de soft-replies resolveu o "muro robótico" do
`unknown`, mas sobrou:

**(a) Voz fragmentada.** Cópia hardcoded briga com o `reply` gerado pelo Gemini.
O usuário vê pelo menos 4 variantes de "não entendi" em rotação, vindas de fontes
diferentes:
- `notifyUnknown` (hardcoded): *"Não entendi 🤔 Pra criar uma conta..."*
- `requireRegistrationFirst` (hardcoded): *"Olá! Sou o Slice 👋 Antes de dividir..."*
- `reply` do Gemini: *"Não peguei essa 🤔..."*, *"Oi! 😄 Eu te ajudo..."*

O bot parece ter 4 personalidades. É o maior ofensor do "robótico".

**(b) Tutorial como resposta pra tudo.** O exemplo *"paguei 60 na pizza, divide
com Ana e Beto"* vira o tampão universal. *"Obrigado!"*, *"Quem é você?"*,
*"Tá online?"*, pergunta off-topic — tudo recebe o mesmo tutorial. Para quem já
sabe usar, isso enche o saco.

**(c) Falha do Gemini = silêncio total.** Quando `extractIntent` lança erro (o
**503** que o Danubio viu), cai no `catch` externo do webhook
(`whatsapp.webhook.ts`) e **o usuário não recebe nada**. Não há retry. Forte
suspeita: o cadastro da Daiane de ontem (*"Sou daiane. Pix:..."* às 21:45, sem
resposta nenhuma) morreu assim — e hoje ela aparece como não-cadastrada.

Problemas menores observados nos prints, também no escopo:
- **Intent misto descartado:** *"Eu sou Daiane e fui à sorveteria com João..."*
  tinha nome **e** conta na mesma frase; o bot pegou só `create_bill`, viu que
  não há cadastro e pediu cadastro — jogando o nome fora.
- **Frase truncada:** *"Mando o PIX de cada um (João) a seguir"* — com 1
  participante o `(João)` parentético fica robótico.

## 2. Decisão

**Polir, sem memória de conversa** (classificação continua stateless, 1 mensagem
por vez). Quatro decisões:

1. **Duas trilhas, sem mistura.**
   - **Trilha do dinheiro** (registrar, criar conta + PIX, marcar pago) → 100%
     determinística. O Gemini só extrai dados; o código decide e confirma com
     texto fixo.
   - **Trilha conversa** (oi, obrigado, "quem é você", off-topic, "me explica",
     lixo) → o Gemini escreve a resposta com persona. Fallback fixo na mesma voz
     se o LLM falhar.

2. **Persona única.** Uma definição de voz, referenciada por (i) o prompt — pras
   respostas vivas — e (ii) o módulo novo `voice.ts` — pras frases fixas. O
   dispatcher **sempre** usa o `reply` do LLM na trilha conversa; os templates
   hardcoded conflitantes (`notifyUnknown`, `requireRegistrationFirst`) deixam de
   ser usados como resposta geral e viram só fallback, reescritos na mesma voz.

3. **Anti-tutorial.** O exemplo de formato é ferramenta de ensino, não resposta
   pra tudo. Só aparece quando a pessoa precisa aprender o formato: cadastro,
   gate de PIX, confirmação pós-cadastro, fallback de confusão real. Nunca em
   agradecimento, identidade, off-topic ou pra quem já está usando.

4. **Resiliência do Gemini.** Retry com backoff em erros transitórios; mensagem
   de instabilidade em vez de silêncio quando o Gemini cai de vez.

### Abordagens consideradas e descartadas
- **Memória de conversa (últimos N turnos):** resolveria follow-ups
  ("me explica melhor" sabendo do turno anterior), mas é mais código/estado;
  fora de escopo nesta rodada de validação.
- **Templates fixos puros (sem LLM na conversa):** barato e imune a 503, mas
  repete frase idêntica — parte do que já parecia robótico. Preferimos LLM com
  persona + fallback fixo.
- **Chat agêntico com tool-calling:** mais natural, mas torna o caminho do
  dinheiro não-determinístico e multiplica a superfície de falha. Over-engineering
  pra 2-3 usuários.
- **Debounce de mensagens rápidas:** evitaria a resposta dupla
  ("Não entendi"+"me explica melhor"), mas exige buffer + timer em memória.
  Fora de escopo (decisão explícita).

## 3. Escopo

**Faz parte:**
- Persona única (prompt + `voice.ts`), matando a fragmentação de voz.
- Regra anti-tutorial no prompt; dispatcher sempre usa o `reply` na trilha conversa.
- Retry/backoff no Gemini + `GeminiUnavailableError` + mensagem de instabilidade.
- Intent misto: registrar nome/PIX embutidos numa mensagem de conta e seguir.
- Reescrita das frases determinísticas (gates, confirmações) com singular/plural correto.

**Não faz parte:**
- Memória de conversa / contexto multi-turno.
- Debounce de mensagens em sequência.
- Mudança no schema do Gemini (os campos `bill` e `profile` já coexistem).
- Repositórios/SQLite, PIX, scanner Cumbuca (legado dormente), infra/deploy.
- Novos intents no enum (saudação/obrigado/off-topic continuam `unknown`).

## 4. Mudanças por arquivo

### 4.1 Novo: `src/services/messaging/voice.ts`
Fonte única de toda cópia determinística voltada ao usuário + formatação BRL.
Funções com nomes do domínio (sem `tick`/`handle`). No topo do arquivo, um bloco
de comentário documenta a persona (a mesma que o prompt segue), pra quem editar
manter o tom.

Conteúdo (strings finais em §5):
- `formatBRL(value)` — movido pra cá de `bill.service.ts` (vira o lugar canônico;
  `bill.service.ts` passa a importar).
- Confirmações de dinheiro: `billCreatedHeadline(bill)`, `paymentReceived(...)`,
  `billClosed(bill)`.
- Gates de cadastro: `askToRegister()`, `askForPix(name)`.
- Confirmações de cadastro: `welcomeNeedPix(name)`, `welcomeReady(name)`,
  `pixSaved()`.
- Fallbacks: `fallbackReply(ctx)` (sensível a cadastro), `instability()`.

As cópias operacionais do `mark_paid` ("Quem pagou? Em aberto:...", etc.) **não**
foram apontadas como robóticas nos prints e ficam onde estão (`bill.service.ts`),
só com checagem de tom. Evitar refactor não pedido.

### 4.2 `src/services/llm/prompt.ts` — persona + regra anti-tutorial
Reescreve `SYSTEM_INSTRUCTION` adicionando um bloco de persona no topo e
ampliando o tratamento do `unknown`. A classificação dos intents de ação **não
muda** (mesmas regras de `create_bill`/`register_account`/`mark_paid`).

Bloco de persona (resumo — texto final no código):
> Você é o **Slice**: caloroso, brasileiro, direto. Fala como amigo que resolve,
> não como atendente de robô. Frases curtas (é WhatsApp). No máximo 1 emoji por
> mensagem (às vezes nenhum). Sabe exatamente 3 coisas: registrar (nome+PIX),
> dividir conta gerando PIX, marcar quem pagou.
>
> **Responda ao que a pessoa disse, curto e direto. NÃO transforme toda resposta
> num tutorial.** O exemplo de formato ("paguei 60 na pizza, divide com Ana e
> Beto") só entra quando ela precisa aprender o formato (cadastro, confusão
> genuína, primeiro contato). Pra quem já sabe usar, nada de repetir instrução.
> Pra pergunta off-topic, recuse com simpatia e diga em 1 linha o que você faz —
> sem fingir ser assistente geral. Nunca invente recurso. Nunca coloque chave PIX
> nem valores no `reply`.

Tratamento do `unknown` (preencher `reply` adaptado à nota de contexto):
- **Saudação** — cadastrado: cumprimento curto, sem tutorial ("Opa! 👋 Tudo
  bom?"). Não-cadastrado (primeiro contato): boas-vindas + pede cadastro (momento
  legítimo de ensinar).
- **Agradecimento** ("obrigado", "valeu") → reconhece e encerra ("De nada! 😊").
  Sem tutorial.
- **Identidade/ajuda** ("quem é você", "o que faz") → diz o que é/faz, em 1-2
  linhas naturais (não o exemplo rígido).
- **Off-topic** ("definição de número par") → recusa simpática + 1 linha do que faz.
- **Lixo/sem sentido** ("asdf") → pede pra reformular, gentil.

Exemplos no prompt atualizados pra refletir a regra anti-tutorial (substituem os
exemplos de saudação/gibberish atuais, que repetem o tutorial).

### 4.3 `src/services/llm/gemini.ts` — resiliência
- **Retry com backoff** em volta de `ai.models.generateContent`: 2 retentativas
  (3 tentativas no total), delays ~500ms e ~1500ms com jitter. Helper
  `isRetryableError(err)` no módulo: trata como transitório status HTTP
  429/500/502/503/504, e erros de rede/timeout (sem resposta, `ECONNRESET`,
  `ETIMEDOUT`, `fetch failed`, mensagens com "UNAVAILABLE"/"overloaded"/
  "deadline"). **Não** retenta 4xx não-429 (ex: 400 — é bug, não instabilidade).
- **Falha persistente (erro lançado):** após esgotar as retentativas, lança
  `GeminiUnavailableError` (classe exportada). Não cai mais em `{intent:unknown}`
  silencioso pra erro de infra.
- **Resposta vazia/inparseável:** é "Gemini respondeu estranho", não "Gemini
  fora". Faz **1 tentativa extra**; se ainda vier vazio/inparseável, retorna
  `{ intent: 'unknown' }` (comportamento atual) → dispatcher cai no
  `fallbackReply`. (Distinto da instabilidade.)
- `temperature` sobe de `0.1` → `0.3` pra dar vida ao `reply` sem arriscar a
  extração (o `responseSchema` prende os campos estruturados; números vêm do
  texto, não são amostrados). Knob pequeno, documentado em comentário.

### 4.4 `src/routes/whatsapp.webhook.ts` — dispatcher
- **Extração isolada num try próprio:** se `extractIntent` lançar
  `GeminiUnavailableError` (ou qualquer erro inesperado na fase de extração),
  manda `voice.instability()` e encerra — fim do silêncio. Os handlers de ação
  (criar conta, mark_paid) rodam fora desse try e mantêm o tratamento de erro
  atual (logam), pra não arriscar mensagem dupla quando um envio falha no meio.
- **Trilha conversa unificada:** no `unknown`, usa `result.reply` (válido,
  ≤ ~300 chars) via `sendText`; senão `voice.fallbackReply(ctx)`. Remove o uso de
  `notifyUnknown`/`requireRegistrationFirst` como "resposta geral" — viram cópia
  do `voice.ts` só no fallback/gates.
- **Intent misto** no `create_bill` (ver 4.5).

### 4.5 Intent misto — `whatsapp.webhook.ts` + `user.service.ts`
O schema já devolve `bill` e `profile` como campos separados; o prompt passa a
preencher **os dois** quando a pessoa se apresenta E descreve a conta na mesma
mensagem. No `create_bill`:

```
if (!result.bill) → fallback
let currentUser = user
if (result.profile && (!currentUser || !currentUser.pix_key)) {
  await handleRegistration(senderPhone, result.profile, { continueToBill: true })
  currentUser = await userRepository.findByPhone(senderPhone)
}
if (!currentUser)          → voice.askToRegister()
if (!currentUser.pix_key)  → voice.askForPix(currentUser.name)
await createBillFromExtraction(result.bill, currentUser)
```

`handleRegistration` ganha um parâmetro opcional `{ continueToBill?: boolean }`:
quando `true` e o cadastro fica **completo** (nome+PIX), **não** envia o nudge
"manda uma conta" (a confirmação da conta vem logo em seguida). Quando ainda
falta PIX, o fluxo cai no `askForPix` normalmente.

Caso real da Daiane ("Eu sou Daiane e fui à sorveteria com João...", sem PIX):
registra "Daiane", responde `askForPix("Daiane")` — em vez de jogar o nome fora.

### 4.6 `src/services/bills/bill.service.ts` — confirmações via `voice.ts`
- `sendBillCreatedMessages` usa `voice.billCreatedHeadline(bill)` com
  **singular/plural** correto na lista de nomes.
- `renderPaidMessage`/`renderClosedMessage` → `voice.paymentReceived`/
  `voice.billClosed`.
- `formatBRL` importado do `voice.ts` (remove duplicata).

### 4.7 `src/services/users/user.service.ts` — gates/confirmações via `voice.ts`
- `requireRegistrationFirst`/`requirePixFirst`/`notifyUnknown` passam a delegar
  pro `voice.ts` (ou são substituídos pelas funções de lá). Mensagens de cadastro
  (`welcomeNeedPix`, `welcomeReady`, `pixSaved`) idem.

## 5. Cópia concreta (PT-BR, voz Slice)

Strings finais (podem sofrer micro-ajuste na implementação; o tom é este):

**Conversa (geradas pelo Gemini — exemplos-alvo, não templates):**
- "Obrigado!" → `De nada! 😊`
- "Quem é você?" → `Sou o Slice 🙂 Divido conta no PIX — você me diz o que pagou e com quem, e eu gero a cobrança de cada um.`
- "Tá online?" → `Tô aqui 👋`
- off-topic → `Essa eu não sei 😅 Eu cuido mesmo é de dividir conta.`
- "oi" (já cadastrado) → `Opa! 👋 Tudo bom?`
- "oi" (1º contato) → `Oi! Eu divido contas no PIX 👋 Pra começar, me diz seu nome e chave PIX (ex: "Sou João, pix joao@email.com").`

**Fallback determinístico (`voice.fallbackReply`, quando o `reply` falha):**
- não-cadastrado → `Oi! Eu divido contas no PIX 👋 Pra começar, me diz seu nome e chave PIX (ex: "Sou João, pix joao@email.com").`
- cadastrado → `Não peguei 🤔 Posso dividir uma conta ("paguei 60 na pizza, divide com Ana e Beto") ou marcar quem pagou ("a Ana me pagou").`

**Instabilidade (`voice.instability`):**
- `Eita, tive uma instabilidade aqui 😅 Manda sua mensagem de novo daqui a pouquinho?`

**Gates:**
- `askToRegister` → `Pra dividir essa conta eu preciso te conhecer primeiro 🙂 Me diz seu nome e chave PIX (ex: "Sou João, pix joao@email.com").`
- `askForPix(name)` → `Falta só sua chave PIX, {name}! Manda algo tipo "pix joao@email.com" que eu gero as cobranças.`

**Cadastro:**
- `welcomeNeedPix(name)` → `Prazer, {name}! 😄 Agora me manda sua chave PIX (ex: "pix seu@email.com") pra eu gerar as cobranças.`
- `welcomeReady(name)` → `Show, {name}! Tá tudo certo ✅ Manda uma conta tipo "paguei 60 na pizza, divide com Ana e Beto" que eu cuido do resto.`
- `pixSaved` → `Chave PIX salva! 🎉 Pode mandar a conta agora (ex: "paguei 60 na pizza, divide com Ana e Beto").`

**Conta criada (`billCreatedHeadline`):**
- 1 participante → `Anotei: {total} em {desc}, {perPerson} pra cada. Te mando o PIX de {nome} 👇`
- 2+ → `Anotei: {total} em {desc}, {perPerson} pra cada. Te mando o PIX de {nomes} 👇`
  (`{nomes}` = nomes unidos por " e ")
- Em seguida, 1 mensagem por participante com o PIX copia-e-cola (inalterado).

**Pagamento / fechamento (leve polimento do atual):**
- `paymentReceived` → `{name} pagou {amount}! 💰 Ainda falta: {nomes}.`
- `billClosed` → `Fechou! Todo mundo pagou {desc}. Saldo zerado 💸`

## 6. Guardrails / error handling
- `reply` ausente, vazio ou > ~300 chars → `voice.fallbackReply(ctx)`.
- `GeminiUnavailableError` (erro transitório após retries) → `voice.instability()`.
  Qualquer outro erro inesperado na extração → também instabilidade (nunca silêncio).
- Resposta vazia/inparseável após 1 tentativa extra → `unknown` → fallback.
- Defesa contra prompt injection no nome (`sanitizeName`) — **mantida** como está.
- PIX nunca em `reply` nem em log (redação em `whatsapp.ts` — **mantida**).
- `unknown` continua gravado em `unknown-intents` (analytics) — **mantido**.

## 7. Fora de escopo
- Memória de conversa / multi-turno.
- Debounce de mensagens em sequência.
- Comandos admin (`/listar`, `/fechar`, `/cancelar`).
- Gênero nos artigos ("do/da" {nome}) — usar "de {nome}" pra evitar o problema.

## 8. Testing
Convenção do projeto: sem testes automatizados — `npx tsc --noEmit` + smoke
manual. Smoke:
- "Obrigado!" (cadastrado) → reconhecimento curto, **sem** tutorial.
- "Quem é você?" → descrição natural, **sem** o exemplo rígido.
- off-topic ("número par?") → recusa simpática, **sem** tutorial.
- "oi" (cadastrado) → cumprimento curto; (não-cadastrado) → boas-vindas + cadastro.
- Intent misto: "Sou Daiane e paguei 10 no sorvete, divide com João" → registra
  Daiane e pede PIX (não joga o nome fora); com PIX junto → cria a conta.
- `create_bill` 1 participante → headline no singular ("PIX de João", sem
  "(João)").
- Forçar Gemini 503 (ex: key inválida temporária / mock de erro) → mensagem de
  instabilidade, **não** silêncio. Conferir que houve retry nos logs.
- `create_bill`/`register_account`/`mark_paid` continuam funcionando igual.
