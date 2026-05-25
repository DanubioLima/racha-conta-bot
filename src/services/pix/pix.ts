import { QrCodePix } from 'qrcode-pix';

interface BuildPixArgs {
  amount: number;
  txid: string;
  message?: string;
  key: string;
  merchantName: string;
  merchantCity: string;
}

function buildQrCodePix({ amount, txid, message, key, merchantName, merchantCity }: BuildPixArgs) {
  return QrCodePix({
    version: '01',
    key,
    name: merchantName,
    city: merchantCity,
    transactionId: txid.slice(0, 25),
    message,
    value: Number(amount.toFixed(2)),
  });
}

export function buildPixPayload(args: BuildPixArgs): string {
  return buildQrCodePix(args).payload();
}

export async function buildPixQrPngBase64(args: BuildPixArgs): Promise<string> {
  const dataUrl = await buildQrCodePix(args).base64();
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
