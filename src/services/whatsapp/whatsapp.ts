import axios from 'axios';
import { env } from '../../config/env.js';

// Thin WhatsApp client. The underlying provider is the Evolution API + Baileys,
// but that's an implementation detail — everything outside this module talks
// in terms of "send a WhatsApp message" / "did the bot send this?".
const client = axios.create({
  baseURL: env.evolutionApiUrl,
  headers: {
    'Content-Type': 'application/json',
    apikey: env.evolutionApiKey,
  },
  timeout: 10_000,
});

// We need to distinguish bot-sent echoes from user-typed messages when the
// user messages their own number. We cache both the message id (returned by
// the send call) and the text (covers the race where MESSAGES_UPSERT fires
// before the HTTP response lands).
const SENT_CACHE_MAX = 500;
const TEXT_TTL_MS = 5 * 60 * 1000;

const sentIds = new Set<string>();
const sentTexts = new Map<string, number>();

function rememberSentId(id: string): void {
  if (sentIds.size >= SENT_CACHE_MAX) {
    const oldest = sentIds.values().next().value;
    if (oldest) sentIds.delete(oldest);
  }
  sentIds.add(id);
}

function rememberSentText(text: string): void {
  const now = Date.now();
  sentTexts.set(text, now);
  for (const [t, ts] of sentTexts) {
    if (now - ts > TEXT_TTL_MS) sentTexts.delete(t);
  }
}

export function wasSentByBot(
  id?: string | null,
  text?: string | null,
): boolean {
  if (id && sentIds.has(id)) return true;
  if (text && sentTexts.has(text)) return true;
  return false;
}

export async function sendText(to: string, text: string): Promise<void> {
  const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  console.log('[whatsapp] sendText →', { to, preview });
  // Remember the text BEFORE the network call so the webhook race is covered
  // even if the provider emits the upsert before our HTTP call resolves.
  rememberSentText(text);
  try {
    const res = await client.post(
      `/message/sendText/${env.evolutionInstance}`,
      {
        number: to,
        text,
      },
    );
    const id = res.data?.key?.id;
    if (typeof id === 'string') rememberSentId(id);
    console.log('[whatsapp] sendText ok', { id });
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? (err.response?.data ?? err.message)
      : err;
    console.error('[whatsapp] sendText failed', detail);
    throw err;
  }
}

export async function sendImage(
  to: string,
  base64: string,
  caption?: string,
): Promise<void> {
  const preview = caption
    ? caption.length > 80
      ? `${caption.slice(0, 80)}…`
      : caption
    : '(no caption)';
  console.log('[whatsapp] sendImage →', { to, caption: preview });
  // We track sent images by their caption text (when present). Even if a
  // caption-less echo lands, it has no text to confuse the LLM, so the worst
  // case is a stray webhook entry — never a duplicate reply.
  if (caption) rememberSentText(caption);
  try {
    const res = await client.post(
      `/message/sendMedia/${env.evolutionInstance}`,
      {
        number: to,
        mediatype: 'image',
        mimetype: 'image/png',
        media: base64,
        fileName: 'pix.png',
        caption,
      },
    );
    const id = res.data?.key?.id;
    if (typeof id === 'string') rememberSentId(id);
    console.log('[whatsapp] sendImage ok', { id });
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? (err.response?.data ?? err.message)
      : err;
    console.error('[whatsapp] sendImage failed', detail);
    throw err;
  }
}

// Convenience for the single-user MVP: send to USER_WHATSAPP_NUMBER.
export function notifyUser(text: string): Promise<void> {
  return sendText(env.userWhatsappNumber, text);
}

export function notifyUserImage(base64: string, caption?: string): Promise<void> {
  return sendImage(env.userWhatsappNumber, base64, caption);
}
