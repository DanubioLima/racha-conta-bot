import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

// Registra mensagens que o Gemini não conseguiu classificar (intent unknown),
// pra analisar depois e descobrir usos não previstos. Persistido no volume,
// não em log (que rotaciona). Cap FIFO pra não crescer sem limite.
const STORE_PATH = path.resolve('data/unknown-intents.json');
const MAX_ENTRIES = 1000;

export interface UnknownIntent {
  at: string;
  phone: string;
  text: string;
  registered: boolean;
}

interface StoreShape {
  entries: UnknownIntent[];
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
    await writeFile(STORE_PATH, JSON.stringify({ entries: [] } satisfies StoreShape, null, 2), 'utf8');
  }
}

async function read(): Promise<StoreShape> {
  await ensureFile();
  return JSON.parse(await readFile(STORE_PATH, 'utf8')) as StoreShape;
}

async function write(store: StoreShape): Promise<void> {
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

export const unknownIntentsRepository = {
  record(input: { phone: string; text: string; registered: boolean }): Promise<void> {
    return serialize(async () => {
      const store = await read();
      store.entries.push({ at: new Date().toISOString(), ...input });
      if (store.entries.length > MAX_ENTRIES) {
        store.entries = store.entries.slice(-MAX_ENTRIES);
      }
      await write(store);
    });
  },
  list(): Promise<UnknownIntent[]> {
    return serialize(async () => (await read()).entries);
  },
};
