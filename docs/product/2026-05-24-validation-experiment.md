# Slice — Validation Experiment

**Status:** approved (design phase) — execution pending
**Date:** 2026-05-24
**Author:** Danubio + Claude (brainstorm)
**Duration:** 2-3 semanas
**Purpose:** Validar com usuários reais se o Slice tem demanda + retenção
suficientes pra justificar investimento em multi-user proper + roadmap de
produto.

---

## 1. Por que esse experimento, por que agora

MVP técnico fechou — smoke ponta-a-ponta com PIX real reconciliado em
2026-05-24 BRT. Stack roda 24/7 em produção. Próxima decisão importante
é **se investir em multi-user**, em comandos admin, em SQLite, etc., **OU
se a hipótese de produto não se confirma e o trabalho fica como side-project
técnico**.

Antes de gastar 3-4 semanas construindo multi-user proper, validar com
~5-10 pessoas reais se há pain + uso recorrente + sinal de WTP. Custo
deste experimento: ~3h-5h/semana do Danubio por 3 semanas.

## 2. Hipóteses a testar (em ordem de importância)

1. **Pain real**: as pessoas têm fricção repetida com rachar conta na
   vida real (não só acham a ideia legal no abstrato)
2. **Solução resolve a fricção**: depois de ver Slice em ação, a pessoa
   entende e quer usar novamente
3. **Frequência justifica produto**: a pessoa racha conta pelo menos
   1-2x/semana (senão não tem hábito, vira "uso 1x e esquece")
4. **WTP existe**: alguma sinalização de "eu pagaria R$X/mês" ou
   "indicaria pra outros sem incentivo"

Experimento cobre 1-2 fortemente, 3 medianamente, 4 fracamente (3
semanas é pouco pra 3-4). Suficiente pra decisão go/no-go de multi-user.

## 3. Método: Concierge + Self-serve-lite

**Fase A — Concierge (primeira interação de cada tester):** Danubio
opera o Slice na frente do tester durante um rolê real. Tester vivencia
como participante pagador ou observador do organizador.

**Fase B — Self-serve-lite (segunda interação em diante):** Tester usa
o bot diretamente, sem Danubio presente (depende do multi-user-lite —
escopo separado, ver §8).

**Por que essa mistura:**
- Concierge: zero código novo, começa amanhã, demo controlada → testa
  entendimento e reação ao valor
- Self-serve-lite: tester opera sozinho → testa onboarding, retenção
  espontânea, "lembra de usar de novo"

## 4. Recrutamento

**Alvo:** 5-10 testers ao longo de 3 semanas (conversão esperada de 50%
de uma lista de 15-20 candidatos).

**Perfil ideal:**
- Sai com grupo (3+ pessoas) pelo menos 2-3x/mês
- Mistura de gêneros, idades (25-45), profissões fora de tech
- Pessoas que recentemente pagaram conta pra grupo (você lembra de
  alguém específico)
- Pelo menos 2 organizadores frequentes ("o que paga e depois cobra") +
  3-5 pagadores frequentes ("o que sempre deve pra alguém")

**Quem evitar:**
- Família próxima muito alinhada (vai dizer "legal!" por afeição)
- Devs amigos (vão falar de tech, não de UX/pain)
- Pessoas que só saem 1x/mês (frequência não dá pra validar retenção em
  3 semanas)

## 5. Protocolo (4 touchpoints por tester)

### Touchpoint 1: convite (5 min, WhatsApp ou ligação)

Script:
> "Tenho um experimento meio nerd. Construí um botzinho que ajuda a
> dividir conta de grupo no WhatsApp — você manda 'paguei 60 na pizza,
> divide com fulano' e ele já gera os PIX certos e fica de olho se
> pagaram. Quero testar com gente real esses dias. Topa testar quando
> rolar um rolê?"

Coleta: aceitou ou não, e por quê. **Os "não" são tão informativos
quanto os "sim".** Pessoa que diz "ah não, eu uso Splitwise" → puxa o
fio, entende uso atual.

### Touchpoint 2: primeiro uso em concierge (rolê real)

Quando o cenário acontece organicamente:

1. Você paga a conta
2. Roda o Slice na frente do tester (mostra a tela enquanto digita)
3. Encaminha o PIX-copia-cola pro tester explicando "o bot mandou"
4. Tester paga
5. Quando bot manda "Fechou!", mostra pro tester

**Observa silenciosamente:** ele entendeu rápido? Achou natural? Reclamou
de algo? Comentou positivamente?

**Notes IMEDIATAMENTE depois** do rolê (não confia em memória).

### Touchpoint 3: follow-up (1-2 dias depois, 15 min)

Perguntas na ordem:
1. **"O que aconteceu desde então?"** — deixa narrativa fluir; o que ele
   menciona primeiro é o que mais marcou
2. **"Você dividiria sua próxima conta usando? Como?"** — testa intenção
   concreta
3. **"Se eu te desse acesso pra você usar sozinho amanhã, você usaria?
   Em quê?"** — testa adoção self-serve hipotética
4. **"Quanto você acha que valeria isso, se fosse pagar?"** — nunca
   "você pagaria R$X?"; deixa ele ancorar
5. **"O que ficou estranho ou faltou?"** — UX, expectativa quebrada

Anota verbatim. Quotes literais são gold.

### Touchpoint 4: segundo uso em self-serve (~1-2 semanas depois)

Depois que multi-user-lite estiver de pé (§8), onboarda o tester pra
usar diretamente. Se rolar outro cenário com ele:

- Não interferir. Deixar ele dirigir
- Observar de longe (logs do bot mostram o que ele faz)
- Pergunta no fim: "Você se lembrou do bot na hora ou eu que sugeri?"
- Sinal mais valioso: **tester PEDIU pra usar de novo, OU achou natural
  você sugerir**

## 6. Métricas

### Quantitativo (planilha simples — Google Sheets ou Notion)

Colunas por tester:
- Touchpoint 1 (convite): aceitou? por quê não?
- Touchpoint 2 (primeiro uso): data, contexto, reação inicial
- Touchpoint 3 (follow-up): intenção declarada, WTP ancorado, principal
  objeção
- Touchpoint 4 (self-serve): houve segundo uso? quantos? espontâneo ou
  sugerido?
- Bills criadas no período (verificar via logs do bot)

### Qualitativo (notes por tester em markdown ou doc)

Por tester:
- Quotes literais (não parafrasear)
- Objeções vs alternativas (Splitwise, planilha, PIX manual no zap)
- Sugestões espontâneas
- Reação corporal/tom quando viu funcionar (entusiasmo? confusão?
  desinteresse?)

## 7. Critérios de decisão (após 3 semanas)

### 🟢 Verde — investir em multi-user proper e seguir roadmap de produto

- 5+ testers usaram pelo menos 1x
- 3+ mencionaram positivamente em conversa **fora** dos touchpoints
- 2+ pediram acesso self-serve **sem você sugerir**
- Quotes claros como "isso eu usaria todo final de semana"

### 🟡 Amarelo — pivotar framing ou refazer experimento

- Testers acharam legal mas não viraram retorno espontâneo
- Pain real existe mas alternativas competem mais do que esperado
- Iterar: o que ajustar antes de tentar de novo (proposta de valor,
  recrutamento, momento de demo)

### 🔴 Vermelho — não construir multi-user proper

- Testers usaram por educação, sem entusiasmo
- Comparações saem favoráveis pras alternativas
- WTP zero ou irrelevante
- Conclusão: Slice fica como portfólio técnico + uso pessoal, mas não
  vira startup

## 8. Pré-requisito de código: multi-user-lite

Pra viabilizar Touchpoint 4 (self-serve sem Danubio presente) sem
construir multi-user completo, escopo mínimo necessário:

- Allowlist de números autorizados (não mais um único `USER_WHATSAPP_NUMBER`)
- PIX por user (cada tester recebe PIX no nome dele, não no Danubio)
- Bills com `owner_phone` field
- Bot responde **pro sender** (não sempre pro Danubio)
- Scanner Cumbuca permanece **só do Danubio** (testers não têm
  auto-reconciliação — ok pra validação, reconciliação manual no
  follow-up; é o trade-off pra evitar 1+ semana de Cumbuca multi-tenant)

Spec detalhada do escopo + plano de implementação fica em arquivo
separado (`docs/superpowers/specs/2026-05-24-multiuser-lite.md` e plan
correspondente). Custo estimado: 1 dia de dev.

## 9. Antes de começar — checklist pré-experimento

Esta semana:

- [ ] Lista de 15-20 candidatos com perfil anotado (organizador?
      pagador? frequência social?)
- [ ] Mapa de cenários potenciais: rolês que você JÁ tem nas próximas
      2-3 semanas (jantar com X, viagem Y, festa Z) → onde plug-ar o
      Slice naturalmente
- [ ] Template de notas (Notion ou doc) com colunas pra anotar
      consistente em cada touchpoint
- [ ] Onboarding-de-tester verbalizado: explicar pra alguém sem
      contexto técnico em 30 seg — "É tipo um Splitwise via WhatsApp
      que sabe quando o pagamento entra na minha conta". Pratica em voz
      alta
- [ ] Multi-user-lite implementado (§8) — destrava Touchpoint 4
- [ ] **NÃO codifica features de roadmap.** Resista. Investe ZERO em
      features até o experimento fechar

## 10. Aviso importante sobre vieses

Concierge tem **um viés perigoso**: você presente faz o produto parecer
melhor do que é. Pessoas reagem ao SEU entusiasmo + ao SEU controle do
contexto.

Mitigações:
- Nas perguntas, peso maior pra "você usaria sozinho" do que "você gostou
  comigo aqui"
- Forçar pelo menos um tester a usar SEM você presente (mandar PIX de
  outro rolê seu, sem demonstrar; sinal mais limpo da percepção real
  dele)
- Quando tester elogia, perguntar "o que especificamente?" — elogio
  vago ("legal!") é menos sinal do que elogio específico ("achei massa
  que ele soube que ela pagou sem eu olhar a conta")

## 11. Próximas decisões pós-experimento

Independente do veredito:

- Se 🟢: escrever spec do multi-user proper (auth, Cumbuca per-user,
  data isolation, billing model)
- Se 🟡: re-rodar com ajustes — testers diferentes, framing
  diferente, ou produto ajustado
- Se 🔴: arquivar como portfólio + uso pessoal contínuo (o bot
  funciona, você usa, fim)

Em qualquer cenário, ATUALIZAR memória do projeto com o aprendizado pra
não esquecer o que descobriu.
