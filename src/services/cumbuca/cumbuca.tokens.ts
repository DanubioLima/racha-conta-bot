import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

const TOKENS_PATH = path.resolve('data/cumbuca-tokens.json');

export interface CumbucaTokens {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;   // ISO8601
  account_id: string;
}

async function ensureDir(): Promise<void> {
  await mkdir(path.dirname(TOKENS_PATH), { recursive: true });
}

export async function hasTokens(): Promise<boolean> {
  try {
    await access(TOKENS_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function readTokens(): Promise<CumbucaTokens> {
  const raw = await readFile(TOKENS_PATH, 'utf8');
  return JSON.parse(raw) as CumbucaTokens;
}

export async function writeTokens(tokens: CumbucaTokens): Promise<void> {
  await ensureDir();
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
}

export function isAccessTokenExpired(tokens: CumbucaTokens, skewMs = 30_000): boolean {
  // skewMs: refresh um pouco antes da expiração real pra evitar race conditions.
  return new Date(tokens.expires_at).getTime() - skewMs <= Date.now();
}
