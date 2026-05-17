import { QrCodePix } from 'qrcode-pix';
import { env } from '../../config/env.js';

interface BuildPixArgs {
  amount: number;
  txid: string;
  message?: string;
}

function buildQrCodePix({ amount, txid, message }: BuildPixArgs) {
  return QrCodePix({
    version: '01',
    key: env.pixKey,
    name: env.pixMerchantName,
    city: env.pixMerchantCity,
    transactionId: txid.slice(0, 25),
    message,
    value: Number(amount.toFixed(2)),
  });
}

// Returns the Copia-e-Cola string for a static PIX charge.
export function buildPixPayload(args: BuildPixArgs): string {
  return buildQrCodePix(args).payload();
}

// Returns the raw base64 (without the "data:image/png;base64," prefix) of the
// PIX QR PNG. Pluggable directly into Evolution's sendMedia "media" field.
export async function buildPixQrPngBase64(args: BuildPixArgs): Promise<string> {
  const dataUrl = await buildQrCodePix(args).base64();
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
