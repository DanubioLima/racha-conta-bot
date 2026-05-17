import Fastify from 'fastify';
import { env } from './config/env.js';
import { registerWhatsAppWebhook } from './routes/whatsapp.webhook.js';
import { registerCumbucaOAuthRoutes } from './routes/cumbuca.oauth.js';
import { startPaymentScanner } from './workers/payment-scanner.worker.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ ok: true }));
  registerWhatsAppWebhook(app);
  registerCumbucaOAuthRoutes(app);

  await app.listen({ port: env.port, host: '0.0.0.0' });
  await startPaymentScanner();
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
