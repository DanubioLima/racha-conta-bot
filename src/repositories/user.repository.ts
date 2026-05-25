import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

const DB_PATH = path.resolve('data/users.json');

export interface User {
  phone: string;                 // E.164 sem +, normalizado (ver webhook)
  name: string;
  pix_key: string;               // '' enquanto não coletado
  pix_merchant_name: string;     // derivado de name (≤25 chars) quando pix salvo
  pix_merchant_city: string;     // 'BRASIL'
  created_at: string;
}

interface DbShape {
  users: Record<string, User>;
}

let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function ensureFile(): Promise<void> {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  try {
    await access(DB_PATH);
  } catch {
    await writeFile(DB_PATH, JSON.stringify({ users: {} } satisfies DbShape, null, 2), 'utf8');
  }
}

async function readDb(): Promise<DbShape> {
  await ensureFile();
  return JSON.parse(await readFile(DB_PATH, 'utf8')) as DbShape;
}

async function writeDb(db: DbShape): Promise<void> {
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

export const userRepository = {
  findByPhone(phone: string): Promise<User | null> {
    return serialize(async () => (await readDb()).users[phone] ?? null);
  },

  insert(user: User): Promise<void> {
    return serialize(async () => {
      const db = await readDb();
      db.users[user.phone] = user;
      await writeDb(db);
    });
  },

  update(phone: string, partial: Partial<User>): Promise<User | null> {
    return serialize(async () => {
      const db = await readDb();
      const existing = db.users[phone];
      if (!existing) return null;
      const updated: User = { ...existing, ...partial };
      db.users[phone] = updated;
      await writeDb(db);
      return updated;
    });
  },
};
