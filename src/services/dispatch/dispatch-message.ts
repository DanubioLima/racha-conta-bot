import { extractIntent, GeminiUnavailableError } from "../llm/gemini.js";
import { createBillFromExtraction, markPaid, listOpenBills } from "../bills/bill.service.js";
import { handleRegistration } from "../users/user.service.js";
import { userRepository } from "../../repositories/user.repository.js";
import { unknownIntentsRepository } from "../../repositories/unknown-intents.repository.js";
import { conversationRepository } from "../../repositories/conversation.repository.js";
import { sendText } from "../whatsapp/whatsapp.js";
import { fallbackReply, instability, askToRegister, askForPix } from "../messaging/voice.js";
import type { ExtractionResult } from "../bills/bill.types.js";

export async function dispatchIncomingMessage(senderPhone: string, text: string): Promise<void> {
  const user = await userRepository.findByPhone(senderPhone);
  const ctx = { registered: !!user, hasPix: !!user?.pix_key, name: user?.name ?? "" };
  const history = await conversationRepository.recent(senderPhone, 8);

  // Extração isolada: Gemini fora (503) ou erro inesperado → instabilidade, não silêncio.
  // (Não grava histórico quando a extração falha.)
  let result: ExtractionResult;
  try {
    result = await extractIntent(text, ctx, history);
  } catch (err) {
    if (err instanceof GeminiUnavailableError) {
      console.warn("[dispatch] gemini unavailable, sending instability message");
    } else {
      console.error("[dispatch] extraction failed", err);
    }
    try {
      await sendText(senderPhone, instability());
    } catch (sendErr) {
      console.error("[dispatch] failed to send instability message", sendErr);
    }
    return;
  }

  try {
    // botTurn = o que o bot "disse" pro histórico: reply/gate verbatim, ou resumo de
    // ação (sem PIX). `say` envia E registra o texto pro histórico de uma vez.
    let botTurn = "";
    const say = async (message: string): Promise<void> => {
      await sendText(senderPhone, message);
      botTurn = message;
    };

    switch (result.intent) {
      case "register_account":
        if (!result.profile?.name && !result.profile?.pix_key) {
          await say(fallbackReply({ registered: !!user }));
          break;
        }
        botTurn = await handleRegistration(senderPhone, result.profile);
        break;

      case "create_bill": {
        if (!result.bill) { await say(fallbackReply({ registered: !!user })); break; }
        // Intent misto: só auto-registra quem está incompleto; conta vence o resto.
        let owner = user;
        if (result.profile && (!owner || !owner.pix_key)) {
          await handleRegistration(senderPhone, result.profile, { continueToBill: true });
          owner = await userRepository.findByPhone(senderPhone);
        }
        if (!owner) { await say(askToRegister()); break; }
        if (!owner.pix_key) { await say(askForPix(owner.name)); break; }
        await createBillFromExtraction(result.bill, owner);
        botTurn = "[criei a conta]";
        break;
      }

      case "mark_paid":
        if (!user) { await say(askToRegister()); break; }
        botTurn = await markPaid(senderPhone, result.payment ?? {});
        break;

      case "list_bills":
        if (!user) { await say(askToRegister()); break; }
        botTurn = await listOpenBills(senderPhone);
        break;

      default: {
        const softReply = result.intent === "unknown" ? result.reply?.trim() : undefined;
        if (softReply && softReply.length <= 300) {
          await say(softReply);
        } else {
          await unknownIntentsRepository.record({ phone: senderPhone, text, registered: !!user });
          console.log("[unknown-intent recorded]", { phone: senderPhone, textLen: text.length });
          await say(fallbackReply({ registered: !!user }));
        }
      }
    }

    // Grava o turno só em sucesso (um throw acima pula isto e cai no catch).
    await conversationRepository.append(senderPhone, "user", text);
    await conversationRepository.append(senderPhone, "bot", botTurn);
    console.log("[dispatch] flow finished ok");
  } catch (err) {
    console.error("[dispatch] flow failed", err);
  }
}
