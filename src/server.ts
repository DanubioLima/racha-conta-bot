import Fastify from "fastify";
import { env } from "./config/env.js";
import { registerWhatsAppWebhook } from "./routes/whatsapp.webhook.js";
import { startLedgerWorker } from "./workers/ledger.worker.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true }));
  registerWhatsAppWebhook(app);

  await app.listen({ port: env.port, host: "0.0.0.0" });
  startLedgerWorker();
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
