import twilio from 'twilio';
import { env } from '../../config/env.js';
import { toBrazilWhatsAppAddress } from '../../lib/phone.js';

// Cliente fino do WhatsApp. Provider real é a Twilio (API oficial). Quem está fora
// deste módulo fala em termos de "manda uma mensagem" e passa o telefone na forma
// interna normalizada — a tradução pro endereço whatsapp:+E.164 vive aqui.
let client: ReturnType<typeof twilio> | null = null;
function twilioClient(): ReturnType<typeof twilio> {
  // Lazy: importar este módulo (em testes, no boot) não exige credenciais válidas.
  if (!client) client = twilio(env.twilioAccountSid, env.twilioAuthToken);
  return client;
}

// O PIX copia-e-cola (BR Code) embute a chave PIX + dados do recebedor — nunca
// vai pro log. Mensagens normais logam um preview curto pra debug.
function logPreview(text: string): string {
  if (/br\.gov\.bcb\.pix/i.test(text)) return '[pix payload redacted]';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export async function sendText(to: string, text: string): Promise<void> {
  console.log('[whatsapp] sendText →', { to, preview: logPreview(text) });
  try {
    const message = await twilioClient().messages.create({
      from: env.twilioWhatsAppFrom,
      to: toBrazilWhatsAppAddress(to),
      body: text,
    });
    console.log('[whatsapp] sendText ok', { sid: message.sid });
  } catch (err) {
    console.error('[whatsapp] sendText failed', err);
    throw err;
  }
}
