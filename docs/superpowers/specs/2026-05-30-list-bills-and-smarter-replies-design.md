# Slice — Listar contas + respostas menos "burras"

**Status:** approved (design) — implementation pending
**Date:** 2026-05-30
**Author:** Danubio + Claude (brainstorm)
**Estende:** [`2026-05-29-conversational-polish-resilience.md`](./2026-05-29-conversational-polish-resilience.md)
(PR #8, já mergeado: persona, anti-tutorial, resiliência do Gemini, intent misto)

---

## 1. Contexto e problema

Pós-#8 a conversa melhorou (persona, off-topic, mark_paid funcionando), mas um
print real de prod mostra o Slice ainda "burro" pra perguntas óbvias:

- **"E quais contas minhas você registrou?"** → "Essa eu não sei 😅". Pergunta
  legítima e respondível — o bot TEM o dado (`billRepository.findOpenForOwner`),
  mas joga no off-topic.
- **"Liste contas em aberto"** → "Essa eu não sei". Não existe intent de listar.
- **"Você sabe fazer algo além de dividir conta?"** → "Essa eu não sei". Pergunta
  sobre as PRÓPRIAS capacidades tratada como off-topic.
- **"Essa eu não sei 😅 Eu cuido mesmo é de dividir conta."** repetida 4× idêntica.
- (menor) **"Anotei: R$ 20,00 em Conta"** — descrição genérica quando o usuário
  não cita estabelecimento ("divide uma conta de 20").

**Causa raiz:** (a) não existe intent de **listar contas**, e (b) o handler de
off-topic é guloso — engole consultas de dados que o bot consegue responder E
perguntas sobre as próprias capacidades.

## 2. Decisão e escopo

Quatro melhorias, todas conversacionais. Caminho do dinheiro segue determinístico;
**sem memória de conversa** (stateless mantido).

**Faz parte:**
1. **Intent novo `list_bills`** (classificado pelo Gemini, em linguagem natural —
   não comando `/listar`, que não pegaria "quais contas você registrou"). Lista as
   contas ABERTAS do dono no formato compacto (1 linha por conta).
2. **Perguntas sobre capacidades** respondidas (não jogadas no off-topic).
3. **Off-topic variado** (parar de repetir a frase idêntica).
4. **Descrição vazia** quando não há estabelecimento (em vez de "Conta").

**Não faz parte:**
- Memória de conversa / multi-turno; debounce de mensagens rápidas.
- Comandos admin `/fechar`, `/cancelar` (não apareceram no print; ficam pra depois).
- Reenviar o PIX copia-e-cola na listagem (só resumo; reenvio é outra feature).
- Listar contas FECHADAS (as abertas são as acionáveis).

## 3. Mudanças por componente

### 3.1 Intent `list_bills`

**`src/services/bills/bill.types.ts`** — `ExtractionResult` ganha a variante:
```typescript
| { intent: 'list_bills' }
```
(sem payload — a ação não precisa de campos extras).

**`src/services/llm/gemini.ts`** — o enum de `intent` no `RESPONSE_SCHEMA` ganha
`"list_bills"`.

**`src/services/llm/prompt.ts`** — a linha de abertura passa a listar
`create_bill, register_account, mark_paid, list_bills, unknown`. Nova seção:
```
== list_bills ==
O usuário quer VER as contas dele em aberto / saber quanto falta / o que já
registrou. Ex: "liste contas em aberto", "minhas contas", "quais contas você
registrou", "quanto falta", "o que tá em aberto". Intent "list_bills" (sem
outros campos).
```
Exemplos novos: `"Liste contas em aberto"` → `{"intent":"list_bills"}`;
`"Quais contas você registrou pra mim?"` → `{"intent":"list_bills"}`;
`"Quanto ainda falta?"` → `{"intent":"list_bills"}`.

**`src/services/messaging/voice.ts`** — `openBillsList(bills)` (shape mínimo,
desacoplado do tipo `Bill`, igual ao padrão de `billCreatedHeadline`):
```typescript
export function openBillsList(
  bills: { description: string; total: number; pending: string[] }[],
): string
```
Regras (formato compacto escolhido):
- Vazio → `Você não tem nenhuma conta em aberto 🎉`
- Senão → `Suas contas em aberto:` + 1 linha por conta:
  - rótulo = `description ? "{description} — {formatBRL(total)}" : formatBRL(total)`
  - pendentes: 1 → `falta {nome}`; 2+ → `faltam {N}: {nomes join ", "}`
  - linha = `• {rótulo} ({pendentes})`
- Como `findOpenForOwner` só traz OPEN, sempre há ≥1 pendente por conta.

**`src/services/bills/bill.service.ts`** — `listOpenBills(ownerPhone)`:
```typescript
export async function listOpenBills(ownerPhone: string): Promise<void> {
  const bills = await billRepository.findOpenForOwner(ownerPhone);
  const summary = bills.map((b) => ({
    description: b.description,
    total: b.total_amount,
    pending: b.participants.filter((p) => p.status === "PENDING").map((p) => p.name),
  }));
  await sendText(ownerPhone, openBillsList(summary));
}
```

**`src/routes/whatsapp.webhook.ts`** — novo case:
```typescript
case "list_bills":
  if (!user) { await sendText(senderPhone, askToRegister()); break; }
  await listOpenBills(senderPhone);
  break;
```

### 3.2 Perguntas sobre capacidades (prompt)

No `== unknown ==`, separar explicitamente "pergunta sobre o MUNDO" de "pergunta
sobre MIM":
- Reescrever o bullet de identidade pra cobrir também **"sabe fazer algo além de
  X" / "o que mais você faz"** → responder listando as capacidades (registrar PIX,
  dividir conta, marcar quem pagou, **listar contas em aberto**). É pergunta sobre
  o bot, NÃO off-topic.
- Reescrever o bullet de off-topic: off-topic = pergunta sobre o **mundo**
  (matemática, clima, notícias), **não** sobre você nem sobre as contas do usuário.
- Atualizar o exemplo de identidade pra mencionar o listar; adicionar exemplo:
  `"Você sabe fazer algo além de dividir conta?"` → reply com as capacidades.

### 3.3 Off-topic variado (prompt)

No bullet de off-topic, adicionar "**varie a recusa, não repita sempre a mesma
frase**". Adicionar um 2º exemplo de off-topic com fraseado diferente do atual.
Com `temperature` 0.3 isso reduz a repetição.
**Ressalva:** stateless (sem memória) → duas recusas seguidas ainda *podem*
coincidir; isto reduz, não elimina.

### 3.4 Descrição vazia (prompt + voice)

**Prompt** (`== create_bill ==`, campo description): "Se NÃO houver
estabelecimento/descrição clara (ex: 'divide uma conta de 20'), deixe
`description` como string vazia `""` — não invente 'Conta'."

**Voice** — tratar `description` vazia graciosamente:
- `billCreatedHeadline`: com desc vazia, omitir o "em {desc}":
  `Anotei: R$ 20,00, R$ 10,00 pra cada. Te mando o PIX de João 👇`
- `billClosed`: com desc vazia → `Fechou! Todo mundo pagou a conta. Saldo zerado 💸`
- `openBillsList`: com desc vazia → `• R$ 20,00 (falta João)` (rótulo só o valor).

`paymentReceived` não usa description → não muda.

## 4. Copy concreto (voz Slice)

**Listagem (`openBillsList`):**
```
Suas contas em aberto:
• Pizza — R$ 60,00 (faltam 2: Ana, Beto)
• Uber — R$ 30,00 (falta João)
```
Vazio: `Você não tem nenhuma conta em aberto 🎉`

**Capacidades (geradas pelo Gemini — alvos):**
- "Quem é você?" → `Sou o Slice 🙂 Eu divido conta no PIX, marco quem já pagou e te mostro suas contas em aberto.`
- "Você sabe fazer algo além de dividir conta?" → `Além de dividir, eu marco quem já pagou e te mostro suas contas em aberto 🙂`

**Off-topic (2 estilos, pra variar):**
- `Essa eu não sei 😅 Eu cuido mesmo é de dividir conta.`
- `Aí já é fora da minha praia 😄 Eu sou bom é em rachar conta.`

## 5. Guardrails
- `list_bills` para não-cadastrado → `askToRegister()` (sem cadastro não há contas).
- `openBillsList` desacoplado do tipo `Bill` (recebe shape mínimo) — `voice.ts`
  continua sem depender do domínio de bills.
- PIX nunca aparece na listagem (só descrição/valor/nomes) nem em log (mantido).
- Extração de `create_bill`/`mark_paid`/`register_account` inalterada — só o enum
  e os exemplos crescem.

## 6. Fora de escopo
Memória de conversa, debounce, `/fechar`/`/cancelar`, reenvio de PIX, listar
contas fechadas, ambiguidade pré-existente do `headcount`.

## 7. Testing
Projeto sem testes automatizados — `npx tsc --noEmit` limpo + smoke manual:
- "Liste contas em aberto" / "quais contas você registrou" (com contas abertas)
  → resumo compacto correto (1 pendente "falta X"; 2+ "faltam N: ...").
- Idem sem contas abertas → "Você não tem nenhuma conta em aberto 🎉".
- "Liste contas" de usuário não cadastrado → `askToRegister`.
- "Você sabe fazer algo além de dividir conta?" → responde capacidades (inclui
  listar), **não** off-topic.
- Off-topic repetido 2-3× → frases variam (não idênticas).
- "divide uma conta de 20 com o joão" → "Anotei: R$ 20,00, R$ 10,00 pra cada..."
  **sem** "em Conta"; ao fechar → "...pagou a conta."; na lista → "• R$ 20,00 (...)".
- create_bill com estabelecimento, mark_paid, register continuam iguais.
