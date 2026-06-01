import 'dotenv/config';

const required = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
  'USER_WHATSAPP_NUMBER',
  'GEMINI_API_KEY',
  'PIX_KEY',
  'PIX_MERCHANT_NAME',
  'PIX_MERCHANT_CITY',
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
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID!,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN!,
  twilioWhatsAppFrom: process.env.TWILIO_WHATSAPP_FROM!,
  userWhatsappNumber: process.env.USER_WHATSAPP_NUMBER!,
  geminiApiKey: process.env.GEMINI_API_KEY!,
  pixKey: process.env.PIX_KEY!,
  pixMerchantName: process.env.PIX_MERCHANT_NAME!,
  pixMerchantCity: process.env.PIX_MERCHANT_CITY!,
  ledgerSource: ledgerSourceRaw as 'cumbuca' | 'mock',
};
