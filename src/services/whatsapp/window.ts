import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

// Janela de 24h da WhatsApp Cloud API: cada inbound do user reseta. Dentro da
// janela, outbound é livre-forma e gratuito; fora dela, precisa template
// pré-aprovado. Persiste `last_inbound_at` por user (multi-user friendly,
// embora o MVP seja single-user).

const STORE_PATH = path.resolve('data/whatsapp-window.json');
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface StoreShape {
  // wa_id (E.164 sem +) → ISO8601 do último inbound
  lastInboundByUser: Record<string, string>;
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
    const empty: StoreShape = { lastInboundByUser: {} };
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

export function recordInboundFromUser(userNumber: string): Promise<void> {
  return serialize(async () => {
    const store = await read();
    store.lastInboundByUser[userNumber] = new Date().toISOString();
    await write(store);
  });
}

export function isWindowOpen(userNumber: string): Promise<boolean> {
  return serialize(async () => {
    const store = await read();
    const lastInbound = store.lastInboundByUser[userNumber];
    if (!lastInbound) return false;
    const diffMs = Date.now() - new Date(lastInbound).getTime();
    return diffMs < WINDOW_MS;
  });
}
