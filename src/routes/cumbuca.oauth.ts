import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// O state in-memory é registrado pelo script `cumbuca:link` quando ele inicia
// o flow. Quando o user autoriza no banco, o redirect vem aqui com `code` e
// `state` (este último ignorado — usamos in-memory).

type OnCodeReceived = (code: string) => void;
let onCodeReceived: OnCodeReceived | null = null;

export function registerCallbackListener(handler: OnCodeReceived): void {
  onCodeReceived = handler;
}

export function clearCallbackListener(): void {
  onCodeReceived = null;
}

export function registerCumbucaOAuthRoutes(app: FastifyInstance): void {
  app.get(
    '/oauth/cumbuca/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { code, error } = request.query as { code?: string; error?: string };

      if (error) {
        reply.type('text/html').send(
          `<h1>❌ Autorização cancelada</h1><p>${error}</p><p>Pode fechar esta aba.</p>`,
        );
        return;
      }
      if (!code) {
        reply.code(400).type('text/html').send(
          '<h1>⚠️ Faltou o code no callback.</h1>',
        );
        return;
      }
      if (!onCodeReceived) {
        reply.code(409).type('text/html').send(
          '<h1>⚠️ Nenhum flow de pareamento ativo.</h1><p>Rode `npm run cumbuca:link` antes.</p>',
        );
        return;
      }

      onCodeReceived(code);
      reply.type('text/html').send(
        '<h1>✅ Pareamento concluído</h1><p>Pode fechar esta aba e voltar pro terminal.</p>',
      );
    },
  );
}
