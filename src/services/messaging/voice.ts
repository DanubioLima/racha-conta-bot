// src/services/messaging/voice.ts
//
// Fonte única da VOZ do Slice — toda cópia determinística voltada ao usuário.
//
// PERSONA (mantenha o tom ao editar; a mesma persona vive no prompt do Gemini,
// em src/services/llm/prompt.ts): Slice é caloroso, brasileiro, direto. Fala
// como amigo que resolve, não como atendente de robô. Frases curtas (é
// WhatsApp). No máximo 1 emoji por mensagem (às vezes nenhum). O exemplo de
// formato ("paguei 60 na pizza, divide com Ana e Beto") é ferramenta de ENSINO:
// só nos gates de cadastro/PIX, na confirmação pós-cadastro e no fallback de
// confusão real. Nunca como resposta pra tudo.

import type { ExpenseCategory, ExpensePeriod } from '../expenses/expense.types.js';

export function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// "João" | "Ana e Beto" | "Ana, Beto e Carla"
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

// ---- Conversa: fallback determinístico (quando o reply do Gemini falha) ----

export interface FallbackContext {
  registered: boolean;
}

export function fallbackReply(ctx: FallbackContext): string {
  if (!ctx.registered) {
    return 'Oi! Eu anoto seus gastos e divido contas no PIX 👋 Pra começar, me diz seu nome e chave PIX (ex: "Sou João, pix joao@email.com").';
  }
  return 'Não peguei 🤔 Posso anotar um gasto ("gastei 25 no mercado"), dividir uma conta ("paguei 60 na pizza, divide com Ana e Beto") ou marcar quem pagou ("a Ana me pagou").';
}

export function instability(): string {
  return 'Eita, tive uma instabilidade aqui 😅 Manda sua mensagem de novo daqui a pouquinho?';
}

// ---- Gates de cadastro ----

export function askForName(): string {
  return 'Pra começar preciso do seu nome 🙂 Manda algo tipo "Sou João, pix joao@email.com".';
}

export function askToRegister(): string {
  return 'Pra dividir essa conta eu preciso te conhecer primeiro 🙂 Me diz seu nome e chave PIX (ex: "Sou João, pix joao@email.com").';
}

export function askForPix(name: string): string {
  return `Falta só sua chave PIX, ${name}! Manda algo tipo "pix joao@email.com" que eu gero as cobranças.`;
}

// ---- Confirmações de cadastro ----

export function welcomeNeedPix(name: string): string {
  return `Prazer, ${name}! 😄 Agora me manda sua chave PIX (ex: "pix seu@email.com") pra eu gerar as cobranças.`;
}

export function welcomeReady(name: string): string {
  return `Show, ${name}! Tá tudo certo ✅ Manda uma conta tipo "paguei 60 na pizza, divide com Ana e Beto" que eu cuido do resto.`;
}

export function pixSaved(): string {
  return 'Chave PIX salva! 🎉 Pode mandar a conta agora (ex: "paguei 60 na pizza, divide com Ana e Beto").';
}

export function profileUpdated(): string {
  return 'Atualizei seus dados 👍';
}

// ---- Confirmações de dinheiro ----

export function billCreatedHeadline(params: {
  total: number;
  description: string;
  amountPerPerson: number;
  participantNames: string[];
}): string {
  const names = joinNames(params.participantNames);
  const where = params.description ? ` em ${params.description}` : '';
  return (
    `Anotei: ${formatBRL(params.total)}${where}, ` +
    `${formatBRL(params.amountPerPerson)} pra cada. Te mando o PIX de ${names} 👇`
  );
}

// Pré-condição: `remainingNames` é não-vazio. Quando o último pagou, a conta
// fecha e o chamador usa `billClosed` em vez desta — senão sairia "Ainda falta: .".
export function paymentReceived(params: {
  paidName: string;
  paidAmount: number;
  remainingNames: string[];
}): string {
  return (
    `${params.paidName} pagou ${formatBRL(params.paidAmount)}! 💰 ` +
    `Ainda falta: ${joinNames(params.remainingNames)}.`
  );
}

export function billClosed(description: string): string {
  const what = description ? description : 'a conta';
  return `Fechou! Todo mundo pagou ${what}. Saldo zerado 💸`;
}

export function billExpired(description: string, pendingNames: string[]): string {
  const what = description ? `Conta "${description}"` : 'Conta';
  const tail = pendingNames.length > 0 ? ` Pendentes: ${pendingNames.join(', ')}.` : '';
  return `⏱️ ${what} expirou após 7 dias.${tail}`;
}

// ---- Gastos ----

// Categorias são armazenadas em inglês (enum em expense.types.ts); o usuário
// só vê os rótulos em português daqui.
const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  groceries: 'mercado',
  food: 'comida',
  transport: 'transporte',
  home: 'casa',
  leisure: 'lazer',
  health: 'saúde',
  bills: 'contas',
  other: 'outros',
};

// Gasto não gera cobrança — só o nome basta, diferente do askToRegister (conta).
export function askForNameToTrack(): string {
  return 'Pra anotar seus gastos eu só preciso do seu nome 🙂 Manda algo tipo "Sou João".';
}

export function expenseLogged(params: {
  amount: number;
  category: ExpenseCategory;
  todayTotal: number;
}): string {
  const label = EXPENSE_CATEGORY_LABELS[params.category];
  return `Anotado: ${formatBRL(params.amount)} — ${label}. Hoje já foram ${formatBRL(params.todayTotal)}.`;
}

const PERIOD_HEADERS: Record<ExpensePeriod, string> = {
  today: 'Gastos de hoje',
  week: 'Gastos da semana',
  month: 'Gastos do mês',
};

const PERIOD_EMPTY_LABELS: Record<ExpensePeriod, string> = {
  today: 'hoje',
  week: 'nesta semana',
  month: 'neste mês',
};

// Dia/mês no fuso do usuário (BRT), não em UTC.
function formatDayMonth(isoUtc: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(isoUtc));
}

export function expensesSummary(params: {
  period: ExpensePeriod;
  total: number;
  items: { spentAt: string; description: string; amount: number }[];
}): string {
  if (params.items.length === 0) {
    return `Nenhum gasto anotado ${PERIOD_EMPTY_LABELS[params.period]} 🎉`;
  }
  const lines = params.items.map(
    (item) => `• ${formatDayMonth(item.spentAt)} — ${item.description} — ${formatBRL(item.amount)}`,
  );
  return `${PERIOD_HEADERS[params.period]}: ${formatBRL(params.total)}\n${lines.join('\n')}`;
}

// ---- Listagem de contas em aberto ----

// Resumo compacto das contas ABERTAS do dono (1 linha por conta). Recebe um shape
// mínimo pra não acoplar voice.ts ao tipo Bill. Normalmente toda conta OPEN tem ao
// menos 1 pendente, mas uma conta sem participantes (ex: "divide uma conta de 20"
// sem citar ninguém) fica OPEN com pending vazio — nesse caso, só o rótulo, sem o
// "(faltam 0: )" quebrado.
export function openBillsList(
  bills: { description: string; total: number; pending: string[] }[],
): string {
  if (bills.length === 0) return 'Você não tem nenhuma conta em aberto 🎉';
  const lines = bills.map((bill) => {
    const label = bill.description
      ? `${bill.description} — ${formatBRL(bill.total)}`
      : formatBRL(bill.total);
    if (bill.pending.length === 0) return `• ${label}`;
    const missing =
      bill.pending.length === 1
        ? `falta ${bill.pending[0]}`
        : `faltam ${bill.pending.length}: ${bill.pending.join(', ')}`;
    return `• ${label} (${missing})`;
  });
  return `Suas contas em aberto:\n${lines.join('\n')}`;
}

// ---- Encerrar / quitar conta inteira ----

export function noOpenBillsToClose(): string {
  return 'Você não tem nenhuma conta em aberto pra fechar.';
}

export function askWhichBill(openDescriptions: string[]): string {
  return `Qual conta? Em aberto: ${openDescriptions.join(', ')}.`;
}

export function billNotFound(reference: string, openDescriptions: string[]): string {
  return `Não achei a conta "${reference}". Em aberto: ${openDescriptions.join(', ')}.`;
}

// Encerrar (não finge pagamento). Pré-condição: chamada só quando já confirmado ou
// sem pendente — quem decide pedir confirmação é o serviço.
export function billClosedManually(description: string): string {
  return `Encerrei a conta ${description || 'em aberto'} ✅`;
}

export function billsClosedAll(count: number): string {
  const what = count === 1 ? 'sua conta em aberto' : `suas ${count} contas em aberto`;
  return `Encerrei ${what} ✅`;
}

export function confirmCloseWithPending(description: string, pendingNames: string[]): string {
  return `A conta ${description || 'em aberto'} ainda tem ${joinNames(pendingNames)} sem pagar. Fecho assim mesmo? (responde "sim")`;
}

export function confirmCloseAllWithPending(): string {
  return 'Tem conta com gente ainda devendo. Fecho TODAS assim mesmo? (responde "sim")';
}

export function billPaidWhole(description: string): string {
  return `Boa! A conta ${description || 'em aberto'} foi paga, todo mundo quitou 💸`;
}
