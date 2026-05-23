import 'dotenv/config';

const required = [
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'USER_WHATSAPP_NUMBER',
  'GEMINI_API_KEY',
  'PIX_KEY',
  'PIX_MERCHANT_NAME',
  'PIX_MERCHANT_CITY',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
] as const;

const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const ledgerSourceRaw = (process.env.LEDGER_SOURCE ?? 'cumbuca').toLowerCase();
if (ledgerSourceRaw !== 'cumbuca' && ledgerSourceRaw !== 'mock') {
  console.error(`Invalid LEDGER_SOURCE "${ledgerSourceRaw}". Expected "cumbuca" or "mock".`);
  process.exit(1);
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
  evolutionApiUrl: process.env.EVOLUTION_API_URL!,
  evolutionApiKey: process.env.EVOLUTION_API_KEY!,
  evolutionInstance: process.env.EVOLUTION_INSTANCE!,
  userWhatsappNumber: process.env.USER_WHATSAPP_NUMBER!,
  geminiApiKey: process.env.GEMINI_API_KEY!,
  pixKey: process.env.PIX_KEY!,
  pixMerchantName: process.env.PIX_MERCHANT_NAME!,
  pixMerchantCity: process.env.PIX_MERCHANT_CITY!,
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 30000),
  ledgerSource: ledgerSourceRaw as 'cumbuca' | 'mock',
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET!,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
};
