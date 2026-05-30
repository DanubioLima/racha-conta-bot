import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { env } from "../../config/env.js";
import { SYSTEM_INSTRUCTION } from "./prompt.js";

import type { ExtractionResult } from "../bills/bill.types.js";
import type { HistoryTurn } from "../../repositories/conversation.repository.js";

const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: ["create_bill", "register_account", "mark_paid", "list_bills", "unknown"] },
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
      required: ["description", "total_amount", "headcount", "participants"],
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
    reply: { type: Type.STRING },
  },
  required: ["intent"],
};

export class GeminiUnavailableError extends Error {
  constructor(message = 'Gemini indisponível após retries') {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Transitório = vale retentar. Status 5xx/429 ou erro de rede/timeout. Um 400
// (bug de request) NÃO é transitório — propaga sem retentar.
function isRetryableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|overloaded|deadline|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(
    message,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 3 tentativas (2 retentativas) com backoff + jitter. Lança GeminiUnavailableError
// quando esgota as retentativas num erro transitório; propaga o erro original se
// não for transitório (ex: 400).
async function generateWithRetry(
  request: Parameters<typeof ai.models.generateContent>[0],
): Promise<Awaited<ReturnType<typeof ai.models.generateContent>>> {
  const backoffMs = [500, 1500];
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      const retryable = isRetryableError(error);
      if (!retryable || attempt >= backoffMs.length) {
        if (retryable) {
          console.error('[gemini] giving up after retries', error);
          throw new GeminiUnavailableError();
        }
        throw error;
      }
      const waitMs = backoffMs[attempt]! + Math.floor(Math.random() * 250);
      console.warn('[gemini] retryable error, retrying', { attempt: attempt + 1, waitMs });
      await delay(waitMs);
    }
  }
}

export interface UserContext {
  registered: boolean;
  hasPix: boolean;
  name: string; // '' quando ainda não coletado
}

// Defesa contra prompt injection: o nome vem de input livre do usuário (via
// register_account) e seria interpolado direto no systemInstruction. Restringe
// a letras (com acentos), espaço, hífen, apóstrofo e capa em 40 chars — mata
// instruções/aspas/quebras de linha sem perder nomes brasileiros legítimos.
function sanitizeName(name: string): string {
  return name.replace(/[^\p{L} '\-]/gu, '').slice(0, 40).trim();
}

function buildContextNote(ctx: UserContext): string {
  if (!ctx.registered) {
    return '\n\nCONTEXTO DO REMETENTE: ainda NÃO tem cadastro. Se for primeiro contato, saudação ou tentativa de dividir conta, conduza pro cadastro (nome + chave PIX, ex: \'Sou João, pix joao@email.com\'). Caso contrário, responda natural seguindo a persona.';
  }
  if (!ctx.hasPix) {
    return '\n\nCONTEXTO DO REMETENTE: cadastrado, mas SEM chave PIX. Quando fizer sentido, lembre que falta a chave PIX (ex: \'pix joao@email.com\').';
  }
  const safeName = sanitizeName(ctx.name);
  const nome = safeName ? ` (nome: ${safeName})` : '';
  return `\n\nCONTEXTO DO REMETENTE: cadastrado${nome}, já sabe usar. Responda natural seguindo a persona; NÃO empurre tutorial nem repita instrução.`;
}

// Monta o array de contents do Gemini: histórico (bot→model) + a mensagem atual.
export function buildContents(
  text: string,
  history: HistoryTurn[],
): { role: "user" | "model"; parts: { text: string }[] }[] {
  const past = history.map((turn) => ({
    role: turn.role === "bot" ? ("model" as const) : ("user" as const),
    parts: [{ text: turn.text }],
  }));
  return [...past, { role: "user" as const, parts: [{ text }] }];
}

export async function extractIntent(
  text: string,
  ctx: UserContext,
  history: HistoryTurn[] = [],
): Promise<ExtractionResult> {
  // Não loga o conteúdo cru (texto, resposta, parsed): a mensagem pode trazer
  // chave PIX e o parsed traz profile.pix_key — PII em log que rotaciona/é
  // exportado. Loga só metadados, na mesma linha da redação do whatsapp.ts.
  console.log("[gemini] extracting", {
    textLen: text.length, registered: ctx.registered, hasPix: ctx.hasPix, historyTurns: history.length,
  });
  const request = {
    model: "gemini-3.1-flash-lite",
    contents: buildContents(text, history),
    config: {
      systemInstruction: SYSTEM_INSTRUCTION + buildContextNote(ctx),
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      // 0.4 dá vida ao "reply" sem arriscar a extração — o responseSchema prende
      // os campos estruturados, e os números vêm do texto, não são amostrados.
      temperature: 0.4,
      // Gemini 3.x assume thinking HIGH por padrão; pra um classificador JSON isso
      // só adiciona latência/custo. MINIMAL mantém rápido (UX WhatsApp). Subir pra
      // LOW se o smoke mostrar que reasoning ajuda (ex: ambiguidade do headcount).
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  };

  // Resposta vazia/inparseável é "respondeu estranho", não "está fora" — tenta
  // mais uma vez antes de cair no fallback de confusão (unknown sem reply).
  // generateWithRetry, ao contrário, lança GeminiUnavailableError quando o
  // transporte falha de vez (503 etc.); isso sobe pro dispatcher virar instabilidade.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await generateWithRetry(request);
    const raw = response.text;
    console.log("[gemini] raw response", { rawLen: raw?.length ?? 0 });
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as ExtractionResult;
      console.log("[gemini] parsed", { intent: parsed.intent, fields: Object.keys(parsed).filter((k) => k !== "intent") });
      return parsed;
    } catch (error) {
      console.error("[gemini] failed to parse JSON", { rawLen: raw.length, error });
    }
  }
  return { intent: "unknown" };
}
