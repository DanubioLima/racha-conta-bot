import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import twilio from 'twilio';
import { registerWhatsAppWebhook } from '../src/routes/whatsapp.webhook.js';

// Dispatch mockado: o webhook só parseia + valida assinatura + dispara.
const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn(async () => {}) }));
vi.mock('../src/services/dispatch/dispatch-message.js', () => ({
  dispatchIncomingMessage: dispatchMock,
}));

const AUTH_TOKEN = 'test-auth-token'; // = TWILIO_AUTH_TOKEN no vitest.config.ts
const PUBLIC_URL = 'https://bot.appslice.com.br/webhooks/whatsapp';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(formbody);
  registerWhatsAppWebhook(app);
  await app.ready();
  return app;
}

function post(app: FastifyInstance, params: Record<string, string>, signature: string) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'bot.appslice.com.br',
      'x-twilio-signature': signature,
    },
    payload: new URLSearchParams(params).toString(),
  });
}

function sign(params: Record<string, string>): string {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, PUBLIC_URL, params);
}

beforeEach(() => dispatchMock.mockClear());

describe('webhook Twilio', () => {
  it('com assinatura válida, despacha sender normalizado + texto', async () => {
    const app = await buildApp();
    const params = { From: 'whatsapp:+5588994963067', Body: 'oi', MessageSid: 'SM1' };
    const res = await post(app, params, sign(params));
    expect(res.statusCode).toBe(200);
    expect(dispatchMock).toHaveBeenCalledWith('558894963067', 'oi');
    await app.close();
  });

  it('rejeita assinatura inválida com 403 e não despacha', async () => {
    const app = await buildApp();
    const params = { From: 'whatsapp:+5588994963067', Body: 'oi', MessageSid: 'SM1' };
    const res = await post(app, params, 'assinatura-errada');
    expect(res.statusCode).toBe(403);
    expect(dispatchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('ignora (200) sem Body, mesmo com assinatura válida', async () => {
    const app = await buildApp();
    const params = { From: 'whatsapp:+5588994963067', MessageSid: 'SM1' };
    const res = await post(app, params, sign(params));
    expect(res.statusCode).toBe(200);
    expect(dispatchMock).not.toHaveBeenCalled();
    await app.close();
  });
});
