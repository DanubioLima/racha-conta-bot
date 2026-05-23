import axios from 'axios';
import { env } from '../../config/env.js';
import type {
  SendTextPayload,
  SendTemplatePayload,
  SendMessageResponse,
} from './cloudapi.types.js';

const META_API_BASE = 'https://graph.facebook.com/v21.0';
const HTTP_TIMEOUT_MS = 30_000;

const client = axios.create({
  baseURL: META_API_BASE,
  timeout: HTTP_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
  },
});

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${env.whatsappAccessToken}` };
}

function messagesEndpoint(): string {
  return `/${env.whatsappPhoneNumberId}/messages`;
}

export async function sendText(to: string, body: string): Promise<string> {
  const payload: SendTextPayload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  };
  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
  console.log('[whatsapp] sendText →', { to, preview });
  try {
    const response = await client.post<SendMessageResponse>(messagesEndpoint(), payload, {
      headers: authHeader(),
    });
    const id = response.data.messages?.[0]?.id ?? '';
    console.log('[whatsapp] sendText ok', { id });
    return id;
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? (err.response?.data ?? err.message)
      : err;
    console.error('[whatsapp] sendText failed', detail);
    throw err;
  }
}

export interface TemplateBodyArgs {
  templateName: string;
  languageCode?: string;
  bodyParameters: string[];
}

export async function sendTemplate(to: string, args: TemplateBodyArgs): Promise<string> {
  const payload: SendTemplatePayload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: args.templateName,
      language: { code: args.languageCode ?? 'pt_BR' },
      components: args.bodyParameters.length > 0 ? [{
        type: 'body',
        parameters: args.bodyParameters.map((text) => ({ type: 'text', text })),
      }] : undefined,
    },
  };
  console.log('[whatsapp] sendTemplate →', {
    to,
    template: args.templateName,
    parameters: args.bodyParameters.length,
  });
  try {
    const response = await client.post<SendMessageResponse>(messagesEndpoint(), payload, {
      headers: authHeader(),
    });
    const id = response.data.messages?.[0]?.id ?? '';
    console.log('[whatsapp] sendTemplate ok', { id, template: args.templateName });
    return id;
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? (err.response?.data ?? err.message)
      : err;
    console.error('[whatsapp] sendTemplate failed', detail);
    throw err;
  }
}
