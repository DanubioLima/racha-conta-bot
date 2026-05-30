import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const DB_PATH = process.env.SLICE_DB_PATH ?? path.join(DATA_DIR, 'slice.db');

// Em teste o banco é ':memory:' (sem diretório). Em prod, garante a pasta do arquivo.
if (DB_PATH !== ':memory:') {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

export const db = new Database(DB_PATH);

// WAL deixa leitura e escrita concorrerem sem travar uma à outra (o worker de
// reconciliação lê enquanto o webhook escreve). foreign_keys precisa ser ligado
// por conexão — não é default no SQLite — pra o ON DELETE CASCADE valer.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    phone             TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    pix_key           TEXT NOT NULL DEFAULT '',
    pix_merchant_name TEXT NOT NULL DEFAULT '',
    pix_merchant_city TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bills (
    id               TEXT PRIMARY KEY,
    owner_phone      TEXT NOT NULL REFERENCES users(phone),
    description      TEXT NOT NULL,
    total_amount     REAL NOT NULL,
    amount_per_person REAL NOT NULL,
    status           TEXT NOT NULL,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bills_open_owner ON bills(status, owner_phone);

  CREATE TABLE IF NOT EXISTS participants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id     TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    amount_due  REAL NOT NULL,
    status      TEXT NOT NULL,
    pix_payload TEXT NOT NULL,
    paid_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_participants_bill ON participants(bill_id);

  CREATE TABLE IF NOT EXISTS processed_transactions (
    transaction_id TEXT PRIMARY KEY,
    processed_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS unknown_intents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    phone      TEXT NOT NULL,
    text       TEXT NOT NULL,
    registered INTEGER NOT NULL
  );
`);
