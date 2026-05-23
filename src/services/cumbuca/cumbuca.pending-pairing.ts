import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import path from 'node:path';

const STORE_PATH = path.resolve('data/cumbuca-pending-pairing.json');
const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutos

export interface PendingPairing {
  state: string;
  client_id: string;
  client_secret: string;
  code_verifier: string;
  redirect_uri: string;
  created_at: string; // ISO8601
}

async function ensureDir(): Promise<void> {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
}

export async function writePendingPairing(pending: PendingPairing): Promise<void> {
  await ensureDir();
  await writeFile(STORE_PATH, JSON.stringify(pending, null, 2), 'utf8');
}

export async function readPendingPairing(): Promise<PendingPairing | null> {
  try {
    await access(STORE_PATH);
  } catch {
    return null;
  }
  const raw = await readFile(STORE_PATH, 'utf8');
  return JSON.parse(raw) as PendingPairing;
}

export async function deletePendingPairing(): Promise<void> {
  try {
    await unlink(STORE_PATH);
  } catch {
    // ok se não existe
  }
}

export function isPairingExpired(pending: PendingPairing): boolean {
  return Date.now() - new Date(pending.created_at).getTime() > PAIRING_TTL_MS;
}
