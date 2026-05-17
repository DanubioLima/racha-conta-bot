import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { tryReconcile } from "../services/bills/bill.service.js";
import type { IncomingTransaction } from "../services/bills/bill.types.js";

const MOCK_PATH = path.resolve("src/mock/incoming-transactions.json");

async function loadMock(): Promise<IncomingTransaction[]> {
  try {
    await access(MOCK_PATH);
  } catch {
    return [];
  }
  const raw = await readFile(MOCK_PATH, "utf8");
  return JSON.parse(raw) as IncomingTransaction[];
}

async function saveMock(txs: IncomingTransaction[]): Promise<void> {
  await mkdir(path.dirname(MOCK_PATH), { recursive: true });
  await writeFile(MOCK_PATH, JSON.stringify(txs, null, 2), "utf8");
}

async function tick(): Promise<void> {
  const txs = await loadMock();
  const pending = txs.filter((t) => !t.consumed);
  if (pending.length === 0) {
    console.log("[worker] tick — no pending mock transactions");
    return;
  }
  console.log("[worker] tick", { pending: pending.length });
  let dirty = false;
  for (const tx of txs) {
    if (tx.consumed) continue;
    const matched = await tryReconcile(tx);
    if (matched) {
      tx.consumed = true;
      dirty = true;
    }
  }
  if (dirty) {
    await saveMock(txs);
    console.log("[worker] mock state persisted");
  }
}

export function startLedgerWorker(): void {
  console.log(
    `[worker] ledger worker starting (interval ${env.workerIntervalMs}ms)`,
  );
  // Run once on boot, then on interval. Errors are caught so the worker survives.
  const safeTick = () =>
    tick().catch((err) => console.error("[worker] tick failed", err));
  void safeTick();
  setInterval(safeTick, env.workerIntervalMs);
}
