# Slice — Assistente de Dinheiro v1 (gastos + fiado)

**Date:** 2026-06-04
**Status:** aprovado (brainstorm Danubio + Claude)
**Motivação:** 2 feedbacks externos independentes (amigos reais) pedindo anotar
gastos e controlar quem deve, ambos fora do perfil "racha em grupo". Decisão:
**reposicionar** o Slice de "bot de rachar conta" para "assistente de dinheiro
no WhatsApp" — anotar gastos, fiado e rachar conta como features irmãs.

## Decisões de escopo (v1)

- **Entram:** anotar gastos + consultas por período; fiado (quem me deve).
- **Reposicionamento completo:** voz do bot, capability answers e landing mudam.
- **100% reativo** (grátis pela Meta). Digest proativo fica fora (exige template
  aprovado + scheduler + custo por envio).
- **Fora da v1:** digest semanal; consulta por categoria (dados gravados desde
  o dia 1, consulta vira v2 sem buraco); assinatura/monetização (pós-validação);
  memória de preços de loja (scope creep — não perseguir).
- **Arquitetura escolhida (A):** fiado reusa `bills` (+coluna `kind`); gastos em
  tabela nova isolada. Zero refactor no caminho do dinheiro testado. Ledger
  unificado (B) só se a validação der 🟢 e o produto crescer.

## Intents

| Intent | Exemplo | Ação |
|---|---|---|
| `log_expense` 🆕 | "gastei 25 no mercado" | insere em `expenses` (valor, descrição, categoria auto, data=agora BRT) |
| `query_expenses` 🆕 | "quanto gastei essa semana?" | `{period: today\|week\|month}` → total + lista compacta |
| `register_debt` 🆕 | "Roberto me deve 100" | cria bill `kind='debt'` com 1 participante + envia PIX da cobrança |
| `create_bill` ✏️ | "paguei 60, divide com Ana" | inalterado; **sem participantes → log_expense** (fecha o bug da conta vazia) |
| `list_bills` ✏️ | "quem me deve?" | visão geral agrupada por `kind` (rachas / dívidas) |
| `mark_paid` | "Roberto me pagou" | inalterado — cobre dívidas de graça (mesmo modelo) |
| `close_bill` | "esquece a dívida do Roberto" | inalterado — idem |

**Desambiguação racha × gasto (prompt):** citou pessoas/divisão = racha;
solo = gasto.

### Decisão: classify→dispatch mantido (não tool-calling)

Avaliado em 2026-06-04 (dúvida levantada na revisão do spec): o `@google/genai`
suporta function calling nativo, mas a v1 **mantém classify→dispatch**:
1 chamada LLM por mensagem (~810ms), números/voz 100% determinísticos via
`voice.ts` (LLM formatando resultado financeiro = risco de valor alucinado),
e o harness de testes atual continua válido. Reafirma a decisão de 2026-05-30
(Nível 1.5). **Gatilho de revisita:** se o smoke mostrar a acurácia de
classificação degradando com 9 intents, adotar **function calling como
transporte da classificação** (modelo escolhe 1 tool, código executa e
renderiza) — upgrade de encanamento, não de arquitetura. Agente com loop de
tools só se surgirem interações multi-etapa que o histórico não resolve, e
com confirmação obrigatória pra ações de escrita.

## Registro em dois níveis

O contexto do Gemini já distingue `registered` de `hasPix`:
- **Gastos (anotar/consultar):** exige só **nome**. Quem chega só pra anotar
  gastos não entrega chave PIX.
- **Racha e fiado:** exigem PIX (cobrança sai no nome do dono) — como hoje.

## Schema

```sql
ALTER TABLE bills ADD COLUMN kind TEXT NOT NULL DEFAULT 'split';
-- 'split' | 'debt'; guard de idempotência via pragma table_info

CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT PRIMARY KEY,            -- ULID gerado na aplicação (como bills)
  owner_phone TEXT NOT NULL REFERENCES users(phone),
  amount      REAL NOT NULL,
  description TEXT NOT NULL,
  category    TEXT NOT NULL,               -- enum validado na aplicação (inglês)
  spent_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_owner_date ON expenses(owner_phone, spent_at);
```

Bills existentes em prod viram `'split'` pelo DEFAULT. Sem migração de dados.

## Categorias

- **Armazenamento em inglês** (decisão explícita):
  `groceries | food | transport | home | leisure | health | bills | other`
- **Gemini extrai a categoria automaticamente** da mensagem (usuário não
  informa): "gastei 25 no mercado" → `groceries`; "ifood de 40" → `food`.
  O schema de structured output restringe ao enum; valor fora do enum é
  coagido pra `other` na aplicação (validação dupla).
- **Exibição em PT-BR** mapeada na voice: groceries→mercado, food→comida,
  transport→transporte, home→casa, leisure→lazer, health→saúde,
  bills→contas, other→outros.

## Períodos e timezone

"hoje/semana/mês" calculados em **America/Sao_Paulo** (lição do bug de
timezone da Cumbuca — fronteira de dia é BRT, não UTC). Definições:
`today` = dia corrente BRT; `week` = desde segunda-feira da semana corrente;
`month` = desde o dia 1 do mês corrente (períodos-calendário, não janelas
móveis de 7/30 dias).

## Voz e fluxos (voice.ts, fonte única)

- **Gasto:** "Anotado: R$25 — mercado. Hoje já foram R$80." (total do dia =
  1 query barata; cria hábito).
- **Dívida:** "Anotei: Roberto te deve R$100" + PIX da cobrança na sequência
  (encaminhável, mesmo padrão do racha).
- **Consulta:** total do período + lista compacta (data — descrição — valor).
- **list_bills:** seções "Rachas abertos" / "Te devem".
- **Capability/onboarding:** "anoto gastos, controlo quem te deve e divido
  contas" (substitui o posicionamento só-racha).

## Landing

Headline e features repositionadas (assistente de dinheiro no WhatsApp).
CTAs `wa.me` intocadas. Copy é tweak trivial → direto na main.

## Métricas de validação

Script `npm run metrics` (read-only no SQLite): novos usuários/semana,
**% com 2º uso em ≤14 dias** (métrica-mãe da validação), uso por intent
(qual feature domina → decide v2), volume de `unknown_intents` (radar de
falha de classificação).

## Testes (TDD — política vigente p/ fluxo de dinheiro/conversa)

Integração com Gemini stubado + SQLite efêmero:
- gasto: registro, categorias coagidas, fronteiras de período em BRT;
- consulta: today/week/month, vazio;
- dívida: registra → lista → mark_paid → fecha; PIX enviado;
- fallback zero-participantes → gasto;
- registro dois níveis: sem PIX pode gasto, racha/fiado bloqueia e pede PIX;
- regressão: os 47 testes existentes seguem verdes.

Acurácia de classificação real (incl. categoria) = smoke ao vivo, como sempre.

## Rollout

Dois PRs pequenos (review + smoke do Danubio por PR):
1. **`feat/expenses`** — tabela + intents de gasto + voz + testes (isolado).
2. **`feat/debts`** — coluna `kind` + `register_debt` + voz de dívida +
   `list_bills` agrupado + testes.

Processo: implementação direta deste spec com TDD, sem doc de plano separado
(padrão do PR #13). Landing copy + script de métricas acompanham a onda
(commits triviais ou carona no PR 2).
