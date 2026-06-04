import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    env: {
      SLICE_DB_PATH: ':memory:',
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
      TWILIO_AUTH_TOKEN: 'test-auth-token',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+558894963067',
      USER_WHATSAPP_NUMBER: '550000000000',
      GEMINI_API_KEY: 'test',
      PIX_KEY: 'test@pix.com',
      PIX_MERCHANT_NAME: 'Test',
      PIX_MERCHANT_CITY: 'BRASIL',
    },
  },
});
