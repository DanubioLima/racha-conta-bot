import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import type { Bill } from '../services/bills/bill.types.js';

const DB_PATH = path.resolve('data/db.json');

interface DbShape {
  bills: Bill[];
}

// Single in-process mutex: queue writes/reads so the worker and the webhook
// route never interleave on the same JSON file.
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
    const empty: DbShape = { bills: [] };
    await writeFile(DB_PATH, JSON.stringify(empty, null, 2), 'utf8');
  }
}

async function readDb(): Promise<DbShape> {
  await ensureFile();
  const raw = await readFile(DB_PATH, 'utf8');
  return JSON.parse(raw) as DbShape;
}

async function writeDb(db: DbShape): Promise<void> {
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

export const billRepository = {
  list(): Promise<Bill[]> {
    return serialize(async () => (await readDb()).bills);
  },

  insert(bill: Bill): Promise<void> {
    return serialize(async () => {
      const db = await readDb();
      db.bills.push(bill);
      await writeDb(db);
    });
  },

  update(billId: string, mutator: (b: Bill) => void): Promise<Bill | null> {
    return serialize(async () => {
      const db = await readDb();
      const bill = db.bills.find((b) => b.id === billId);
      if (!bill) return null;
      mutator(bill);
      await writeDb(db);
      return bill;
    });
  },

  findOpen(): Promise<Bill[]> {
    return serialize(async () => (await readDb()).bills.filter((b) => b.status === 'OPEN'));
  },
};
