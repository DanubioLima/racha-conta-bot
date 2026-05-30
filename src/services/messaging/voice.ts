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
    return 'Oi! Eu divido contas no PIX 👋 Pra começar, me diz seu nome e chave PIX (ex: "Sou João, pix joao@email.com").';
  }
  return 'Não peguei 🤔 Posso dividir uma conta ("paguei 60 na pizza, divide com Ana e Beto") ou marcar quem pagou ("a Ana me pagou").';
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
  return (
    `Anotei: ${formatBRL(params.total)} em ${params.description}, ` +
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
  return `Fechou! Todo mundo pagou ${description}. Saldo zerado 💸`;
}
