import Fastify from 'fastify';
import { env } from './config/env.js';
import { registerWhatsAppWebhook } from './routes/whatsapp.webhook.js';
import { startPaymentScanner } from './workers/payment-scanner.worker.js';

// A rota de callback OAuth do Cumbuca **não** é registrada aqui de propósito —
// ela é exposta pelo `bin/cumbuca-link.ts` num Fastify dedicado de curta vida,
// que disputa a mesma porta com o bot. Em runtime do bot ela não tem consumidor
// (o listener in-memory só existe enquanto o script de pareamento roda), então
// deixá-la registrada aqui só geraria 409 e ofuscaria a verdade arquitetural.
// Pra re-parear: pare o bot, rode `npm run cumbuca:link`.

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ ok: true }));
  registerWhatsAppWebhook(app);

  // Inicia o scanner antes do listen pra evitar a janela em que o webhook
  // do WhatsApp poderia chegar e chamar `notifyNewBillCreated` antes do
  // scanner estar pronto. `startPaymentScanner` retorna imediatamente
  // (dispatch via `void`), então não atrasa o listen.
  await startPaymentScanner();
  await app.listen({ port: env.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
