import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { extractIntent } from "../services/llm/gemini.js";
import { createBillFromExtraction, markPaid } from "../services/bills/bill.service.js";
import {
  handleRegistration,
  requireRegistrationFirst,
  requirePixFirst,
  notifyUnknown,
} from "../services/users/user.service.js";
import { userRepository } from "../repositories/user.repository.js";

interface EvolutionWebhookBody {
  event?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: { conversation?: string; extendedTextMessage?: { text?: string } };
  };
}

function extractText(body: EvolutionWebhookBody): string | null {
  const msg = body?.data?.message;
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? null;
}

// Brazilian "nono dígito": normaliza 13→12 dígitos pra a chave do user ficar
// estável entre variações de número.
function normalizeBrNumber(num: string): string {
  const digits = num.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("55") && digits[4] === "9") {
    return digits.slice(0, 4) + digits.slice(5);
  }
  return digits;
}

function extractSender(body: EvolutionWebhookBody): string | null {
  const jid = body?.data?.key?.remoteJid;
  if (!jid) return null;
  const raw = jid.split("@")[0];
  return raw ? normalizeBrNumber(raw) : null;
}

export function registerWhatsAppWebhook(app: FastifyInstance): void {
  app.post("/webhooks/whatsapp", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as EvolutionWebhookBody;
    console.log("[webhook] event", {
      event: body?.event,
      fromMe: body?.data?.key?.fromMe,
      remoteJid: body?.data?.key?.remoteJid,
    });

    // Echoes do próprio bot chegam com fromMe=true — ignora.
    if (body?.data?.key?.fromMe) {
      return reply.code(200).send({ ok: true, ignored: "from-me" });
    }

    const senderPhone = extractSender(body);
    if (!senderPhone) return reply.code(200).send({ ok: true, ignored: "no-sender" });

    const text = extractText(body);
    if (!text) return reply.code(200).send({ ok: true, ignored: "no-text" });

    // Responde 200 já e roda o fluxo em background (Evolution não re-tenta).
    void (async () => {
      try {
        const user = await userRepository.findByPhone(senderPhone);
        const result = await extractIntent(text);
        switch (result.intent) {
          case "register_account":
            await handleRegistration(senderPhone, result.profile);
            break;
          case "create_bill":
            if (!user) { await requireRegistrationFirst(senderPhone); break; }
            if (!user.pix_key) { await requirePixFirst(senderPhone, user.name); break; }
            await createBillFromExtraction(result.bill, user);
            break;
          case "mark_paid":
            if (!user) { await requireRegistrationFirst(senderPhone); break; }
            await markPaid(senderPhone, result.payment);
            break;
          default:
            await notifyUnknown(senderPhone, !!user);
        }
        console.log("[webhook] flow finished ok");
      } catch (err) {
        console.error("[webhook] flow failed", err);
      }
    })();

    return reply.code(200).send({ ok: true });
  });
}
