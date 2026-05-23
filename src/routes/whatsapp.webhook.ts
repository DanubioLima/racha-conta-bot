import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { extractBillFromText } from '../services/llm/gemini.js';
import {
  createBillFromExtraction,
  notifyUnknown,
} from '../services/bills/bill.service.js';
import { recordInboundFromUser } from '../services/whatsapp/window.js';
import type {
  MetaWebhookBody,
  MetaWebhookMessage,
} from '../services/whatsapp/cloudapi.types.js';

function normalizeBrNumber(num: string): string {
  const digits = num.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') {
    return digits.slice(0, 4) + digits.slice(5);
  }
  return digits;
}

function numbersMatch(a: string, b: string): boolean {
  return normalizeBrNumber(a) === normalizeBrNumber(b);
}

function verifyMetaSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', env.whatsappAppSecret)
    .update(rawBody, 'utf8')
    .digest('hex');
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader),
  );
}

function collectMessages(body: MetaWebhookBody): MetaWebhookMessage[] {
  const messages: MetaWebhookMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) {
        messages.push(message);
      }
    }
  }
  return messages;
}

function extractText(message: MetaWebhookMessage): string | null {
  if (message.type === 'text' && message.text?.body) return message.text.body;
  return null;
}

export function registerWhatsAppWebhook(app: FastifyInstance): void {
  // -------- GET: verificação inicial pelo Meta --------
  app.get(
    '/webhooks/whatsapp',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, string | undefined>;
      const mode = query['hub.mode'];
      const token = query['hub.verify_token'];
      const challenge = query['hub.challenge'];
      if (mode === 'subscribe' && token === env.whatsappVerifyToken && challenge) {
        console.log('[webhook] verification ok');
        reply.type('text/plain').send(challenge);
        return;
      }
      console.warn('[webhook] verification failed', { mode, tokenMatches: token === env.whatsappVerifyToken });
      reply.code(403).send();
    },
  );

  // -------- POST: entrega de mensagens --------
  app.post(
    '/webhooks/whatsapp',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = (request as { rawBody?: string }).rawBody;
      if (!rawBody) {
        console.error('[webhook] missing rawBody — parser misconfigured');
        return reply.code(500).send();
      }
      const signature = request.headers['x-hub-signature-256'];
      const signatureValue = Array.isArray(signature) ? signature[0] : signature;
      if (!verifyMetaSignature(rawBody, signatureValue)) {
        console.warn('[webhook] HMAC verification failed');
        return reply.code(401).send();
      }

      const body = request.body as MetaWebhookBody;
      if (body.object !== 'whatsapp_business_account') {
        console.log('[webhook] ignored: wrong object type', { object: body.object });
        return reply.code(200).send({ ok: true, ignored: 'wrong-object' });
      }

      const messages = collectMessages(body);
      if (messages.length === 0) {
        // Status updates ou events sem `messages` — log e ignora.
        console.log('[webhook] no messages in batch');
        return reply.code(200).send({ ok: true });
      }

      // Reply 200 imediato; processa async pra Meta não retentar em chamadas
      // longas (Gemini, scanner).
      void (async () => {
        for (const message of messages) {
          if (!numbersMatch(message.from, env.userWhatsappNumber)) {
            console.log('[webhook] ignored: unauthorized-sender', {
              from: message.from,
              expected: env.userWhatsappNumber,
            });
            continue;
          }
          await recordInboundFromUser(message.from);
          const text = extractText(message);
          if (!text) {
            console.log('[webhook] ignored: non-text', { type: message.type });
            continue;
          }
          console.log('[webhook] processing', { messageId: message.id, text });
          try {
            const result = await extractBillFromText(text);
            if (result.intent !== 'create_bill' || !result.bill) {
              console.log('[webhook] intent unknown, notifying user');
              await notifyUnknown();
              continue;
            }
            await createBillFromExtraction(result.bill);
            console.log('[webhook] flow finished ok', { messageId: message.id });
          } catch (err) {
            console.error('[webhook] flow failed', err);
            try {
              await notifyUnknown();
            } catch {
              // already logged
            }
          }
        }
      })();

      return reply.code(200).send({ ok: true });
    },
  );
}
