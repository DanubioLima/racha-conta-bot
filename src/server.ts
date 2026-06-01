import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { env } from './config/env.js';
import { registerWhatsAppWebhook } from './routes/whatsapp.webhook.js';
import { registerCumbucaOAuthRoutes } from './routes/cumbuca.oauth.js';
import { startPaymentScanner } from './workers/payment-scanner.worker.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  // A Twilio entrega o webhook como application/x-www-form-urlencoded.
  await app.register(formbody);

  app.get('/healthz', async () => ({
    ok: true,
    ts: new Date().toISOString(),
  }));

  registerWhatsAppWebhook(app);
  registerCumbucaOAuthRoutes(app);

  // Inicia o scanner antes do listen pra evitar a janela em que o webhook
  // do WhatsApp poderia chegar e chamar `notifyNewBillCreated` antes do
  // scanner estar pronto.
  await startPaymentScanner();
  await app.listen({ port: env.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
