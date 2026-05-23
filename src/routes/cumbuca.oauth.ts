import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { exchangeCodeForTokens } from '../services/cumbuca/cumbuca.client.js';
import { writeTokens } from '../services/cumbuca/cumbuca.tokens.js';
import {
  readPendingPairing,
  deletePendingPairing,
  isPairingExpired,
} from '../services/cumbuca/cumbuca.pending-pairing.js';

export function registerCumbucaOAuthRoutes(app: FastifyInstance): void {
  app.get(
    '/oauth/cumbuca/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { code, state, error } = request.query as {
        code?: string;
        state?: string;
        error?: string;
      };

      if (error) {
        reply.type('text/plain; charset=utf-8').send(
          `Autorização cancelada: ${error}\nPode fechar esta aba.`,
        );
        return;
      }
      if (!code || !state) {
        reply.code(400).type('text/plain; charset=utf-8').send(
          'Faltou code ou state no callback.',
        );
        return;
      }

      const pending = await readPendingPairing();
      if (!pending) {
        reply.code(409).type('text/plain; charset=utf-8').send(
          'Nenhum pareamento ativo. Rode `npm run cumbuca:link` antes.',
        );
        return;
      }
      if (pending.state !== state) {
        console.warn('[cumbuca-oauth] state mismatch');
        reply.code(401).type('text/plain; charset=utf-8').send(
          'State mismatch. Tente parear de novo.',
        );
        return;
      }
      if (isPairingExpired(pending)) {
        await deletePendingPairing();
        reply.code(410).type('text/plain; charset=utf-8').send(
          'Pareamento expirou (>10min). Rode `npm run cumbuca:link` de novo.',
        );
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(code, {
          clientId: pending.client_id,
          clientSecret: pending.client_secret,
          codeVerifier: pending.code_verifier,
          redirectUri: pending.redirect_uri,
        });
        // Tokens preliminares — sem account_id. CLI completa o flow.
        await writeTokens({
          client_id: pending.client_id,
          client_secret: pending.client_secret,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          account_id: '',
        });
        await deletePendingPairing();
        console.log('[cumbuca-oauth] tokens persisted, account selection pending');
        reply.type('text/plain; charset=utf-8').send(
          '✅ Tokens recebidos. Volte ao terminal pra escolher a conta.',
        );
      } catch (err) {
        console.error('[cumbuca-oauth] code exchange failed', err);
        reply.code(500).type('text/plain; charset=utf-8').send(
          'Falhou trocar code por tokens. Veja logs do servidor.',
        );
      }
    },
  );
}
