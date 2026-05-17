# Contexto do Projeto: Racha-Conta Inteligente (Zero UI)
Você é um Engenheiro de Software Sênior especialista em Node.js, TypeScript e Integrações de APIs. Seu objetivo é me ajudar a criar um MVP funcional nas próximas horas para auto-validação.

## Stack Técnica
- Runtime: Node.js 24 com TypeScript
- Interface: WhatsApp (via Webhooks da API do Evolution)
- Fonte de Dados Financeiros: Cumbuca MCP (Open Finance) (https://mcp.cumbuca.com/mcp)
- Banco de Dados: Schema flexível (MongoDB, Firestore ou arquivo JSON local)

## Foco Principal: Usabilidade e Fluxo Conversacional
O app não tem interface gráfica. Tudo acontece por chat no WhatsApp comigo mesmo. O fluxo de estados deve seguir rigidamente a usabilidade abaixo:

### Passo 1: O Gatilho Passivo (Polling)
- Crie um script que roda em background (use um `setInterval` de 2 minutos para o MVP).
- O script consulta as últimas transações de saída usando a ferramenta do MCP da Cumbuca.
- Ao detectar uma nova transação com categoria provável de alimentação/lazer, ele salva o estado como PENDENTE_CORTE e envia uma mensagem no meu WhatsApp via Evolution API:
  *"Vi que você pagou R$ [Valor] no [Estabelecimento]. Quer dividir essa conta?"*

### Passo 2: A Tomada de Decisão (Apenas Eu respondo)
- Se eu responder "Não", o status muda para ARQUIVADO e o fluxo encerra.
- Se eu responder "Sim", o bot pergunta: *"Com quem e em quantas pessoas?"*.
- Eu devo poder responder em linguagem natural (ex: "Em 3 pessoas: eu, João e Maria" ou "Divide por 4").
- Use uma LLM interna (OpenAI ou Gemini API) para processar essa resposta, extrair o número de fatias, calcular o valor exato por pessoa e gerar os códigos PIX Copia e Cola correspondentes.

### Passo 3: O Monitoramento de Cobrança (A Máquina de Estados)
- Salve no banco NoSQL a estrutura da conta ativa:
  {
    id: "id_da_transacao",
    local: "Pizzaria",
    total_amount: 120.00,
    value_per_person: 40.00,
    status: "OPEN",
    members: [
      { name: "João", paid: false },
      { name: "Maria", paid: false }
    ]
  }
- O loop de background agora também passa a monitorar as transações de *entrada* na minha conta.
- Se entrar um PIX com o valor exato de `value_per_person`, o sistema tenta cruzar com o nome do pagador (retornado pelos metadados da Cumbuca) e atualiza o participante para `paid: true`.
- O bot me avisa: *"João pagou! 40 reais recebidos. Falta apenas a Maria."*

### Passo 4: O Fechamento
- Quando todos os participantes estiverem com `paid: true`, mude o status da conta para FECHADA.
- Envie a mensagem final: *"Boa! Todos pagaram a conta do [Estabelecimento]. Saldo zerado! 💸"*

## Próximos Passos Imediatos
Crie a estrutura inicial de pastas do projeto, instale as dependências básicas (dotenv, axios) e escreva o esqueleto do arquivo principal (`server.ts`) configurando as rotas de entrada para o webhook da Evolution API e o loop do cron individual.

A ideia agora não é ter algo production-ready e sim uma estrutura que me permita validar o mais rápido possível com minha conta bancária. Pode criar um .gitgnore, mas não precisa commitar nada no momento nem se preocupar com abrir PRs. 

Antes de começar pesquise na internet o máximo que puder sobre o mcp da cumbuca e a evolution API.
