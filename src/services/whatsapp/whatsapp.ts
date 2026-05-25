import axios from 'axios';
import { env } from '../../config/env.js';

// Cliente fino do WhatsApp. Provider real é Evolution API + Baileys — quem está
// fora deste módulo fala em termos de "manda uma mensagem".
const client = axios.create({
  baseURL: env.evolutionApiUrl,
  headers: { 'Content-Type': 'application/json', apikey: env.evolutionApiKey },
  timeout: 10_000,
});

// O PIX copia-e-cola (BR Code) embute a chave PIX + dados do recebedor — nunca
// vai pro log. Mensagens normais logam um preview curto pra debug.
function logPreview(text: string): string {
  if (/br\.gov\.bcb\.pix/i.test(text)) return '[pix payload redacted]';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export async function sendText(to: string, text: string): Promise<void> {
  console.log('[whatsapp] sendText →', { to, preview: logPreview(text) });
  try {
    const res = await client.post(`/message/sendText/${env.evolutionInstance}`, { number: to, text });
    console.log('[whatsapp] sendText ok', { id: res.data?.key?.id });
  } catch (err) {
    const detail = axios.isAxiosError(err) ? (err.response?.data ?? err.message) : err;
    console.error('[whatsapp] sendText failed', detail);
    throw err;
  }
}

export async function sendImage(to: string, base64: string, caption?: string): Promise<void> {
  console.log('[whatsapp] sendImage →', { to, caption: caption?.slice(0, 80) ?? '(no caption)' });
  try {
    const res = await client.post(`/message/sendMedia/${env.evolutionInstance}`, {
      number: to, mediatype: 'image', mimetype: 'image/png', media: base64, fileName: 'pix.png', caption,
    });
    console.log('[whatsapp] sendImage ok', { id: res.data?.key?.id });
  } catch (err) {
    const detail = axios.isAxiosError(err) ? (err.response?.data ?? err.message) : err;
    console.error('[whatsapp] sendImage failed', detail);
    throw err;
  }
}
