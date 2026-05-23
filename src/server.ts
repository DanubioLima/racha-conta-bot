import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { env } from './config/env.js';
import { registerWhatsAppWebhook } from './routes/whatsapp.webhook.js';
import { registerCumbucaOAuthRoutes } from './routes/cumbuca.oauth.js';
import { startPaymentScanner } from './workers/payment-scanner.worker.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  // Preserva o rawBody pra verificação HMAC do webhook do WhatsApp. Default do
  // Fastify descarta. Solução: parser custom que armazena rawBody no request
  // antes de devolver o JSON parseado pra rota.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request: FastifyRequest, body: string, done) => {
      try {
        const json = body.length > 0 ? JSON.parse(body) : {};
        (request as { rawBody?: string }).rawBody = body;
        done(null, json);
      } catch (err) {
        done(err as Error);
      }
    },
  );

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
