import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { env } from "../config/env.js";
import { SYSTEM_INSTRUCTION } from "../services/llm/prompt.js";
import { RESPONSE_SCHEMA } from "../services/llm/gemini.js";

// Cronometra a latência de classificação por modelo, na MESMA mensagem, pra decidir
// o trade-off velocidade × qualidade (ver lentidão de ~22s observada em prod). Bate
// na API real do Gemini — precisa de GEMINI_API_KEY no .env e rede. Não é teste de
// CI; é ferramenta de medição. Uso: npm run bench:gemini
const MODELS = ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite"];
const MESSAGES = [
  "oii",
  "Paguei 60 na pizzaria, divide com João e Maria, 20 cada",
];
const ROUNDS = 3;

const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

// 3.x assume thinking HIGH por padrão (lento p/ classificador) → MINIMAL, igual à
// prod. 2.5-flash-lite usa thinkingBudget; 0 desliga o thinking (config mais rápida).
function thinkingFor(model: string): Record<string, unknown> {
  return model.startsWith("gemini-3")
    ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
    : { thinkingConfig: { thinkingBudget: 0 } };
}

async function timeOnce(model: string, text: string): Promise<number> {
  const startedAt = performance.now();
  await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.4,
      ...thinkingFor(model),
    },
  });
  return Math.round(performance.now() - startedAt);
}

async function main(): Promise<void> {
  for (const model of MODELS) {
    console.log(`\n=== ${model} ===`);
    for (const text of MESSAGES) {
      const samples: number[] = [];
      try {
        for (let round = 0; round < ROUNDS; round++) {
          samples.push(await timeOnce(model, text));
        }
      } catch (error) {
        console.log(`  "${text.slice(0, 30)}…" → ERRO: ${(error as Error).message}`);
        continue;
      }
      const avg = Math.round(samples.reduce((sum, ms) => sum + ms, 0) / samples.length);
      console.log(`  "${text.slice(0, 30)}…" → ${samples.map((ms) => `${ms}ms`).join(", ")} (média ${avg}ms)`);
    }
  }
}

main().catch((error) => {
  console.error("bench falhou", error);
  process.exit(1);
});
