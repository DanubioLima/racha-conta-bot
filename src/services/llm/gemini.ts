import { GoogleGenAI, Type } from "@google/genai";
import { env } from "../../config/env.js";
import { SYSTEM_INSTRUCTION } from "./prompt.js";

import type { ExtractionResult } from "../bills/bill.types.js";

const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: ["create_bill", "register_account", "mark_paid", "unknown"] },
    bill: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING },
        total_amount: { type: Type.NUMBER },
        headcount: { type: Type.INTEGER },
        participants: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              amount_due: { type: Type.NUMBER },
            },
            required: ["name", "amount_due"],
          },
        },
      },
    },
    profile: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        pix_key: { type: Type.STRING },
      },
    },
    payment: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        amount: { type: Type.NUMBER },
      },
    },
  },
  required: ["intent"],
};

export async function extractIntent(text: string): Promise<ExtractionResult> {
  console.log("[gemini] extracting", { text });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  });

  const raw = response.text;
  console.log("[gemini] raw response", { raw });
  if (!raw) return { intent: "unknown" };
  try {
    const parsed = JSON.parse(raw) as ExtractionResult;
    console.log("[gemini] parsed", parsed);
    return parsed;
  } catch (err) {
    console.error("[gemini] failed to parse JSON", { raw, err });
    return { intent: "unknown" };
  }
}
