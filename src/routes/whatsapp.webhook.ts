import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { env } from "../config/env.js";
import { extractBillFromText } from "../services/llm/gemini.js";
import {
  createBillFromExtraction,
  notifyUnknown,
} from "../services/bills/bill.service.js";
import { wasSentByBot } from "../services/whatsapp/whatsapp.js";

// Evolution API MESSAGES_UPSERT payload (only the fields we care about).
interface EvolutionWebhookBody {
  event?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
    };
  };
}

function extractText(body: EvolutionWebhookBody): string | null {
  const msg = body?.data?.message;
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? null;
}

function extractRemoteNumber(body: EvolutionWebhookBody): string | null {
  const jid = body?.data?.key?.remoteJid;
  if (!jid) return null;
  // remoteJid looks like "5511999999999@s.whatsapp.net" — keep only the number.
  return jid.split("@")[0] ?? null;
}

// Brazilian "nono dígito": some carriers / WhatsApp installs strip the leading
// 9 on mobile numbers. 5588998082034 and 558898082034 are the same line.
// Normalize both sides before comparing.
function normalizeBrNumber(num: string): string {
  const digits = num.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("55") && digits[4] === "9") {
    return digits.slice(0, 4) + digits.slice(5);
  }
  return digits;
}

function numbersMatch(a: string, b: string): boolean {
  return normalizeBrNumber(a) === normalizeBrNumber(b);
}

export function registerWhatsAppWebhook(app: FastifyInstance): void {
  app.post(
    "/webhooks/whatsapp",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as EvolutionWebhookBody;
      console.log("[webhook] event received", {
        event: body?.event,
        fromMe: body?.data?.key?.fromMe,
        remoteJid: body?.data?.key?.remoteJid,
        messageId: body?.data?.key?.id,
      });

      // Only handle conversations involving the configured user number. In the
      // single-user MVP, that's always the user messaging themselves.
      const remoteNumber = extractRemoteNumber(body);
      if (!remoteNumber || !numbersMatch(remoteNumber, env.userWhatsappNumber)) {
        console.log("[webhook] ignored: unauthorized-remote", {
          remoteNumber,
          expected: env.userWhatsappNumber,
        });
        return reply
          .code(200)
          .send({ ok: true, ignored: "unauthorized-remote" });
      }

      const text = extractText(body);
      if (!text) {
        console.log("[webhook] ignored: no-text");
        return reply.code(200).send({ ok: true, ignored: "no-text" });
      }

      // The user messages themselves, so legitimate user-typed messages arrive
      // with fromMe=true. So do the bot's own outgoing messages, echoed back via
      // MESSAGES_UPSERT. Filter the echoes by checking the id/text cache.
      if (body?.data?.key?.fromMe && wasSentByBot(body.data.key.id, text)) {
        console.log("[webhook] ignored: bot-echo", {
          messageId: body.data.key.id,
        });
        return reply.code(200).send({ ok: true, ignored: "bot-echo" });
      }

      console.log("[webhook] processing user message", {
        text,
        fromMe: body?.data?.key?.fromMe,
      });

      // Reply 200 immediately and run the flow in the background so Evolution
      // doesn't retry on slow LLM calls.
      void (async () => {
        try {
          const result = await extractBillFromText(text);
          if (result.intent !== "create_bill" || !result.bill) {
            console.log("[webhook] intent unknown, notifying user");
            await notifyUnknown();
            return;
          }
          await createBillFromExtraction(result.bill);
          console.log("[webhook] flow finished ok");
        } catch (err) {
          console.error("[webhook] flow failed", err);
          try {
            await notifyUnknown();
          } catch {
            // already logged
          }
        }
      })();

      return reply.code(200).send({ ok: true });
    },
  );
}
