import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

// Conjunto persistente de transactionIds já reconciliados pelo scanner.
// Cap em MAX_TRACKED_IDS (FIFO) — janela do Cumbuca é curta, não há risco
// de uma transação antiga sair do conjunto e ser reprocessada.

const STORE_PATH = path.resolve('data/processed-transaction-ids.json');
const MAX_TRACKED_IDS = 1000;

interface StoreShape {
  ids: string[];
}

let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function ensureFile(): Promise<void> {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  try {
    await access(STORE_PATH);
  } catch {
    const empty: StoreShape = { ids: [] };
    await writeFile(STORE_PATH, JSON.stringify(empty, null, 2), 'utf8');
  }
}

async function read(): Promise<StoreShape> {
  await ensureFile();
  const raw = await readFile(STORE_PATH, 'utf8');
  return JSON.parse(raw) as StoreShape;
}

async function write(store: StoreShape): Promise<void> {
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

export const processedTransactionsRepository = {
  wasAlreadyProcessed(transactionId: string): Promise<boolean> {
    return serialize(async () => {
      const store = await read();
      return store.ids.includes(transactionId);
    });
  },

  markAsProcessed(transactionId: string): Promise<void> {
    return serialize(async () => {
      const store = await read();
      if (store.ids.includes(transactionId)) return;
      store.ids.push(transactionId);
      if (store.ids.length > MAX_TRACKED_IDS) {
        store.ids = store.ids.slice(-MAX_TRACKED_IDS);
      }
      await write(store);
    });
  },
};
