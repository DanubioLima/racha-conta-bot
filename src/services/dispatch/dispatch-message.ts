import { extractIntent, GeminiUnavailableError } from "../llm/gemini.js";
import { createBillFromExtraction, markPaid, listOpenBills } from "../bills/bill.service.js";
import { handleRegistration } from "../users/user.service.js";
import { userRepository } from "../../repositories/user.repository.js";
import { unknownIntentsRepository } from "../../repositories/unknown-intents.repository.js";
import { sendText } from "../whatsapp/whatsapp.js";
import { fallbackReply, instability, askToRegister, askForPix } from "../messaging/voice.js";
import type { ExtractionResult } from "../bills/bill.types.js";

export async function dispatchIncomingMessage(senderPhone: string, text: string): Promise<void> {
  const user = await userRepository.findByPhone(senderPhone);
  const ctx = { registered: !!user, hasPix: !!user?.pix_key, name: user?.name ?? "" };

  // Extração isolada: Gemini fora (503) ou erro inesperado → instabilidade, não silêncio.
  let result: ExtractionResult;
  try {
    result = await extractIntent(text, ctx);
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
    switch (result.intent) {
      case "register_account":
        if (!result.profile?.name && !result.profile?.pix_key) {
          await sendText(senderPhone, fallbackReply({ registered: !!user }));
          break;
        }
        await handleRegistration(senderPhone, result.profile);
        break;

      case "create_bill": {
        if (!result.bill) { await sendText(senderPhone, fallbackReply({ registered: !!user })); break; }
        // Intent misto: só auto-registra quem está incompleto; conta vence o resto.
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

      case "list_bills":
        if (!user) { await sendText(senderPhone, askToRegister()); break; }
        await listOpenBills(senderPhone);
        break;

      default: {
        const softReply = result.intent === "unknown" ? result.reply?.trim() : undefined;
        if (softReply && softReply.length <= 300) {
          await sendText(senderPhone, softReply);
        } else {
          await unknownIntentsRepository.record({ phone: senderPhone, text, registered: !!user });
          console.log("[unknown-intent recorded]", { phone: senderPhone, textLen: text.length });
          await sendText(senderPhone, fallbackReply({ registered: !!user }));
        }
      }
    }
    console.log("[dispatch] flow finished ok");
  } catch (err) {
    console.error("[dispatch] flow failed", err);
  }
}
