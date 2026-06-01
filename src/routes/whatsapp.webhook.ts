import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import twilio from "twilio";
import { env } from "../config/env.js";
import { normalizeBrNumber } from "../lib/phone.js";
import { dispatchIncomingMessage } from "../services/dispatch/dispatch-message.js";

// A Twilio entrega o webhook como form-urlencoded. Só estes campos interessam pro
// fluxo; o resto (MessageSid, ProfileName…) é ignorado.
interface TwilioWebhookBody {
  From?: string; // "whatsapp:+5588994963067"
  Body?: string;
}

function extractSender(body: TwilioWebhookBody): string | null {
  if (!body.From) return null;
  return normalizeBrNumber(body.From); // limpa "whatsapp:+" e o nono dígito
}

// A assinatura do Twilio é calculada sobre a URL PÚBLICA + os params do POST. Atrás
// do Traefik a request chega como http/host interno, então reconstruímos a URL
// pública pelos headers x-forwarded-* (fallback pro que a própria request reporta).
function publicUrl(request: FastifyRequest): string {
  const proto = (request.headers["x-forwarded-proto"] as string) ?? request.protocol;
  const host = (request.headers["x-forwarded-host"] as string) ?? request.headers.host;
  return `${proto}://${host}${request.url}`;
}

function hasValidSignature(request: FastifyRequest): boolean {
  const signature = request.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;
  return twilio.validateRequest(
    env.twilioAuthToken,
    signature,
    publicUrl(request),
    (request.body ?? {}) as Record<string, string>,
  );
}

export function registerWhatsAppWebhook(app: FastifyInstance): void {
  app.post("/webhooks/whatsapp", async (request: FastifyRequest, reply: FastifyReply) => {
    // Webhook é público e dispara fluxo de dinheiro: sem assinatura válida da Twilio,
    // qualquer um forjaria mensagem. É o guarda-corpo de segurança da rota.
    if (!hasValidSignature(request)) {
      console.warn("[webhook] assinatura Twilio inválida");
      return reply.code(403).send({ ok: false, error: "invalid-signature" });
    }

    const body = (request.body ?? {}) as TwilioWebhookBody;
    const senderPhone = extractSender(body);
    if (!senderPhone) return reply.code(200).send({ ok: true, ignored: "no-sender" });

    const text = body.Body;
    if (!text) return reply.code(200).send({ ok: true, ignored: "no-text" });

    console.log("[webhook] mensagem recebida", { from: senderPhone, preview: text.slice(0, 40) });

    // Responde 200 já e roda o fluxo em background (a Twilio re-tenta em erro/timeout).
    void dispatchIncomingMessage(senderPhone, text).catch((err) =>
      console.error("[webhook] dispatch failed", err),
    );

    return reply.code(200).send({ ok: true });
  });
}
