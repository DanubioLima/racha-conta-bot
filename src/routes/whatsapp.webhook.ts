import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { extractIntent, GeminiUnavailableError } from "../services/llm/gemini.js";
import { createBillFromExtraction, markPaid } from "../services/bills/bill.service.js";
import { handleRegistration } from "../services/users/user.service.js";
import { userRepository } from "../repositories/user.repository.js";
import { unknownIntentsRepository } from "../repositories/unknown-intents.repository.js";
import { normalizeBrNumber } from "../lib/phone.js";
import { sendText } from "../services/whatsapp/whatsapp.js";
import {
  fallbackReply,
  instability,
  askToRegister,
  askForPix,
} from "../services/messaging/voice.js";
import type { ExtractionResult } from "../services/bills/bill.types.js";

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
    void (async () => {
      const user = await userRepository.findByPhone(senderPhone);
      const ctx = { registered: !!user, hasPix: !!user?.pix_key, name: user?.name ?? "" };

      // Extração isolada: se o Gemini cair (503) ou der erro inesperado aqui,
      // manda instabilidade em vez de deixar o usuário no silêncio.
      let result: ExtractionResult;
      try {
        result = await extractIntent(text, ctx);
      } catch (err) {
        if (err instanceof GeminiUnavailableError) {
          console.warn("[webhook] gemini unavailable, sending instability message");
        } else {
          console.error("[webhook] extraction failed", err);
        }
        try {
          await sendText(senderPhone, instability());
        } catch (sendErr) {
          console.error("[webhook] failed to send instability message", sendErr);
        }
        return;
      }

      try {
        switch (result.intent) {
          case "register_account":
            if (!result.profile) { await sendText(senderPhone, fallbackReply({ registered: !!user })); break; }
            await handleRegistration(senderPhone, result.profile);
            break;

          case "create_bill": {
            if (!result.bill) { await sendText(senderPhone, fallbackReply({ registered: !!user })); break; }
            // Intent misto: a pessoa se apresentou E mandou a conta na mesma
            // mensagem. Registra o cadastro embutido (silencioso) e segue.
            // Só auto-registra quem ainda está incompleto (sem cadastro ou sem
            // PIX); pra quem já está completo, a conta vence e um nome/PIX
            // reapresentado aqui é ignorado (cadastro se corrige em mensagem própria).
            let owner = user;
            if (result.profile && (!owner || !owner.pix_key)) {
              await handleRegistration(senderPhone, result.profile, { continueToBill: true });
              owner = await userRepository.findByPhone(senderPhone);
            }
            if (!owner) { await sendText(senderPhone, askToRegister()); break; }
            if (!owner.pix_key) { await sendText(senderPhone, askForPix(owner.name)); break; }
            await createBillFromExtraction(result.bill, owner);
            break;
          }

          case "mark_paid":
            if (!user) { await sendText(senderPhone, askToRegister()); break; }
            await markPaid(senderPhone, result.payment ?? {});
            break;

          default: {
            await unknownIntentsRepository.record({ phone: senderPhone, text, registered: !!user });
            console.log("[unknown-intent]", { phone: senderPhone, text });
            const softReply = result.intent === "unknown" ? result.reply?.trim() : undefined;
            if (softReply && softReply.length <= 300) {
              await sendText(senderPhone, softReply);
            } else {
              await sendText(senderPhone, fallbackReply({ registered: !!user }));
            }
          }
        }
        console.log("[webhook] flow finished ok");
      } catch (err) {
        console.error("[webhook] flow failed", err);
      }
    })();

    return reply.code(200).send({ ok: true });
  });
}
