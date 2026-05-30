import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    env: {
      SLICE_DB_PATH: ':memory:',
      EVOLUTION_API_URL: 'http://localhost:8080',
      EVOLUTION_API_KEY: 'test',
      EVOLUTION_INSTANCE: 'test',
      USER_WHATSAPP_NUMBER: '550000000000',
      GEMINI_API_KEY: 'test',
      PIX_KEY: 'test@pix.com',
      PIX_MERCHANT_NAME: 'Test',
      PIX_MERCHANT_CITY: 'BRASIL',
      LEDGER_SOURCE: 'mock',
    },
  },
});
