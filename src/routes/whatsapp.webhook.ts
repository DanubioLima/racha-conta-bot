import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { normalizeBrNumber } from "../lib/phone.js";
import { dispatchIncomingMessage } from "../services/dispatch/dispatch-message.js";

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
    void dispatchIncomingMessage(senderPhone, text).catch((err) =>
      console.error("[webhook] dispatch failed", err),
    );

    return reply.code(200).send({ ok: true });
  });
}
