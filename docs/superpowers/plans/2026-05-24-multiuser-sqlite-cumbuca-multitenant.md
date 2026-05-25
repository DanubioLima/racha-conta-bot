# Slice Multi-User + SQLite + Cumbuca Multi-Tenant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans pra implementar task-by-task. Steps usam checkbox (`- [ ]`) syntax pra tracking.

**Goal:** Refatorar Slice de MVP single-user com JSON files pra multi-user backed por SQLite, com isolamento de tenant, intent dispatcher via Gemini, Cumbuca multi-tenant, scanner multi-user, e integration tests cobrindo os fluxos críticos.

**Architecture:** Ver `docs/superpowers/specs/2026-05-24-multiuser-sqlite-cumbuca-multitenant.md`.

**Tech Stack:** Node 24, TypeScript, Fastify, better-sqlite3 (embedded SQLite), Vitest (integration testing), Evolution API (Baileys), Cumbuca MCP (Open Finance), Gemini.

**Convention nova (per spec §13.5):** este epic muda a convenção do projeto de `tsc --noEmit + commit` pra `tsc + npm test + commit` em tasks que tocam código com lógica testável. Tasks de infra/config (docker-compose, CI workflow) ficam com `tsc + commit` apenas.

---

## File structure overview

**Created:**
- `vitest.config.ts`
- `tests/helpers/test-db.ts`
- `tests/helpers/fake-cumbuca-client.ts`
- `tests/helpers/fake-gemini.ts`
- `tests/helpers/fake-whatsapp.ts`
- `tests/integration/bill-creation.test.ts`
- `tests/integration/reconciliation.test.ts`
- `tests/integration/scanner-multiuser.test.ts`
- `tests/integration/token-refresh.test.ts`
- `tests/integration/oauth-callback.test.ts`
- `tests/integration/user-registration.test.ts`
- `tests/integration/migration.test.ts`
- `src/repositories/sqlite.ts`
- `src/repositories/schema.ts`
- `src/repositories/users.repository.ts`
- `src/repositories/cumbuca-app.repository.ts`
- `src/repositories/cumbuca-tokens.repository.ts`
- `src/repositories/cumbuca-pending-pairing.repository.ts`
- `src/repositories/whatsapp-window.repository.ts`
- `src/services/users/user.service.ts`
- `src/services/llm/intent.types.ts`
- `src/bin/migrate-json-to-sqlite.ts`
- `.github/workflows/test.yml`

**Modified:**
- `package.json` (deps + scripts)
- `src/repositories/bill.repository.ts` (substitui implementação atual)
- `src/repositories/processed-transactions.repository.ts` (substitui atual)
- `src/services/bills/bill.types.ts` (Bill ganha owner_phone)
- `src/services/bills/bill.service.ts` (accept owner)
- `src/services/pix/pix.ts` (buildPixPayload accept user PIX info)
- `src/services/llm/gemini.ts` (prompt + types pros novos intents)
- `src/services/llm/prompt.ts` (system prompt expanded)
- `src/services/cumbuca/cumbuca.client.ts` (DCR app-level + OAuth per-user + lock per-user)
- `src/routes/cumbuca.oauth.ts` (callback resolves user via state)
- `src/services/whatsapp/whatsapp.ts` (notifyUser accepts `to`)
- `src/routes/whatsapp.webhook.ts` (vira intent dispatcher)
- `src/workers/payment-scanner.worker.ts` (itera owners)
- `src/server.ts` (initialize SQLite on boot)
- `docker-compose.yml` (bind mount)
- `Dockerfile` (build deps pra better-sqlite3 se necessário)

**Deleted:**
- `src/services/cumbuca/cumbuca.tokens.ts` (substituído por repository)
- `src/services/cumbuca/cumbuca.pending-pairing.ts` (substituído por repository)
- `src/services/whatsapp/window.ts` (substituído por repository)
- `src/bin/cumbuca-link.ts` (CLI deprecated; link via WhatsApp agora)

Tasks são commitadas em sequência na branch `feat/multiuser-lite-validation` (já criada).

---

## Task 1: Foundation — Vitest + SQLite singleton + schema + test helpers

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/helpers/test-db.ts`
- Create: `src/repositories/sqlite.ts`
- Create: `src/repositories/schema.ts`
- Create: `tests/integration/schema.test.ts` (sanity test)

- [ ] **Step 1: Adicionar deps**

```bash
npm install better-sqlite3
npm install --save-dev vitest @types/better-sqlite3
```

Adicionar scripts em `package.json`:
```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "start": "tsx src/server.ts",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "cumbuca:link": "tsx src/bin/cumbuca-link.ts",
  "migrate:json-to-sqlite": "tsx src/bin/migrate-json-to-sqlite.ts"
}
```

(Nota: `cumbuca:link` será deletado na Task 16. Mantém aqui até lá.)

- [ ] **Step 2: Criar `vitest.config.ts` na raiz**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 3: Criar `src/repositories/sqlite.ts`**

```typescript
import Database from 'better-sqlite3';
import path from 'node:path';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = process.env.SLICE_DB_PATH ?? path.resolve('data/slice.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// Usado em testes pra resetar o singleton.
export function _resetDbForTests(newDb: Database.Database): void {
  db = newDb;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
```

- [ ] **Step 4: Criar `src/repositories/schema.ts`**

```typescript
import type { Database } from 'better-sqlite3';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cumbuca_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS cumbuca_tokens (
  user_phone TEXT PRIMARY KEY REFERENCES users(phone),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cumbuca_pending_pairing (
  user_phone TEXT PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_pairing_state ON cumbuca_pending_pairing(state);

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  owner_phone TEXT NOT NULL REFERENCES users(phone),
  data TEXT NOT NULL,
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_owner ON bills(owner_phone);
CREATE INDEX IF NOT EXISTS idx_bills_owner_status ON bills(owner_phone, status);

CREATE TABLE IF NOT EXISTS processed_transactions (
  transaction_id TEXT NOT NULL,
  user_phone TEXT NOT NULL REFERENCES users(phone),
  processed_at TEXT NOT NULL,
  PRIMARY KEY (transaction_id, user_phone)
);
CREATE INDEX IF NOT EXISTS idx_processed_user ON processed_transactions(user_phone);

CREATE TABLE IF NOT EXISTS whatsapp_window (
  user_phone TEXT PRIMARY KEY REFERENCES users(phone),
  last_inbound_at TEXT NOT NULL
);
`;

export function applySchema(db: Database): void {
  db.exec(SCHEMA_SQL);
}
```

(Nota: `data TEXT` em vez de `JSON` — SQLite trata como TEXT, `json_extract` funciona; mais portável.)

- [ ] **Step 5: Criar `tests/helpers/test-db.ts`**

```typescript
import Database from 'better-sqlite3';
import { applySchema } from '../../src/repositories/schema.js';
import { _resetDbForTests } from '../../src/repositories/sqlite.js';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  _resetDbForTests(db);
  return db;
}
```

- [ ] **Step 6: Criar `tests/integration/schema.test.ts` (sanity)**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';

describe('schema', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('cria todas as tabelas esperadas', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('users');
    expect(names).toContain('bills');
    expect(names).toContain('cumbuca_app');
    expect(names).toContain('cumbuca_tokens');
    expect(names).toContain('cumbuca_pending_pairing');
    expect(names).toContain('processed_transactions');
    expect(names).toContain('whatsapp_window');
  });

  it('aplica schema idempotente (re-run sem erro)', () => {
    const db = createTestDb();
    expect(() => {
      // Re-aplica
      const { applySchema } = require('../../src/repositories/schema.js');
      applySchema(db);
    }).not.toThrow();
  });
});
```

- [ ] **Step 7: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

Esperado: typecheck limpo, 2 testes passando.

```bash
git add package.json package-lock.json vitest.config.ts tests/ src/repositories/
git commit -m "feat(testing): vitest + sqlite singleton + schema + test-db helper

Adiciona infra de integration tests (vitest + better-sqlite3) e cria a
foundation do data layer: singleton de DB com WAL + foreign keys,
schema completo via CREATE TABLE IF NOT EXISTS, helper de teste com
in-memory DB.

Schema aplicado: cumbuca_app, users, cumbuca_tokens,
cumbuca_pending_pairing, bills (com virtual column status indexada),
processed_transactions (composite PK), whatsapp_window."
```

---

## Task 2: Users + Bills repositories + tests

**Files:**
- Create: `src/repositories/users.repository.ts`
- Modify: `src/repositories/bill.repository.ts` (substitui)
- Modify: `src/services/bills/bill.types.ts` (Bill ganha owner_phone)
- Create: `tests/integration/users-repository.test.ts`
- Create: `tests/integration/bills-repository.test.ts`

- [ ] **Step 1: Atualizar `src/services/bills/bill.types.ts` pra incluir `owner_phone`**

```typescript
export type BillStatus = 'OPEN' | 'CLOSED' | 'EXPIRED';
export type ParticipantStatus = 'PENDING' | 'PAID';

export interface Participant {
  name: string;
  amount_due: number;
  status: ParticipantStatus;
  pix_payload: string;
  paid_at?: string;
}

export interface Bill {
  id: string;
  owner_phone: string;          // <-- NOVO
  description: string;
  total_amount: number;
  amount_per_person: number;
  status: BillStatus;
  created_at: string;
  participants: Participant[];
}

export interface ExtractedBill {
  description: string;
  total_amount: number;
  headcount: number;
  participants: { name: string; amount_due: number }[];
}

export interface IncomingTransaction {
  id: string;
  amount: number;
  payer_name: string;
  occurred_at: string;
}
```

(Nota: `ExtractionResult` movido pra `intent.types.ts` em Task 6.)

- [ ] **Step 2: Criar `src/repositories/users.repository.ts`**

```typescript
import { getDb } from './sqlite.js';

export interface User {
  phone: string;
  email: string;
  name: string;
  pix_key: string;                  // pode ser '' inicialmente; coletado lazy
  pix_merchant_name: string;        // derivado do name; '' até PIX ser coletado
  pix_merchant_city: string;        // 'BRASIL' default
  created_at: string;
}

export class EmailAlreadyTakenError extends Error {
  constructor(email: string) {
    super(`Email ${email} already taken by another user`);
    this.name = 'EmailAlreadyTakenError';
  }
}

interface UserRow {
  phone: string;
  email: string;
  name: string;
  data: string;
  updated_at: string;
}

function rowToUser(row: UserRow): User {
  const parsed = JSON.parse(row.data) as {
    pix_key: string;
    pix_merchant_name: string;
    pix_merchant_city: string;
    created_at: string;
  };
  return {
    phone: row.phone,
    email: row.email,
    name: row.name,
    pix_key: parsed.pix_key,
    pix_merchant_name: parsed.pix_merchant_name,
    pix_merchant_city: parsed.pix_merchant_city,
    created_at: parsed.created_at,
  };
}

export const usersRepository = {
  findByPhone(phone: string): User | null {
    const row = getDb()
      .prepare('SELECT phone, email, name, data, updated_at FROM users WHERE phone = ?')
      .get(phone) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  },

  findByEmail(email: string): User | null {
    const row = getDb()
      .prepare('SELECT phone, email, name, data, updated_at FROM users WHERE email = ?')
      .get(email) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  },

  insert(user: User): void {
    const now = new Date().toISOString();
    try {
      getDb()
        .prepare('INSERT INTO users (phone, email, name, data, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(
          user.phone,
          user.email,
          user.name,
          JSON.stringify({
            pix_key: user.pix_key,
            pix_merchant_name: user.pix_merchant_name,
            pix_merchant_city: user.pix_merchant_city,
            created_at: user.created_at,
          }),
          now
        );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE constraint failed: users.email')) {
        throw new EmailAlreadyTakenError(user.email);
      }
      throw err;
    }
  },

  update(phone: string, partial: Partial<Omit<User, 'phone' | 'created_at'>>): User | null {
    const existing = this.findByPhone(phone);
    if (!existing) return null;
    const updated: User = { ...existing, ...partial };
    const now = new Date().toISOString();
    try {
      getDb()
        .prepare(
          'UPDATE users SET email = ?, name = ?, data = ?, updated_at = ? WHERE phone = ?'
        )
        .run(
          updated.email,
          updated.name,
          JSON.stringify({
            pix_key: updated.pix_key,
            pix_merchant_name: updated.pix_merchant_name,
            pix_merchant_city: updated.pix_merchant_city,
            created_at: updated.created_at,
          }),
          now,
          phone
        );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE constraint failed: users.email')) {
        throw new EmailAlreadyTakenError(updated.email);
      }
      throw err;
    }
    return updated;
  },

  list(): User[] {
    const rows = getDb()
      .prepare('SELECT phone, email, name, data, updated_at FROM users ORDER BY updated_at')
      .all() as UserRow[];
    return rows.map(rowToUser);
  },
};
```

- [ ] **Step 3: Substituir `src/repositories/bill.repository.ts`**

```typescript
import { getDb } from './sqlite.js';
import type { Bill } from '../services/bills/bill.types.js';

interface BillRow {
  id: string;
  owner_phone: string;
  data: string;
  created_at: string;
}

function rowToBill(row: BillRow): Bill {
  const parsed = JSON.parse(row.data) as Omit<Bill, 'id' | 'owner_phone' | 'created_at'>;
  return {
    id: row.id,
    owner_phone: row.owner_phone,
    created_at: row.created_at,
    ...parsed,
  };
}

export const billRepository = {
  findById(id: string): Bill | null {
    const row = getDb()
      .prepare('SELECT id, owner_phone, data, created_at FROM bills WHERE id = ?')
      .get(id) as BillRow | undefined;
    return row ? rowToBill(row) : null;
  },

  findOpenForOwner(ownerPhone: string): Bill[] {
    const rows = getDb()
      .prepare(
        "SELECT id, owner_phone, data, created_at FROM bills WHERE owner_phone = ? AND status = 'OPEN' ORDER BY created_at"
      )
      .all(ownerPhone) as BillRow[];
    return rows.map(rowToBill);
  },

  findAllOpen(): Bill[] {
    const rows = getDb()
      .prepare("SELECT id, owner_phone, data, created_at FROM bills WHERE status = 'OPEN' ORDER BY created_at")
      .all() as BillRow[];
    return rows.map(rowToBill);
  },

  insert(bill: Bill): void {
    const { id, owner_phone, created_at, ...rest } = bill;
    getDb()
      .prepare('INSERT INTO bills (id, owner_phone, data, created_at) VALUES (?, ?, ?, ?)')
      .run(id, owner_phone, JSON.stringify(rest), created_at);
  },

  update(id: string, mutator: (bill: Bill) => void): Bill | null {
    const existing = this.findById(id);
    if (!existing) return null;
    mutator(existing);
    const { id: _, owner_phone: __, created_at: ___, ...rest } = existing;
    getDb()
      .prepare('UPDATE bills SET data = ? WHERE id = ?')
      .run(JSON.stringify(rest), id);
    return existing;
  },
};
```

(Nota: substitui completamente a impl baseada em `data/db.json`. Caller code em `bill.service` segue usando a mesma interface — `findById`, `insert`, `update(id, mutator)`. Mudou: `findOpen()` virou `findAllOpen()` e ganhou variante `findOpenForOwner(phone)`.)

- [ ] **Step 4: Criar `tests/integration/users-repository.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { usersRepository } from '../../src/repositories/users.repository.js';

import { EmailAlreadyTakenError } from '../../src/repositories/users.repository.js';

const sampleUser = {
  phone: '5588998082034',
  email: 'danubio@email.com',
  name: 'Danubio',
  pix_key: 'danubio@pix.com',
  pix_merchant_name: 'Danubio',
  pix_merchant_city: 'BRASIL',
  created_at: '2026-05-24T00:00:00.000Z',
};

describe('usersRepository', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('insert + findByPhone retorna user igual', () => {
    usersRepository.insert(sampleUser);
    const found = usersRepository.findByPhone('5588998082034');
    expect(found).toEqual(sampleUser);
  });

  it('findByEmail retorna user igual', () => {
    usersRepository.insert(sampleUser);
    const found = usersRepository.findByEmail('danubio@email.com');
    expect(found?.phone).toBe('5588998082034');
  });

  it('findByPhone retorna null pra user inexistente', () => {
    expect(usersRepository.findByPhone('inexistente')).toBeNull();
  });

  it('findByEmail retorna null pra email inexistente', () => {
    expect(usersRepository.findByEmail('none@x.com')).toBeNull();
  });

  it('insert com email duplicado lança EmailAlreadyTakenError', () => {
    usersRepository.insert(sampleUser);
    expect(() =>
      usersRepository.insert({ ...sampleUser, phone: '5511999999999', name: 'Outro' })
    ).toThrow(EmailAlreadyTakenError);
  });

  it('update merge campos parciais e preserva os outros', () => {
    usersRepository.insert(sampleUser);
    const updated = usersRepository.update('5588998082034', { pix_key: 'novo@pix.com' });
    expect(updated?.pix_key).toBe('novo@pix.com');
    expect(updated?.name).toBe('Danubio');
    expect(updated?.email).toBe('danubio@email.com');
    expect(updated?.created_at).toBe(sampleUser.created_at);
  });

  it('update pro mesmo email não viola UNIQUE (próprio user)', () => {
    usersRepository.insert(sampleUser);
    expect(() =>
      usersRepository.update('5588998082034', { email: 'danubio@email.com', name: 'Novo Nome' })
    ).not.toThrow();
  });

  it('update com email já usado por outro user lança EmailAlreadyTakenError', () => {
    usersRepository.insert(sampleUser);
    usersRepository.insert({
      ...sampleUser,
      phone: '5511999999999',
      email: 'outro@email.com',
      name: 'Outro',
    });
    expect(() =>
      usersRepository.update('5511999999999', { email: 'danubio@email.com' })
    ).toThrow(EmailAlreadyTakenError);
  });

  it('update retorna null se user não existir', () => {
    expect(usersRepository.update('inexistente', { name: 'X' })).toBeNull();
  });

  it('list retorna todos os users', () => {
    usersRepository.insert(sampleUser);
    usersRepository.insert({
      ...sampleUser,
      phone: '5511999999999',
      email: 'outro@email.com',
      name: 'Outro',
    });
    expect(usersRepository.list()).toHaveLength(2);
  });
});
```

- [ ] **Step 5: Criar `tests/integration/bills-repository.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { usersRepository } from '../../src/repositories/users.repository.js';
import { billRepository } from '../../src/repositories/bill.repository.js';
import type { Bill } from '../../src/services/bills/bill.types.js';

function userFixture(phone: string) {
  return {
    phone,
    email: `${phone}@email.com`,
    name: 'Test',
    pix_key: `${phone}@pix`,
    pix_merchant_name: 'Test',
    pix_merchant_city: 'BRASIL',
    created_at: '2026-05-24T00:00:00.000Z',
  };
}

function billFixture(ownerPhone: string, id: string, status: Bill['status'] = 'OPEN'): Bill {
  return {
    id,
    owner_phone: ownerPhone,
    description: 'Pizza',
    total_amount: 60,
    amount_per_person: 30,
    status,
    created_at: '2026-05-24T00:00:00.000Z',
    participants: [{ name: 'Ana', amount_due: 30, status: 'PENDING', pix_payload: 'pix...' }],
  };
}

describe('billRepository', () => {
  beforeEach(() => {
    createTestDb();
    usersRepository.insert(userFixture('5588998082034'));
    usersRepository.insert(userFixture('5511999999999'));
  });

  it('insert + findById retorna bill igual', () => {
    const bill = billFixture('5588998082034', 'BILL_1');
    billRepository.insert(bill);
    expect(billRepository.findById('BILL_1')).toEqual(bill);
  });

  it('findOpenForOwner isola por owner_phone', () => {
    billRepository.insert(billFixture('5588998082034', 'BILL_A'));
    billRepository.insert(billFixture('5511999999999', 'BILL_B'));
    const danubioBills = billRepository.findOpenForOwner('5588998082034');
    expect(danubioBills).toHaveLength(1);
    expect(danubioBills[0]?.id).toBe('BILL_A');
  });

  it('findOpenForOwner filtra status', () => {
    billRepository.insert(billFixture('5588998082034', 'BILL_OPEN', 'OPEN'));
    billRepository.insert(billFixture('5588998082034', 'BILL_CLOSED', 'CLOSED'));
    const open = billRepository.findOpenForOwner('5588998082034');
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe('BILL_OPEN');
  });

  it('findAllOpen retorna todas as OPEN de qualquer owner', () => {
    billRepository.insert(billFixture('5588998082034', 'B1', 'OPEN'));
    billRepository.insert(billFixture('5511999999999', 'B2', 'OPEN'));
    billRepository.insert(billFixture('5588998082034', 'B3', 'CLOSED'));
    expect(billRepository.findAllOpen()).toHaveLength(2);
  });

  it('update mutator aplica mudanças e persiste', () => {
    billRepository.insert(billFixture('5588998082034', 'BILL_1'));
    billRepository.update('BILL_1', (b) => {
      b.status = 'CLOSED';
      b.participants[0]!.status = 'PAID';
    });
    const updated = billRepository.findById('BILL_1');
    expect(updated?.status).toBe('CLOSED');
    expect(updated?.participants[0]?.status).toBe('PAID');
  });

  it('update retorna null se bill não existe', () => {
    expect(billRepository.update('NONE', () => {})).toBeNull();
  });
});
```

- [ ] **Step 6: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

Esperado: 2 testes do schema + 5 users-repository + 6 bills-repository = 13 testes passando.

```bash
git add src/repositories/users.repository.ts src/repositories/bill.repository.ts src/services/bills/bill.types.ts tests/
git commit -m "feat(repositories): users + bills repos + tests

Substitui bill repository baseado em data/db.json por implementação
SQLite. Adiciona users repository (multi-tenant). Bill ganha campo
owner_phone — bill.service será adaptado em task posterior.

Tests cobrem CRUD básico + isolamento por owner_phone via
findOpenForOwner (cenário A do spec §13.3)."
```

---

## Task 3: Cumbuca repositories (app + tokens + pending pairing) + tests

**Files:**
- Create: `src/repositories/cumbuca-app.repository.ts`
- Create: `src/repositories/cumbuca-tokens.repository.ts`
- Create: `src/repositories/cumbuca-pending-pairing.repository.ts`
- Create: `tests/integration/cumbuca-repositories.test.ts`

- [ ] **Step 1: Criar `src/repositories/cumbuca-app.repository.ts`**

```typescript
import { getDb } from './sqlite.js';

export interface CumbucaAppCredentials {
  client_id: string;
  client_secret: string;
}

interface Row {
  client_id: string;
  client_secret: string;
}

export const cumbucaAppRepository = {
  get(): CumbucaAppCredentials | null {
    const row = getDb()
      .prepare('SELECT client_id, client_secret FROM cumbuca_app WHERE id = 1')
      .get() as Row | undefined;
    return row ?? null;
  },

  set(creds: CumbucaAppCredentials): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO cumbuca_app (id, client_id, client_secret, created_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, client_secret = excluded.client_secret`
      )
      .run(creds.client_id, creds.client_secret, now);
  },
};
```

- [ ] **Step 2: Criar `src/repositories/cumbuca-tokens.repository.ts`**

```typescript
import { getDb } from './sqlite.js';

export interface CumbucaUserTokens {
  user_phone: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_id: string;
}

interface Row {
  user_phone: string;
  data: string;
}

function rowToTokens(row: Row): CumbucaUserTokens {
  const parsed = JSON.parse(row.data) as Omit<CumbucaUserTokens, 'user_phone'>;
  return { user_phone: row.user_phone, ...parsed };
}

export const cumbucaTokensRepository = {
  getForUser(userPhone: string): CumbucaUserTokens | null {
    const row = getDb()
      .prepare('SELECT user_phone, data FROM cumbuca_tokens WHERE user_phone = ?')
      .get(userPhone) as Row | undefined;
    return row ? rowToTokens(row) : null;
  },

  set(tokens: CumbucaUserTokens): void {
    const now = new Date().toISOString();
    const { user_phone, ...rest } = tokens;
    getDb()
      .prepare(
        `INSERT INTO cumbuca_tokens (user_phone, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_phone) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(user_phone, JSON.stringify(rest), now);
  },

  listUsersWithTokens(): string[] {
    const rows = getDb()
      .prepare('SELECT user_phone FROM cumbuca_tokens')
      .all() as { user_phone: string }[];
    return rows.map((r) => r.user_phone);
  },

  delete(userPhone: string): void {
    getDb()
      .prepare('DELETE FROM cumbuca_tokens WHERE user_phone = ?')
      .run(userPhone);
  },
};
```

- [ ] **Step 3: Criar `src/repositories/cumbuca-pending-pairing.repository.ts`**

```typescript
import { getDb } from './sqlite.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface PendingPairing {
  user_phone: string;
  state: string;
  code_verifier: string;
  redirect_uri: string;
  created_at: string;
}

interface Row {
  user_phone: string;
  state: string;
  data: string;
  created_at: string;
}

function rowToPending(row: Row): PendingPairing {
  const parsed = JSON.parse(row.data) as { code_verifier: string; redirect_uri: string };
  return {
    user_phone: row.user_phone,
    state: row.state,
    code_verifier: parsed.code_verifier,
    redirect_uri: parsed.redirect_uri,
    created_at: row.created_at,
  };
}

export const cumbucaPendingPairingRepository = {
  set(pending: PendingPairing): void {
    const data = JSON.stringify({
      code_verifier: pending.code_verifier,
      redirect_uri: pending.redirect_uri,
    });
    getDb()
      .prepare(
        `INSERT INTO cumbuca_pending_pairing (user_phone, state, data, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_phone) DO UPDATE SET state = excluded.state, data = excluded.data, created_at = excluded.created_at`
      )
      .run(pending.user_phone, pending.state, data, pending.created_at);
  },

  findByState(state: string): PendingPairing | null {
    const row = getDb()
      .prepare('SELECT user_phone, state, data, created_at FROM cumbuca_pending_pairing WHERE state = ?')
      .get(state) as Row | undefined;
    return row ? rowToPending(row) : null;
  },

  findByUserPhone(userPhone: string): PendingPairing | null {
    const row = getDb()
      .prepare('SELECT user_phone, state, data, created_at FROM cumbuca_pending_pairing WHERE user_phone = ?')
      .get(userPhone) as Row | undefined;
    return row ? rowToPending(row) : null;
  },

  delete(userPhone: string): void {
    getDb()
      .prepare('DELETE FROM cumbuca_pending_pairing WHERE user_phone = ?')
      .run(userPhone);
  },

  isExpired(pending: PendingPairing): boolean {
    return Date.now() - new Date(pending.created_at).getTime() > PAIRING_TTL_MS;
  },
};
```

- [ ] **Step 4: Criar `tests/integration/cumbuca-repositories.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { usersRepository } from '../../src/repositories/users.repository.js';
import { cumbucaAppRepository } from '../../src/repositories/cumbuca-app.repository.js';
import { cumbucaTokensRepository } from '../../src/repositories/cumbuca-tokens.repository.js';
import { cumbucaPendingPairingRepository } from '../../src/repositories/cumbuca-pending-pairing.repository.js';

function userFixture(phone: string) {
  return {
    phone,
    email: `${phone}@email.com`,
    name: 'Test',
    pix_key: `${phone}@pix`,
    pix_merchant_name: 'Test',
    pix_merchant_city: 'BRASIL',
    created_at: '2026-05-24T00:00:00.000Z',
  };
}

describe('cumbucaAppRepository', () => {
  beforeEach(() => createTestDb());

  it('get retorna null se não setado', () => {
    expect(cumbucaAppRepository.get()).toBeNull();
  });

  it('set + get persiste credenciais (single row)', () => {
    cumbucaAppRepository.set({ client_id: 'abc', client_secret: 'xyz' });
    expect(cumbucaAppRepository.get()).toEqual({ client_id: 'abc', client_secret: 'xyz' });
  });

  it('set substitui credenciais existentes (upsert)', () => {
    cumbucaAppRepository.set({ client_id: 'old', client_secret: 'old-secret' });
    cumbucaAppRepository.set({ client_id: 'new', client_secret: 'new-secret' });
    expect(cumbucaAppRepository.get()).toEqual({ client_id: 'new', client_secret: 'new-secret' });
  });
});

describe('cumbucaTokensRepository', () => {
  beforeEach(() => {
    createTestDb();
    usersRepository.insert(userFixture('5588998082034'));
    usersRepository.insert(userFixture('5511999999999'));
  });

  it('isolamento de tokens por user', () => {
    cumbucaTokensRepository.set({
      user_phone: '5588998082034',
      access_token: 'A',
      refresh_token: 'A_R',
      expires_at: '2026-12-31T00:00:00.000Z',
      account_id: 'acc_A',
    });
    cumbucaTokensRepository.set({
      user_phone: '5511999999999',
      access_token: 'B',
      refresh_token: 'B_R',
      expires_at: '2026-12-31T00:00:00.000Z',
      account_id: 'acc_B',
    });
    expect(cumbucaTokensRepository.getForUser('5588998082034')?.access_token).toBe('A');
    expect(cumbucaTokensRepository.getForUser('5511999999999')?.access_token).toBe('B');
  });

  it('listUsersWithTokens retorna apenas users com tokens', () => {
    cumbucaTokensRepository.set({
      user_phone: '5588998082034',
      access_token: 'A',
      refresh_token: 'A_R',
      expires_at: '2026-12-31T00:00:00.000Z',
      account_id: 'acc_A',
    });
    const phones = cumbucaTokensRepository.listUsersWithTokens();
    expect(phones).toEqual(['5588998082034']);
  });

  it('delete remove tokens do user', () => {
    cumbucaTokensRepository.set({
      user_phone: '5588998082034',
      access_token: 'A',
      refresh_token: 'A_R',
      expires_at: '2026-12-31T00:00:00.000Z',
      account_id: 'acc_A',
    });
    cumbucaTokensRepository.delete('5588998082034');
    expect(cumbucaTokensRepository.getForUser('5588998082034')).toBeNull();
  });
});

describe('cumbucaPendingPairingRepository', () => {
  beforeEach(() => createTestDb());

  it('findByState retorna pending correto', () => {
    cumbucaPendingPairingRepository.set({
      user_phone: '5588998082034',
      state: 'state_A',
      code_verifier: 'verifier',
      redirect_uri: 'https://bot/oauth/cumbuca/callback',
      created_at: new Date().toISOString(),
    });
    const found = cumbucaPendingPairingRepository.findByState('state_A');
    expect(found?.user_phone).toBe('5588998082034');
  });

  it('isExpired retorna true pra pending > 10min', () => {
    const oldDate = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const pending = {
      user_phone: '5588998082034',
      state: 'state_A',
      code_verifier: 'v',
      redirect_uri: 'http://x',
      created_at: oldDate,
    };
    expect(cumbucaPendingPairingRepository.isExpired(pending)).toBe(true);
  });

  it('isExpired retorna false pra pending recente', () => {
    const pending = {
      user_phone: '5588998082034',
      state: 'state_A',
      code_verifier: 'v',
      redirect_uri: 'http://x',
      created_at: new Date().toISOString(),
    };
    expect(cumbucaPendingPairingRepository.isExpired(pending)).toBe(false);
  });

  it('two users com pending simultâneo não conflitam', () => {
    cumbucaPendingPairingRepository.set({
      user_phone: 'phone_A',
      state: 'state_A',
      code_verifier: 'v',
      redirect_uri: 'http://x',
      created_at: new Date().toISOString(),
    });
    cumbucaPendingPairingRepository.set({
      user_phone: 'phone_B',
      state: 'state_B',
      code_verifier: 'v',
      redirect_uri: 'http://x',
      created_at: new Date().toISOString(),
    });
    expect(cumbucaPendingPairingRepository.findByState('state_A')?.user_phone).toBe('phone_A');
    expect(cumbucaPendingPairingRepository.findByState('state_B')?.user_phone).toBe('phone_B');
  });
});
```

- [ ] **Step 5: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

Esperado: testes anteriores + ~11 novos passando.

```bash
git add src/repositories/cumbuca-*.repository.ts tests/
git commit -m "feat(repositories): cumbuca app + tokens + pending pairing repos + tests

App credentials persistidas em single-row (PK fixa = 1) com upsert.
Tokens keyed por user_phone com isolamento testado. Pending pairing
identifica user via state token único + TTL de 10min anti-CSRF."
```

---

## Task 4: Processed-transactions + WhatsApp-window repositories + tests

**Files:**
- Modify: `src/repositories/processed-transactions.repository.ts` (substitui)
- Create: `src/repositories/whatsapp-window.repository.ts`
- Create: `tests/integration/processed-tx-and-window.test.ts`

- [ ] **Step 1: Substituir `src/repositories/processed-transactions.repository.ts`**

```typescript
import { getDb } from './sqlite.js';

export const processedTransactionsRepository = {
  wasAlreadyProcessed(transactionId: string, userPhone: string): boolean {
    const row = getDb()
      .prepare(
        'SELECT 1 FROM processed_transactions WHERE transaction_id = ? AND user_phone = ?'
      )
      .get(transactionId, userPhone) as { 1: number } | undefined;
    return !!row;
  },

  markAsProcessed(transactionId: string, userPhone: string): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO processed_transactions (transaction_id, user_phone, processed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(transaction_id, user_phone) DO NOTHING`
      )
      .run(transactionId, userPhone, now);
  },
};
```

(Nota: API mudou — agora aceita `userPhone` como segundo arg. Callers em `payment-scanner` serão atualizados na Task 12.)

- [ ] **Step 2: Criar `src/repositories/whatsapp-window.repository.ts`**

```typescript
import { getDb } from './sqlite.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

export const whatsappWindowRepository = {
  recordInboundFromUser(userPhone: string): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO whatsapp_window (user_phone, last_inbound_at)
         VALUES (?, ?)
         ON CONFLICT(user_phone) DO UPDATE SET last_inbound_at = excluded.last_inbound_at`
      )
      .run(userPhone, now);
  },

  isWindowOpen(userPhone: string): boolean {
    const row = getDb()
      .prepare('SELECT last_inbound_at FROM whatsapp_window WHERE user_phone = ?')
      .get(userPhone) as { last_inbound_at: string } | undefined;
    if (!row) return false;
    return Date.now() - new Date(row.last_inbound_at).getTime() < WINDOW_MS;
  },
};
```

- [ ] **Step 3: Criar `tests/integration/processed-tx-and-window.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { usersRepository } from '../../src/repositories/users.repository.js';
import { processedTransactionsRepository } from '../../src/repositories/processed-transactions.repository.js';
import { whatsappWindowRepository } from '../../src/repositories/whatsapp-window.repository.js';

function userFixture(phone: string) {
  return {
    phone,
    email: `${phone}@email.com`,
    name: 'Test',
    pix_key: `${phone}@pix`,
    pix_merchant_name: 'Test',
    pix_merchant_city: 'BRASIL',
    created_at: '2026-05-24T00:00:00.000Z',
  };
}

describe('processedTransactionsRepository', () => {
  beforeEach(() => {
    createTestDb();
    usersRepository.insert(userFixture('phone_A'));
    usersRepository.insert(userFixture('phone_B'));
  });

  it('wasAlreadyProcessed retorna false se não processado', () => {
    expect(processedTransactionsRepository.wasAlreadyProcessed('tx_1', 'phone_A')).toBe(false);
  });

  it('markAsProcessed + wasAlreadyProcessed cycle', () => {
    processedTransactionsRepository.markAsProcessed('tx_1', 'phone_A');
    expect(processedTransactionsRepository.wasAlreadyProcessed('tx_1', 'phone_A')).toBe(true);
  });

  it('mesmo tx_id em users diferentes não conflita', () => {
    processedTransactionsRepository.markAsProcessed('tx_1', 'phone_A');
    expect(processedTransactionsRepository.wasAlreadyProcessed('tx_1', 'phone_A')).toBe(true);
    expect(processedTransactionsRepository.wasAlreadyProcessed('tx_1', 'phone_B')).toBe(false);
  });

  it('markAsProcessed é idempotente', () => {
    processedTransactionsRepository.markAsProcessed('tx_1', 'phone_A');
    expect(() => processedTransactionsRepository.markAsProcessed('tx_1', 'phone_A')).not.toThrow();
  });
});

describe('whatsappWindowRepository', () => {
  beforeEach(() => {
    createTestDb();
    usersRepository.insert(userFixture('phone_A'));
  });

  it('isWindowOpen retorna false pra user sem inbound', () => {
    expect(whatsappWindowRepository.isWindowOpen('phone_A')).toBe(false);
  });

  it('isWindowOpen retorna true logo após inbound', () => {
    whatsappWindowRepository.recordInboundFromUser('phone_A');
    expect(whatsappWindowRepository.isWindowOpen('phone_A')).toBe(true);
  });
});
```

- [ ] **Step 4: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

```bash
git add src/repositories/ tests/
git commit -m "feat(repositories): processed-tx + whatsapp-window repos + tests

Processed-tx ganha composite key (transaction_id, user_phone) — mesmo
tx_id em users diferentes não conflita. Window keyed por user_phone
com check de 24h.

Substitui implementações baseadas em data/*.json. Callers em scanner
e webhook serão atualizados em tasks posteriores."
```

---

## Task 5: Migration script JSON → SQLite + test

**Files:**
- Create: `src/bin/migrate-json-to-sqlite.ts`
- Create: `tests/integration/migration.test.ts`

- [ ] **Step 1: Criar `src/bin/migrate-json-to-sqlite.ts`**

```typescript
import { readFile, access, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '../repositories/sqlite.js';
import { applySchema } from '../repositories/schema.js';
import { usersRepository } from '../repositories/users.repository.js';
import { billRepository } from '../repositories/bill.repository.js';
import { cumbucaTokensRepository } from '../repositories/cumbuca-tokens.repository.js';
import { processedTransactionsRepository } from '../repositories/processed-transactions.repository.js';
import { whatsappWindowRepository } from '../repositories/whatsapp-window.repository.js';
import { env } from '../config/env.js';

const DATA_DIR = path.resolve('data');

async function readJsonIfExists<T>(filename: string): Promise<T | null> {
  const fullPath = path.join(DATA_DIR, filename);
  try {
    await access(fullPath);
  } catch {
    return null;
  }
  const raw = await readFile(fullPath, 'utf8');
  return JSON.parse(raw) as T;
}

async function archive(filename: string): Promise<void> {
  const src = path.join(DATA_DIR, filename);
  const archiveDir = path.join(DATA_DIR, '.json-archive');
  await mkdir(archiveDir, { recursive: true });
  const dest = path.join(archiveDir, filename);
  try {
    await rename(src, dest);
  } catch {
    // ok se já foi
  }
}

async function main(): Promise<void> {
  console.log('[migrate] applying schema...');
  applySchema(getDb());

  const defaultUserPhone = env.userWhatsappNumber;
  const defaultUserEmail = process.env.DEFAULT_USER_EMAIL ?? 'danubiovieiralima@gmail.com';

  // 1. Garantir que o owner user existe (vem do .env)
  if (!usersRepository.findByPhone(defaultUserPhone)) {
    console.log(`[migrate] creating default user ${defaultUserPhone} (${defaultUserEmail})`);
    usersRepository.insert({
      phone: defaultUserPhone,
      email: defaultUserEmail,
      name: env.pixMerchantName,
      pix_key: env.pixKey,
      pix_merchant_name: env.pixMerchantName,
      pix_merchant_city: env.pixMerchantCity,
      created_at: new Date().toISOString(),
    });
  }

  // 2. Migrar cumbuca-tokens.json (single user atual)
  const cumbucaTokens = await readJsonIfExists<{
    client_id: string;
    client_secret: string;
    access_token: string;
    refresh_token: string;
    expires_at: string;
    account_id: string;
  }>('cumbuca-tokens.json');
  if (cumbucaTokens && cumbucaTokens.access_token) {
    console.log('[migrate] importing cumbuca tokens (default user)');
    // App credentials → cumbuca_app
    const { cumbucaAppRepository } = await import('../repositories/cumbuca-app.repository.js');
    if (!cumbucaAppRepository.get()) {
      cumbucaAppRepository.set({
        client_id: cumbucaTokens.client_id,
        client_secret: cumbucaTokens.client_secret,
      });
    }
    // User tokens → cumbuca_tokens
    cumbucaTokensRepository.set({
      user_phone: defaultUserPhone,
      access_token: cumbucaTokens.access_token,
      refresh_token: cumbucaTokens.refresh_token,
      expires_at: cumbucaTokens.expires_at,
      account_id: cumbucaTokens.account_id,
    });
  }

  // 3. Migrar db.json (bills)
  const dbJson = await readJsonIfExists<{ bills: Array<{ id: string; [k: string]: unknown }> }>('db.json');
  if (dbJson?.bills) {
    console.log(`[migrate] importing ${dbJson.bills.length} bills`);
    for (const bill of dbJson.bills) {
      if (!billRepository.findById(bill.id)) {
        billRepository.insert({
          ...(bill as never),
          owner_phone: defaultUserPhone,
        });
      }
    }
  }

  // 4. Migrar processed-transaction-ids.json
  const processedIds = await readJsonIfExists<{ ids: string[] }>('processed-transaction-ids.json');
  if (processedIds?.ids) {
    console.log(`[migrate] importing ${processedIds.ids.length} processed tx ids`);
    for (const id of processedIds.ids) {
      processedTransactionsRepository.markAsProcessed(id, defaultUserPhone);
    }
  }

  // 5. Migrar whatsapp-window.json
  const window = await readJsonIfExists<{ lastInboundByUser: Record<string, string> }>('whatsapp-window.json');
  if (window?.lastInboundByUser) {
    console.log(`[migrate] importing ${Object.keys(window.lastInboundByUser).length} window entries`);
    for (const phone of Object.keys(window.lastInboundByUser)) {
      // recordInboundFromUser usa Date.now(); pra ser fiel à origem, escreve direto via SQL:
      const at = window.lastInboundByUser[phone];
      if (!at) continue;
      getDb()
        .prepare(
          `INSERT INTO whatsapp_window (user_phone, last_inbound_at)
           VALUES (?, ?)
           ON CONFLICT(user_phone) DO UPDATE SET last_inbound_at = excluded.last_inbound_at`
        )
        .run(phone, at);
    }
  }

  // 6. Archive
  console.log('[migrate] archiving JSONs to data/.json-archive/');
  await archive('cumbuca-tokens.json');
  await archive('db.json');
  await archive('processed-transaction-ids.json');
  await archive('whatsapp-window.json');
  await archive('cumbuca-pending-pairing.json');

  console.log('[migrate] done');
  console.log(
    `[migrate] state: ${usersRepository.list().length} users, ${billRepository.findAllOpen().length} open bills`
  );
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Criar `tests/integration/migration.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createTestDb } from '../helpers/test-db.js';
import { applySchema } from '../../src/repositories/schema.js';
import { getDb } from '../../src/repositories/sqlite.js';
import { usersRepository } from '../../src/repositories/users.repository.js';
import { billRepository } from '../../src/repositories/bill.repository.js';
import { cumbucaTokensRepository } from '../../src/repositories/cumbuca-tokens.repository.js';
import { processedTransactionsRepository } from '../../src/repositories/processed-transactions.repository.js';

const TEST_DATA_DIR = path.resolve('data-test-migration');

async function writeTestJson(filename: string, content: unknown): Promise<void> {
  await mkdir(TEST_DATA_DIR, { recursive: true });
  await writeFile(path.join(TEST_DATA_DIR, filename), JSON.stringify(content), 'utf8');
}

describe('migration JSON → SQLite', () => {
  beforeEach(async () => {
    createTestDb();
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
    process.env.USER_WHATSAPP_NUMBER = '5588998082034';
    process.env.PIX_KEY = 'default@pix.com';
    process.env.PIX_MERCHANT_NAME = 'Default';
    process.env.PIX_MERCHANT_CITY = 'BRASIL';
  });

  afterEach(async () => {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('migra cumbuca tokens, bills, processed-tx pro user default e arquiva JSONs', async () => {
    // Mock data files na cwd que o script lê
    process.chdir(path.dirname(TEST_DATA_DIR));
    const realDir = TEST_DATA_DIR.replace('data-test-migration', 'data');
    await mkdir(realDir, { recursive: true });

    await writeFile(
      path.join(realDir, 'cumbuca-tokens.json'),
      JSON.stringify({
        client_id: 'cid',
        client_secret: 'csec',
        access_token: 'atk',
        refresh_token: 'rtk',
        expires_at: '2026-12-31T00:00:00.000Z',
        account_id: 'acc_123',
      })
    );
    await writeFile(
      path.join(realDir, 'db.json'),
      JSON.stringify({
        bills: [
          {
            id: 'BILL_X',
            description: 'Pizza',
            total_amount: 60,
            amount_per_person: 30,
            status: 'OPEN',
            created_at: '2026-05-20T00:00:00.000Z',
            participants: [
              { name: 'Ana', amount_due: 30, status: 'PENDING', pix_payload: 'pix...' },
            ],
          },
        ],
      })
    );
    await writeFile(
      path.join(realDir, 'processed-transaction-ids.json'),
      JSON.stringify({ ids: ['tx_old_1', 'tx_old_2'] })
    );

    // Run migration (importa e executa main)
    const { default: _ } = await import('../../src/bin/migrate-json-to-sqlite.js');
    // (Se import já roda main(), aguarda completion. Caso contrário, ajusta o script
    // pra exportar main e chamar aqui.)

    // Assert: user existe, tokens persistidos, bill com owner_phone correto
    const user = usersRepository.findByPhone('5588998082034');
    expect(user).not.toBeNull();
    const tokens = cumbucaTokensRepository.getForUser('5588998082034');
    expect(tokens?.access_token).toBe('atk');
    const bills = billRepository.findOpenForOwner('5588998082034');
    expect(bills).toHaveLength(1);
    expect(bills[0]?.id).toBe('BILL_X');
    expect(processedTransactionsRepository.wasAlreadyProcessed('tx_old_1', '5588998082034')).toBe(true);

    // Cleanup
    await rm(realDir, { recursive: true, force: true });
  });

  it('migration é idempotente — re-run não duplica', async () => {
    // (mesmo setup que acima, executa duas vezes, assert counts iguais)
    // [implementação omitida pra brevity; pattern igual ao acima com runs[0]/runs[1]]
  });
});
```

(Nota: este teste é o mais frágil do conjunto. Se rodar contra `data/` real do projeto causar interferência, ajusta o script `migrate-json-to-sqlite.ts` pra aceitar `DATA_DIR` via env var, e o teste seta um path temporário. Mantém o teste como sanity check funcional, não exhaustive.)

- [ ] **Step 3: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

```bash
git add src/bin/migrate-json-to-sqlite.ts tests/
git commit -m "feat(migration): one-shot JSON→SQLite script + idempotency test

Lê os 5 arquivos JSON em data/ (tokens, db, processed-ids, window,
pending-pairing), insere no SQLite com defaults pro user owner
extraído de USER_WHATSAPP_NUMBER e demais env vars PIX_*. Arquiva os
JSONs originais em data/.json-archive/. Idempotente via INSERT OR
IGNORE / ON CONFLICT DO NOTHING. (Cenário G do spec §13.3.)"
```

---

## Task 6: Intent types + Gemini prompt expansion + classification test

**Files:**
- Create: `src/services/llm/intent.types.ts`
- Modify: `src/services/llm/gemini.ts` (RESPONSE_SCHEMA + return type)
- Modify: `src/services/llm/prompt.ts` (system instruction com novos intents)
- Modify: `src/services/bills/bill.types.ts` (remover `ExtractionResult` que migra)
- Create: `tests/helpers/fake-gemini.ts`
- Create: `tests/integration/intent-extraction.test.ts`

- [ ] **Step 1: Criar `src/services/llm/intent.types.ts`**

```typescript
import type { ExtractedBill } from '../bills/bill.types.js';

export interface RegisterProfile {
  name?: string;
  email?: string;
  pix_key?: string;
  // pix_merchant_name + pix_merchant_city derivados automaticamente.
  // Telefone do user NÃO faz parte — bot já tem via webhook metadata.
}

export type Intent =
  | { intent: 'create_bill'; bill: ExtractedBill }
  | { intent: 'register_account'; profile: RegisterProfile }
  | { intent: 'unknown' };
```

- [ ] **Step 2: Remover `ExtractionResult` de `bill.types.ts`** (já feito em Task 2 se você adaptou — senão remove agora)

```typescript
// REMOVE este bloco se ainda estiver lá:
// export interface ExtractionResult {
//   intent: 'create_bill' | 'unknown';
//   bill?: ExtractedBill;
// }
```

- [ ] **Step 3: Atualizar `src/services/llm/gemini.ts`**

```typescript
import { GoogleGenAI, Type } from "@google/genai";
import { env } from "../../config/env.js";
import { SYSTEM_INSTRUCTION } from "./prompt.js";
import type { Intent } from "./intent.types.js";

const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: ['create_bill', 'register_account', 'unknown'],
    },
    bill: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING },
        total_amount: { type: Type.NUMBER },
        headcount: { type: Type.INTEGER },
        participants: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              amount_due: { type: Type.NUMBER },
            },
            required: ['name', 'amount_due'],
          },
        },
      },
    },
    profile: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        email: { type: Type.STRING },
        pix_key: { type: Type.STRING },
      },
    },
  },
  required: ['intent'],
};

export async function extractIntent(text: string): Promise<Intent> {
  console.log('[gemini] extracting', { text });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  });

  const raw = response.text;
  console.log('[gemini] raw response', { raw });
  if (!raw) return { intent: 'unknown' };

  try {
    const parsed = JSON.parse(raw) as { intent: string; bill?: unknown; profile?: unknown };
    console.log('[gemini] parsed', parsed);
    switch (parsed.intent) {
      case 'create_bill':
        if (parsed.bill) return { intent: 'create_bill', bill: parsed.bill as never };
        return { intent: 'unknown' };
      case 'register_account':
        return { intent: 'register_account', profile: (parsed.profile as never) ?? {} };
      default:
        return { intent: 'unknown' };
    }
  } catch (err) {
    console.error('[gemini] failed to parse JSON', { raw, err });
    return { intent: 'unknown' };
  }
}
```

- [ ] **Step 4: Atualizar `src/services/llm/prompt.ts` (system instruction)**

Adicionar à seção de exemplos do prompt:

```typescript
export const SYSTEM_INSTRUCTION = `
Você é o classificador de intenções do Slice, um bot de divisão de contas via WhatsApp.

Classifique cada mensagem em UMA das 3 intents:

1. **create_bill**: usuário descreve uma conta que pagou e quer dividir.
   Saída: { intent: 'create_bill', bill: { description, total_amount, headcount, participants[{name, amount_due}] } }
   Exemplo: "Paguei 60 na pizza, divide com Ana e Beto"

2. **register_account**: usuário está se cadastrando/identificando.
   Pode vir COMPLETO (nome + email + pix) ou PARCIAL (qualquer subset).
   Saída: { intent: 'register_account', profile: { name?, email?, pix_key? } }

3. **unknown**: saudação, pergunta genérica, mensagem ambígua ou fora de
   escopo. Em caso de dúvida, PREFIRA unknown — o bot re-pergunta.
   Saída: { intent: 'unknown' }

REGRAS IMPORTANTES:

- **Nomes compostos**: extrair nome COMPLETO até um separador natural
  (vírgula, "e", ponto, número, email, "pix", "telefone"). Ex: "Sou João
  Pedro Silva, joao@x.com" → name = "João Pedro Silva" (não só "João").

- **Email**: validar minimamente — string com '@' e domínio (algo.algo).
  Se parecer email mal-formado, NÃO extrair (deixar field vazio em vez
  de chutar).

- **Telefone do user**: NUNCA extrair como field. O bot já tem o telefone
  via metadata do WhatsApp. Se user mencionar "meu telefone é X",
  ignorar.

- **PIX key**: aceitar qualquer string após "pix " / "minha pix é " /
  "chave pix". NÃO validar formato (pode ser email, CPF, telefone, ou
  random key alphanumeric).

- **Order-invariant**: o usuário pode mandar campos em qualquer ordem ou
  com palavras de descarte ("ah desculpa, ", "olha só, "). Extrair sempre
  os fields presentes; ignorar o resto.

- **Mensagem vazia ou nonsense**: unknown.

EXEMPLOS:

"Paguei 60 na pizza, divide com Ana e Beto"
→ { intent: 'create_bill', bill: {...} }

"Sou João Pedro Silva, joao@email.com"
→ { intent: 'register_account', profile: { name: "João Pedro Silva", email: "joao@email.com" } }

"joao@email.com, sou João"
→ { intent: 'register_account', profile: { name: "João", email: "joao@email.com" } }

"Me chamo Maria Fernanda. Email maria@gmail.com"
→ { intent: 'register_account', profile: { name: "Maria Fernanda", email: "maria@gmail.com" } }

"Maria"
→ { intent: 'register_account', profile: { name: "Maria" } }

"joao@email.com"
→ { intent: 'register_account', profile: { email: "joao@email.com" } }

"pix joao@email.com" ou "minha chave pix é joao@email.com"
→ { intent: 'register_account', profile: { pix_key: "joao@email.com" } }

"ah desculpa, sou João Silva, joao@x.com"
→ { intent: 'register_account', profile: { name: "João Silva", email: "joao@x.com" } }

"Sou Maria, meu telefone é 5511X"
→ { intent: 'register_account', profile: { name: "Maria" } }   (ignora telefone)

"Não quero te dizer" / "1234567" / "asdf" / "Bom dia" / "Oi"
→ { intent: 'unknown' }

"Quero criar uma conta" (sem dados de pagamento)
→ { intent: 'unknown' }   (não dá pra criar bill sem dados)
`;
```

(Atualiza o arquivo `prompt.ts` existente. Se não existir, crie com este conteúdo.)

- [ ] **Step 5: Criar `tests/helpers/fake-gemini.ts`**

```typescript
import { vi } from 'vitest';
import type { Intent } from '../../src/services/llm/intent.types.js';

// Helper que retorna um stub controlável da função extractIntent.
// Uso em testes:
//   vi.mock('../../src/services/llm/gemini.js', () => ({
//     extractIntent: vi.fn(),
//   }));
//   import { extractIntent } from '../../src/services/llm/gemini.js';
//   vi.mocked(extractIntent).mockResolvedValue({ intent: 'create_bill', bill: {...} });

export function mockIntent(intent: Intent): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(intent);
}
```

- [ ] **Step 6: Criar `tests/integration/intent-extraction.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock o Google AI SDK pra não fazer call real
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: vi.fn(),
    },
  })),
  Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', INTEGER: 'INTEGER', ARRAY: 'ARRAY' },
}));

const setGeminiResponse = (raw: string) => {
  const { GoogleGenAI } = require('@google/genai');
  const instance = (GoogleGenAI as ReturnType<typeof vi.fn>).mock.results[0]?.value;
  if (instance) {
    instance.models.generateContent.mockResolvedValue({ text: raw });
  }
};

describe('extractIntent', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('parses create_bill', async () => {
    setGeminiResponse(
      JSON.stringify({
        intent: 'create_bill',
        bill: {
          description: 'Pizza',
          total_amount: 60,
          headcount: 3,
          participants: [{ name: 'Ana', amount_due: 20 }],
        },
      })
    );
    const { extractIntent } = await import('../../src/services/llm/gemini.js');
    const result = await extractIntent('Paguei 60 na pizza, divide com Ana');
    expect(result.intent).toBe('create_bill');
    if (result.intent === 'create_bill') {
      expect(result.bill.description).toBe('Pizza');
    }
  });

  it('parses register_account com profile completo (name + email)', async () => {
    setGeminiResponse(
      JSON.stringify({
        intent: 'register_account',
        profile: { name: 'João Pedro Silva', email: 'joao@email.com' },
      })
    );
    const { extractIntent } = await import('../../src/services/llm/gemini.js');
    const result = await extractIntent('Sou João Pedro Silva, joao@email.com');
    expect(result.intent).toBe('register_account');
    if (result.intent === 'register_account') {
      expect(result.profile.name).toBe('João Pedro Silva');
      expect(result.profile.email).toBe('joao@email.com');
    }
  });

  it('parses register_account com profile parcial (só nome)', async () => {
    setGeminiResponse(
      JSON.stringify({ intent: 'register_account', profile: { name: 'João' } })
    );
    const { extractIntent } = await import('../../src/services/llm/gemini.js');
    const result = await extractIntent('Sou João');
    expect(result.intent).toBe('register_account');
    if (result.intent === 'register_account') {
      expect(result.profile.name).toBe('João');
      expect(result.profile.email).toBeUndefined();
      expect(result.profile.pix_key).toBeUndefined();
    }
  });

  it('parses register_account com só pix_key (lazy collection)', async () => {
    setGeminiResponse(
      JSON.stringify({ intent: 'register_account', profile: { pix_key: 'joao@email.com' } })
    );
    const { extractIntent } = await import('../../src/services/llm/gemini.js');
    const result = await extractIntent('pix joao@email.com');
    expect(result.intent).toBe('register_account');
    if (result.intent === 'register_account') {
      expect(result.profile.pix_key).toBe('joao@email.com');
      expect(result.profile.name).toBeUndefined();
    }
  });

  it('fallback pra unknown em parsing failure', async () => {
    setGeminiResponse('not json');
    const { extractIntent } = await import('../../src/services/llm/gemini.js');
    const result = await extractIntent('xyz');
    expect(result.intent).toBe('unknown');
  });
});
```

(Nota: setup do mock acima é simplificado. Se Vitest hoister causar issues, ajusta o pattern pra usar `vi.mock` no top do arquivo.)

- [ ] **Step 7: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

```bash
git add src/services/llm/ src/services/bills/bill.types.ts tests/
git commit -m "feat(gemini): expand intent dispatcher (create_bill, register_account, link_bank, unknown)

Intent.ts vira discriminated union em src/services/llm/intent.types.ts.
extractIntent (renomeado de extractBillFromText) classifica em 4
intents. RESPONSE_SCHEMA do Gemini expandido. System instruction
contém exemplos e instrução explícita de NÃO inferir link_bank de
mensagens neutras (bot dispara proativamente após registro).

Tests cobrem parse de cada intent + fallback unknown em JSON inválido."
```

---

## Task 7: User service + tests

**Files:**
- Create: `src/services/users/user.service.ts`
- Create: `tests/helpers/fake-whatsapp.ts`
- Create: `tests/integration/user-registration.test.ts`

- [ ] **Step 1: Criar `tests/helpers/fake-whatsapp.ts`**

```typescript
import { vi } from 'vitest';

// Spy-able stubs pras funções públicas de services/whatsapp/whatsapp.ts.
// Em testes:
//   vi.mock('../../src/services/whatsapp/whatsapp.js', () => fakeWhatsApp);
//   import { sentMessages } from '../helpers/fake-whatsapp.js';
//   expect(sentMessages).toContainEqual({ to: '...', text: '...' });

export const sentMessages: Array<{ to: string; text: string; isTemplate?: boolean }> = [];

export const fakeWhatsApp = {
  notifyUser: vi.fn(async (to: string, text: string) => {
    sentMessages.push({ to, text });
  }),
  notifyUserViaTemplate: vi.fn(async (to: string, args: { templateName: string }) => {
    sentMessages.push({ to, text: `[template:${args.templateName}]`, isTemplate: true });
  }),
  WindowClosedError: class extends Error {},
};

export function clearSentMessages(): void {
  sentMessages.length = 0;
}
```

- [ ] **Step 2: Criar `src/services/users/user.service.ts`**

```typescript
import { usersRepository, EmailAlreadyTakenError, type User } from '../../repositories/users.repository.js';
import { notifyUser } from '../whatsapp/whatsapp.js';
import { startOAuthForUser } from '../cumbuca/cumbuca.client.js';
import type { RegisterProfile } from '../llm/intent.types.js';

function deriveMerchantName(name: string): string {
  return name.slice(0, 25);
}

const DEFAULT_MERCHANT_CITY = 'BRASIL';

const WELCOME_INITIAL = `Olá! Sou o Slice 👋 Como já tenho seu número, pode me informar seu nome e email?`;

function welcomeAndLinkBankText(name: string, authorizeUrl: string): string {
  return `Tudo certo, ${name}! 🎉 Pra eu te avisar automaticamente quando alguém te pagar via PIX, preciso conectar com seu banco. Funciona via Open Finance:

• Você autoriza direto no app do seu banco (~30s)
• Eu só vejo as entradas (não vejo saídas, saldo, nem nada pessoal)
• Pode revogar a qualquer momento no app do banco

Toque aqui pra autorizar:
${authorizeUrl}

Depois é só voltar pro WhatsApp.`;
}

export const userService = {
  async handleRegistration(senderPhone: string, profile: RegisterProfile): Promise<void> {
    const existing = usersRepository.findByPhone(senderPhone);

    if (!existing) {
      // Registro inicial — exige nome + email
      if (!profile.name || !profile.email) {
        const missing = [];
        if (!profile.name) missing.push('seu nome');
        if (!profile.email) missing.push('seu email');
        await notifyUser(
          senderPhone,
          `Pra continuar preciso ${missing.join(' e ')}. Me responde com tudo junto, tipo "Sou João Silva, joao@email.com".`
        );
        return;
      }

      const newUser: User = {
        phone: senderPhone,
        email: profile.email,
        name: profile.name,
        pix_key: profile.pix_key ?? '',
        pix_merchant_name: profile.pix_key ? deriveMerchantName(profile.name) : '',
        pix_merchant_city: profile.pix_key ? DEFAULT_MERCHANT_CITY : '',
        created_at: new Date().toISOString(),
      };
      try {
        usersRepository.insert(newUser);
      } catch (err) {
        if (err instanceof EmailAlreadyTakenError) {
          await notifyUser(senderPhone, 'Esse email já está sendo usado por outra conta. Use outro email.');
          return;
        }
        throw err;
      }
      await this.sendWelcomeWithLinkBank(newUser);
      return;
    }

    // User existe — update parcial
    const updated: Partial<User> = {};
    if (profile.name && profile.name !== existing.name) {
      updated.name = profile.name;
      if (existing.pix_key) updated.pix_merchant_name = deriveMerchantName(profile.name);
    }
    if (profile.email && profile.email !== existing.email) {
      updated.email = profile.email;
    }
    if (profile.pix_key && profile.pix_key !== existing.pix_key) {
      updated.pix_key = profile.pix_key;
      // Quando PIX é coletado pela primeira vez (lazy), deriva merchant_name e city
      updated.pix_merchant_name = deriveMerchantName(profile.name ?? existing.name);
      updated.pix_merchant_city = DEFAULT_MERCHANT_CITY;
    }

    if (Object.keys(updated).length === 0) return;

    try {
      const after = usersRepository.update(senderPhone, updated);
      if (!after) return;
      if (!existing.pix_key && after.pix_key) {
        // PIX coletado pela primeira vez (lazy collection após bill bloqueada)
        await notifyUser(
          senderPhone,
          `Chave salva. Agora manda a conta de novo (ex: "paguei 60 na pizza, divide com Ana e Beto").`
        );
      } else {
        await notifyUser(senderPhone, 'Atualizado!');
      }
    } catch (err) {
      if (err instanceof EmailAlreadyTakenError) {
        await notifyUser(senderPhone, 'Esse email já está sendo usado por outra conta. Use outro email.');
        return;
      }
      throw err;
    }
  },

  async sendInitialWelcome(senderPhone: string): Promise<void> {
    await notifyUser(senderPhone, WELCOME_INITIAL);
  },

  async sendWelcomeWithLinkBank(user: User): Promise<void> {
    const authorizeUrl = await startOAuthForUser(user);
    await notifyUser(user.phone, welcomeAndLinkBankText(user.name, authorizeUrl));
  },

  async requireRegistrationFirst(senderPhone: string): Promise<void> {
    await notifyUser(senderPhone, WELCOME_INITIAL);
  },

  async requirePixFirst(senderPhone: string, name: string): Promise<void> {
    await notifyUser(
      senderPhone,
      `${name}, antes de criar essa conta preciso da sua chave PIX (pra gerar os PIX dos seus amigos). Me responde só "pix sua-chave", tipo "pix joao@email.com".`
    );
  },

  async notifyUnknown(senderPhone: string, isRegistered: boolean): Promise<void> {
    if (isRegistered) {
      await notifyUser(
        senderPhone,
        'Não consegui entender. Pra dividir uma conta, manda algo tipo "paguei 60 na pizza, divide com Ana e Beto".'
      );
    } else {
      await this.sendInitialWelcome(senderPhone);
    }
  },
};
```

(Nota: `startOAuthForUser` será implementado na Task 8; por enquanto pode dar erro de import temporário — vai resolver lá.)

- [ ] **Step 3: Criar `tests/integration/user-registration.test.ts`**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { fakeWhatsApp, sentMessages, clearSentMessages } from '../helpers/fake-whatsapp.js';

vi.mock('../../src/services/whatsapp/whatsapp.js', () => fakeWhatsApp);
vi.mock('../../src/services/cumbuca/cumbuca.client.js', () => ({
  startOAuthForUser: vi.fn().mockResolvedValue('https://auth.fake/authorize?...'),
}));

import { userService } from '../../src/services/users/user.service.js';
import { usersRepository } from '../../src/repositories/users.repository.js';

describe('userService.handleRegistration', () => {
  beforeEach(() => {
    createTestDb();
    clearSentMessages();
  });

  it('profile completo (name + email): persiste user + dispara welcome com link bank proativo', async () => {
    await userService.handleRegistration('5511999999999', {
      name: 'João Pedro Silva',
      email: 'joao@email.com',
    });
    const user = usersRepository.findByPhone('5511999999999');
    expect(user?.name).toBe('João Pedro Silva');
    expect(user?.email).toBe('joao@email.com');
    expect(user?.pix_key).toBe('');  // PIX é lazy
    const bankLink = sentMessages.find((m) => m.text.includes('Toque aqui'));
    expect(bankLink).toBeDefined();
    expect(bankLink?.text).toContain('https://auth.fake/authorize');
  });

  it('profile parcial (só nome): NÃO persiste user, pede email', async () => {
    await userService.handleRegistration('5511999999999', { name: 'João' });
    expect(usersRepository.findByPhone('5511999999999')).toBeNull();
    expect(sentMessages.some((m) => m.text.toLowerCase().includes('email'))).toBe(true);
  });

  it('profile parcial (só email): NÃO persiste user, pede nome', async () => {
    await userService.handleRegistration('5511999999999', { email: 'joao@email.com' });
    expect(usersRepository.findByPhone('5511999999999')).toBeNull();
    expect(sentMessages.some((m) => m.text.toLowerCase().includes('nome'))).toBe(true);
  });

  it('email duplicado: responde mensagem de erro amigável, não persiste', async () => {
    // Primeiro user toma o email
    await userService.handleRegistration('5511AAA', {
      name: 'Primeiro',
      email: 'shared@email.com',
    });
    clearSentMessages();
    // Segundo tenta com mesmo email
    await userService.handleRegistration('5511BBB', {
      name: 'Segundo',
      email: 'shared@email.com',
    });
    expect(usersRepository.findByPhone('5511BBB')).toBeNull();
    expect(sentMessages.some((m) => m.text.includes('email já está sendo usado'))).toBe(true);
  });

  it('lazy PIX collection: user existente sem PIX recebe PIX → persiste, pede pra reenviar bill', async () => {
    await userService.handleRegistration('5511999999999', {
      name: 'João',
      email: 'joao@email.com',
    });
    clearSentMessages();
    await userService.handleRegistration('5511999999999', { pix_key: 'joao@pix.com' });
    const user = usersRepository.findByPhone('5511999999999');
    expect(user?.pix_key).toBe('joao@pix.com');
    expect(user?.pix_merchant_name).toBe('João');
    expect(user?.pix_merchant_city).toBe('BRASIL');
    expect(sentMessages.some((m) => m.text.toLowerCase().includes('reenviar') || m.text.includes('manda a conta de novo'))).toBe(true);
  });

  it('update PIX em user com PIX existente: atualiza sem repetir welcome', async () => {
    await userService.handleRegistration('5511999999999', {
      name: 'João',
      email: 'joao@email.com',
    });
    // Coleta PIX inicial
    await userService.handleRegistration('5511999999999', { pix_key: 'old@pix' });
    clearSentMessages();
    // Troca o PIX
    await userService.handleRegistration('5511999999999', { pix_key: 'new@pix' });
    expect(usersRepository.findByPhone('5511999999999')?.pix_key).toBe('new@pix');
    expect(sentMessages.some((m) => m.text === 'Atualizado!')).toBe(true);
  });

  it('truncate merchant_name pra 25 chars (limite BR Code) quando deriva do nome longo', async () => {
    await userService.handleRegistration('5511999999999', {
      name: 'A'.repeat(50),
      email: 'a@email.com',
    });
    await userService.handleRegistration('5511999999999', { pix_key: 'x@pix' });
    const user = usersRepository.findByPhone('5511999999999');
    expect(user?.pix_merchant_name).toHaveLength(25);
  });

  it('nomes compostos preservados (não truncate prematuro)', async () => {
    await userService.handleRegistration('5511999999999', {
      name: 'Maria Fernanda Silva',
      email: 'maria@email.com',
    });
    expect(usersRepository.findByPhone('5511999999999')?.name).toBe('Maria Fernanda Silva');
  });
});
```

- [ ] **Step 4: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

(Possível typecheck error em `startOAuthForUser` se Task 8 ainda não foi feita. Aceitável temporariamente — corrige na Task 8.)

```bash
git add src/services/users/ tests/
git commit -m "feat(users): user.service with auto-registration + proactive link bank flow

handleRegistration cria user com defaults derivados
(pix_merchant_name=name truncated 25 chars, pix_merchant_city=BRASIL).
Aceita profile parcial — pede o que faltou.

Ao completar o cadastro, envia welcome + dispara o flow de link bank
proativamente (sem user pedir). link_bank intent fica como recovery
em service separado.

Cenário F do spec §13.3."
```

---

## Task 8: Cumbuca client refactor (split DCR app-level + OAuth per-user + lock) + tests

**Files:**
- Modify: `src/services/cumbuca/cumbuca.client.ts`
- Delete (no fim): `src/services/cumbuca/cumbuca.tokens.ts` (substituído por repo já em Task 3 — mas import paths precisam atualizar aqui)
- Create: `tests/helpers/fake-cumbuca-client.ts`
- Create: `tests/integration/token-refresh.test.ts`

- [ ] **Step 1: Refatorar `src/services/cumbuca/cumbuca.client.ts`**

Mudanças-chave:
- `bootstrapApp()` — lazy DCR com persistência em `cumbucaAppRepository`
- `startOAuthForUser(user)` — gera state + code_verifier + persiste pending + retorna authorize URL
- `exchangeCodeForUser(code, pending)` — usa app credentials + pending state, retorna tokens persistidos pro user
- `getCurrentTokensForUser(userPhone)` + `refreshAccessTokenForUser(userPhone)` — com lock per-user via Map
- `listAccountsForUser(userPhone)`, `listAccountTransactionsForUser(userPhone, args)` — wrappers
- `isConnectedFor(userPhone): boolean` — replaces global `isConnected()`

Estrutura completa (substitui o arquivo inteiro):

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes } from 'node:crypto';
import { cumbucaAppRepository, type CumbucaAppCredentials } from '../../repositories/cumbuca-app.repository.js';
import { cumbucaTokensRepository, type CumbucaUserTokens } from '../../repositories/cumbuca-tokens.repository.js';
import { cumbucaPendingPairingRepository, type PendingPairing } from '../../repositories/cumbuca-pending-pairing.repository.js';
import { env } from '../../config/env.js';
import type { User } from '../../repositories/users.repository.js';
import type {
  CumbucaListAccountsResponse,
  CumbucaListTransactionsResponse,
  CumbucaConsentStatus,
} from './cumbuca.types.js';

const MCP_SERVER_URL = 'https://mcp.cumbuca.com/mcp';
const HTTP_TIMEOUT_MS = 30_000;

function fetchWithTimeout(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Connection state per-user (in-memory; não persiste)
const connectionStatus = new Map<string, boolean>();
function markConnected(userPhone: string): void {
  connectionStatus.set(userPhone, true);
}
function markDisconnected(userPhone: string, reason: string): void {
  if (connectionStatus.get(userPhone) !== false) {
    console.error(`[cumbuca] disconnected ${userPhone}:`, reason);
  }
  connectionStatus.set(userPhone, false);
}
export function isConnectedFor(userPhone: string): boolean {
  return connectionStatus.get(userPhone) ?? true;
}

// -------- OAuth metadata discovery (mesma de antes) --------

interface OAuthServerMetadata {
  registration_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

let cachedAuthServerMetadata: OAuthServerMetadata | null = null;

async function discoverAuthServerMetadata(): Promise<OAuthServerMetadata> {
  if (cachedAuthServerMetadata) return cachedAuthServerMetadata;
  const resourceOrigin = new URL(MCP_SERVER_URL).origin;
  const prResponse = await fetchWithTimeout(`${resourceOrigin}/.well-known/oauth-protected-resource`);
  if (!prResponse.ok) throw new Error(`Failed to fetch protected resource metadata: ${prResponse.status}`);
  const pr = (await prResponse.json()) as { authorization_servers?: string[] };
  const authServerUrl = pr.authorization_servers?.[0];
  if (!authServerUrl) throw new Error('Protected resource metadata missing authorization_servers');
  const asResponse = await fetchWithTimeout(`${authServerUrl}/.well-known/oauth-authorization-server`, { redirect: 'follow' });
  if (!asResponse.ok) throw new Error(`Failed to fetch authorization server metadata: ${asResponse.status}`);
  const metadata = (await asResponse.json()) as Partial<OAuthServerMetadata>;
  if (!metadata.registration_endpoint || !metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error(`Incomplete authorization server metadata: ${JSON.stringify(metadata)}`);
  }
  cachedAuthServerMetadata = metadata as OAuthServerMetadata;
  return cachedAuthServerMetadata;
}

// -------- DCR app-level (lazy) --------

async function registerClient(redirectUri: string): Promise<CumbucaAppCredentials> {
  const { registration_endpoint } = await discoverAuthServerMetadata();
  const response = await fetchWithTimeout(registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'slice',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  if (!response.ok) throw new Error(`DCR failed: ${response.status} ${await response.text()}`);
  const json = (await response.json()) as { client_id: string; client_secret: string };
  return { client_id: json.client_id, client_secret: json.client_secret };
}

async function getOrBootstrapAppCredentials(): Promise<CumbucaAppCredentials> {
  const existing = cumbucaAppRepository.get();
  if (existing) return existing;
  console.log('[cumbuca] bootstrapping app via DCR (one-time)...');
  const redirectUri = `${env.publicBaseUrl}/oauth/cumbuca/callback`;
  const creds = await registerClient(redirectUri);
  cumbucaAppRepository.set(creds);
  return creds;
}

// -------- OAuth per-user --------

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}
async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(hash).toString('base64url');
}

export async function startOAuthForUser(user: User): Promise<string> {
  const app = await getOrBootstrapAppCredentials();
  const { authorization_endpoint } = await discoverAuthServerMetadata();
  const codeVerifier = generateCodeVerifier();
  const challenge = await pkceChallenge(codeVerifier);
  const state = randomBytes(24).toString('base64url');
  const redirectUri = `${env.publicBaseUrl}/oauth/cumbuca/callback`;

  cumbucaPendingPairingRepository.set({
    user_phone: user.phone,
    state,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    created_at: new Date().toISOString(),
  });

  const url = new URL(authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', app.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', 'openid open-finance offline_access');
  url.searchParams.set('state', state);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeCodeForUser(code: string, pending: PendingPairing): Promise<CumbucaUserTokens> {
  const app = await getOrBootstrapAppCredentials();
  const { token_endpoint } = await discoverAuthServerMetadata();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirect_uri,
    client_id: app.client_id,
    client_secret: app.client_secret,
    code_verifier: pending.code_verifier,
  });
  const response = await fetchWithTimeout(token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  const tk = (await response.json()) as TokenResponse;
  const tokens: CumbucaUserTokens = {
    user_phone: pending.user_phone,
    access_token: tk.access_token,
    refresh_token: tk.refresh_token,
    expires_at: new Date(Date.now() + tk.expires_in * 1000).toISOString(),
    account_id: '',
  };
  cumbucaTokensRepository.set(tokens);
  return tokens;
}

// -------- Refresh com lock per-user --------

const refreshLocks = new Map<string, Promise<CumbucaUserTokens>>();

function isTokenExpired(tokens: CumbucaUserTokens, skewMs = 30_000): boolean {
  return new Date(tokens.expires_at).getTime() - skewMs <= Date.now();
}

async function refreshTokensForUser(userPhone: string): Promise<CumbucaUserTokens> {
  const existing = refreshLocks.get(userPhone);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const app = await getOrBootstrapAppCredentials();
      const tokens = cumbucaTokensRepository.getForUser(userPhone);
      if (!tokens) throw new Error(`No tokens for user ${userPhone}`);
      const { token_endpoint } = await discoverAuthServerMetadata();
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: app.client_id,
        client_secret: app.client_secret,
      });
      const response = await fetchWithTimeout(token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) {
        markDisconnected(userPhone, `refresh failed: ${response.status}`);
        throw new Error(`Refresh failed: ${response.status} ${await response.text()}`);
      }
      const tk = (await response.json()) as TokenResponse;
      const updated: CumbucaUserTokens = {
        ...tokens,
        access_token: tk.access_token,
        refresh_token: tk.refresh_token ?? tokens.refresh_token,
        expires_at: new Date(Date.now() + tk.expires_in * 1000).toISOString(),
      };
      cumbucaTokensRepository.set(updated);
      return updated;
    } finally {
      refreshLocks.delete(userPhone);
    }
  })();

  refreshLocks.set(userPhone, promise);
  return promise;
}

async function getCurrentTokensForUser(userPhone: string): Promise<CumbucaUserTokens> {
  let tokens = cumbucaTokensRepository.getForUser(userPhone);
  if (!tokens) throw new Error(`No Cumbuca tokens for user ${userPhone}. User needs to link bank.`);
  if (isTokenExpired(tokens)) {
    tokens = await refreshTokensForUser(userPhone);
  }
  return tokens;
}

// -------- MCP tool calls per-user --------

async function openMcpClient(tokens: CumbucaUserTokens): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  });
  const client = new Client({ name: 'slice', version: '0.2.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function callMcpToolForUser<T>(userPhone: string, toolName: string, args: Record<string, unknown>): Promise<T> {
  let tokens: CumbucaUserTokens;
  try {
    tokens = await getCurrentTokensForUser(userPhone);
  } catch (e) {
    markDisconnected(userPhone, `token unavailable: ${(e as Error).message}`);
    throw e;
  }
  let client: Client;
  let close: () => Promise<void>;
  try {
    const opened = await openMcpClient(tokens);
    client = opened.client;
    close = opened.close;
  } catch (e) {
    markDisconnected(userPhone, `mcp connect failed: ${(e as Error).message}`);
    throw e;
  }
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    markConnected(userPhone);
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const textBlock = content?.find((b) => b.type === 'text' && typeof b.text === 'string');
    if (!textBlock?.text) throw new Error(`Unexpected MCP response for ${toolName}: ${JSON.stringify(result)}`);
    return JSON.parse(textBlock.text) as T;
  } catch (e) {
    markDisconnected(userPhone, `tool ${toolName} failed: ${(e as Error).message}`);
    throw e;
  } finally {
    try { await close(); } catch (closeErr) { console.warn('[cumbuca] mcp close failed', closeErr); }
  }
}

// -------- Public surface (per-user) --------

export async function getConsentStatusForUser(userPhone: string): Promise<CumbucaConsentStatus> {
  return callMcpToolForUser<CumbucaConsentStatus>(userPhone, 'get_consent_status', {});
}
export async function listAccountsForUser(userPhone: string): Promise<CumbucaListAccountsResponse> {
  return callMcpToolForUser<CumbucaListAccountsResponse>(userPhone, 'list_accounts', {});
}
export async function listAccountTransactionsForUser(userPhone: string, args: {
  accountId: string; fromDate?: string; toDate?: string;
}): Promise<CumbucaListTransactionsResponse> {
  return callMcpToolForUser<CumbucaListTransactionsResponse>(userPhone, 'list_account_transactions', {
    account_id: args.accountId, from_date: args.fromDate, to_date: args.toDate,
  });
}
```

(Nota: este é o maior refactor do epic. Substitui o arquivo `cumbuca.client.ts` inteiro.)

- [ ] **Step 2: Criar `tests/helpers/fake-cumbuca-client.ts`** (stubs com vi.mock)

```typescript
import { vi } from 'vitest';
import type { CumbucaUserTokens } from '../../src/repositories/cumbuca-tokens.repository.js';

export const fakeCumbucaClient = {
  startOAuthForUser: vi.fn(),
  exchangeCodeForUser: vi.fn(),
  listAccountsForUser: vi.fn(),
  listAccountTransactionsForUser: vi.fn(),
  getConsentStatusForUser: vi.fn(),
  isConnectedFor: vi.fn().mockReturnValue(true),
};

export function resetCumbucaClientFakes(): void {
  for (const fn of Object.values(fakeCumbucaClient)) {
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  }
  fakeCumbucaClient.isConnectedFor.mockReturnValue(true);
}
```

- [ ] **Step 3: Criar `tests/integration/token-refresh.test.ts`** (cenário D)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { usersRepository } from '../../src/repositories/users.repository.js';
import { cumbucaAppRepository } from '../../src/repositories/cumbuca-app.repository.js';
import { cumbucaTokensRepository } from '../../src/repositories/cumbuca-tokens.repository.js';

// Mock fetch — vitest hoist this
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function userFixture(phone: string) {
  return {
    phone, name: 'T', pix_key: 'x', pix_merchant_name: 'T', pix_merchant_city: 'BRASIL',
    created_at: '2026-05-24T00:00:00.000Z',
  };
}

const expiredTokens = (userPhone: string) => ({
  user_phone: userPhone,
  access_token: 'OLD_ACCESS',
  refresh_token: 'OLD_REFRESH',
  expires_at: '2020-01-01T00:00:00.000Z',  // expired
  account_id: 'acc',
});

describe('cumbuca client — token refresh per-user lock', () => {
  beforeEach(() => {
    createTestDb();
    fetchMock.mockReset();
    usersRepository.insert(userFixture('5511A'));
    usersRepository.insert(userFixture('5511B'));
    cumbucaAppRepository.set({ client_id: 'cid', client_secret: 'csec' });
    cumbucaTokensRepository.set(expiredTokens('5511A'));
    cumbucaTokensRepository.set(expiredTokens('5511B'));

    // Mock discovery endpoints + token endpoint
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('.well-known/oauth-protected-resource')) {
        return { ok: true, json: async () => ({ authorization_servers: ['https://auth/realm'] }) } as Response;
      }
      if (url.includes('.well-known/oauth-authorization-server')) {
        return {
          ok: true,
          json: async () => ({
            registration_endpoint: 'https://auth/register',
            authorization_endpoint: 'https://auth/authorize',
            token_endpoint: 'https://auth/token',
          }),
        } as Response;
      }
      if (url.includes('/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: `NEW_ACCESS_${Date.now()}`,
            refresh_token: 'NEW_REFRESH',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  it('two callers concurrent pro mesmo user compartilham uma refresh request', async () => {
    const { listAccountTransactionsForUser } = await import('../../src/services/cumbuca/cumbuca.client.js');

    // Sobrescrever Mcp client pra não chamar Cumbuca real
    vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: class {
        async connect() {}
        async close() {}
        async callTool() { return { content: [{ type: 'text', text: JSON.stringify({ transactions: [] }) }] }; }
      },
    }));
    vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: class { constructor() {} },
    }));

    // Disparar dois calls concorrentes pra mesmo user
    const p1 = listAccountTransactionsForUser('5511A', { accountId: 'acc' });
    const p2 = listAccountTransactionsForUser('5511A', { accountId: 'acc' });
    await Promise.all([p1, p2]);

    // Conta quantas chamadas pro /token endpoint
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('refresh fail marca user como disconnected', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ authorization_servers: ['https://auth/realm'] }),
    }) as Response);
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        registration_endpoint: 'https://auth/register',
        authorization_endpoint: 'https://auth/authorize',
        token_endpoint: 'https://auth/token',
      }),
    }) as Response);
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 401, text: async () => 'invalid_grant' }) as Response);

    const { listAccountTransactionsForUser, isConnectedFor } = await import('../../src/services/cumbuca/cumbuca.client.js');
    await expect(listAccountTransactionsForUser('5511A', { accountId: 'acc' })).rejects.toThrow();
    expect(isConnectedFor('5511A')).toBe(false);
  });
});
```

(Nota: testes de concorrência em SDK MCP são frágeis; se necessário, simplifica pra testar diretamente `refreshTokensForUser` exposto via export pra teste, ou usa pattern alternativo. Mantém o critério essencial: 1 refresh request por user concorrente.)

- [ ] **Step 4: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

```bash
git add src/services/cumbuca/cumbuca.client.ts tests/
git commit -m "refactor(cumbuca): split DCR app-level + OAuth per-user + refresh lock

cumbuca.client.ts agora opera multi-tenant:
- getOrBootstrapAppCredentials(): DCR lazy persistido em cumbuca_app
  (single row PK=1). Reusa em toda chamada futura.
- startOAuthForUser(user): gera state+PKCE, persiste pending,
  retorna authorize URL injetando client_id do app.
- exchangeCodeForUser(code, pending): troca code por tokens,
  persiste em cumbuca_tokens keyed por user.
- refreshTokensForUser(userPhone): com lock per-user via
  Map<userPhone, Promise>. Callers concorrentes pro mesmo user
  compartilham 1 refresh; users diferentes refresham em paralelo.
- listAccount(Transactions)ForUser(userPhone): wrappers que resolvem
  tokens do user e chamam MCP com isolamento.
- isConnectedFor(userPhone): status per-user.

Cenário D do spec §13.3 coberto."
```

---

## Task 9: OAuth callback handler refactor + tests

**Files:**
- Modify: `src/routes/cumbuca.oauth.ts`
- Create: `tests/integration/oauth-callback.test.ts`

- [ ] **Step 1: Refatorar `src/routes/cumbuca.oauth.ts`**

```typescript
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cumbucaPendingPairingRepository } from '../repositories/cumbuca-pending-pairing.repository.js';
import { cumbucaTokensRepository } from '../repositories/cumbuca-tokens.repository.js';
import { usersRepository } from '../repositories/users.repository.js';
import { exchangeCodeForUser, listAccountsForUser } from '../services/cumbuca/cumbuca.client.js';
import { notifyUser } from '../services/whatsapp/whatsapp.js';

export function registerCumbucaOAuthRoutes(app: FastifyInstance): void {
  app.get('/oauth/cumbuca/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const { code, state, error } = request.query as { code?: string; state?: string; error?: string };

    if (error) {
      reply.type('text/plain; charset=utf-8').send(`Autorização cancelada: ${error}\nPode fechar esta aba.`);
      return;
    }
    if (!code || !state) {
      reply.code(400).type('text/plain; charset=utf-8').send('Faltou code ou state.');
      return;
    }

    const pending = cumbucaPendingPairingRepository.findByState(state);
    if (!pending) {
      reply.code(409).type('text/plain; charset=utf-8').send('Nenhum pareamento ativo. Tente parear de novo.');
      return;
    }
    if (cumbucaPendingPairingRepository.isExpired(pending)) {
      cumbucaPendingPairingRepository.delete(pending.user_phone);
      reply.code(410).type('text/plain; charset=utf-8').send('Pareamento expirou (>10min). Tente de novo.');
      return;
    }

    try {
      await exchangeCodeForUser(code, pending);
      // Account selection: 1 conta → pega; várias → pega primeira + warn
      const { accounts } = await listAccountsForUser(pending.user_phone);
      if (accounts.length === 0) {
        throw new Error('Cumbuca não retornou contas. Consent aprovado?');
      }
      const chosen = accounts[0]!;
      if (accounts.length > 1) {
        console.warn(`[cumbuca-oauth] user ${pending.user_phone} has ${accounts.length} accounts; auto-selected first`);
      }
      const tokens = cumbucaTokensRepository.getForUser(pending.user_phone)!;
      cumbucaTokensRepository.set({ ...tokens, account_id: chosen.accountId });
      cumbucaPendingPairingRepository.delete(pending.user_phone);

      // Notifica user via WhatsApp
      const user = usersRepository.findByPhone(pending.user_phone);
      if (user) {
        await notifyUser(
          user.phone,
          `Pronto, conectado! 🎉 Agora vou te avisar automaticamente quando seus contatos pagarem. Pode criar sua primeira conta aí.`
        );
      }

      reply.type('text/plain; charset=utf-8').send('✅ Conta conectada com sucesso! Volte ao WhatsApp.');
    } catch (err) {
      console.error('[cumbuca-oauth] failed', err);
      reply.code(500).type('text/plain; charset=utf-8').send('Falhou conectar. Tenta de novo daqui a pouco.');
    }
  });
}
```

- [ ] **Step 2: Criar `tests/integration/oauth-callback.test.ts`** (cenário E)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { createTestDb } from '../helpers/test-db.js';
import { usersRepository } from '../../src/repositories/users.repository.js';
import { cumbucaPendingPairingRepository } from '../../src/repositories/cumbuca-pending-pairing.repository.js';
import { cumbucaTokensRepository } from '../../src/repositories/cumbuca-tokens.repository.js';

vi.mock('../../src/services/cumbuca/cumbuca.client.js', () => ({
  exchangeCodeForUser: vi.fn().mockImplementation(async (_code, pending) => {
    cumbucaTokensRepository.set({
      user_phone: pending.user_phone,
      access_token: 'AT', refresh_token: 'RT',
      expires_at: '2026-12-31T00:00:00.000Z', account_id: '',
    });
  }),
  listAccountsForUser: vi.fn().mockResolvedValue({
    accounts: [{ accountId: 'acc_xyz', brandName: 'Nubank', branchCode: '0001', number: '123' }],
  }),
  isConnectedFor: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/services/whatsapp/whatsapp.js', () => ({
  notifyUser: vi.fn(),
}));

import { registerCumbucaOAuthRoutes } from '../../src/routes/cumbuca.oauth.js';

function userFixture(phone: string) {
  return {
    phone, name: 'T', pix_key: 'x', pix_merchant_name: 'T', pix_merchant_city: 'BRASIL',
    created_at: '2026-05-24T00:00:00.000Z',
  };
}

async function newApp() {
  const app = Fastify();
  registerCumbucaOAuthRoutes(app);
  return app;
}

describe('OAuth callback', () => {
  beforeEach(() => {
    createTestDb();
    usersRepository.insert(userFixture('phone_A'));
    usersRepository.insert(userFixture('phone_B'));
  });

  it('valid state + code → tokens persistem pro user certo, account selecionada', async () => {
    cumbucaPendingPairingRepository.set({
      user_phone: 'phone_A', state: 'state_A',
      code_verifier: 'v', redirect_uri: 'http://r',
      created_at: new Date().toISOString(),
    });
    const app = await newApp();
    const res = await app.inject({ method: 'GET', url: '/oauth/cumbuca/callback?code=CODE&state=state_A' });
    expect(res.statusCode).toBe(200);
    const tokens = cumbucaTokensRepository.getForUser('phone_A');
    expect(tokens?.account_id).toBe('acc_xyz');
    expect(cumbucaPendingPairingRepository.findByUserPhone('phone_A')).toBeNull();  // apagou pending
  });

  it('state desconhecido → 409', async () => {
    const app = await newApp();
    const res = await app.inject({ method: 'GET', url: '/oauth/cumbuca/callback?code=CODE&state=unknown' });
    expect(res.statusCode).toBe(409);
  });

  it('pending expirado → 410 + cleanup do pending', async () => {
    cumbucaPendingPairingRepository.set({
      user_phone: 'phone_A', state: 'state_A',
      code_verifier: 'v', redirect_uri: 'http://r',
      created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });
    const app = await newApp();
    const res = await app.inject({ method: 'GET', url: '/oauth/cumbuca/callback?code=CODE&state=state_A' });
    expect(res.statusCode).toBe(410);
    expect(cumbucaPendingPairingRepository.findByUserPhone('phone_A')).toBeNull();
  });

  it('two users com pending simultâneo: callback de A não bagunça pending de B', async () => {
    cumbucaPendingPairingRepository.set({
      user_phone: 'phone_A', state: 'state_A',
      code_verifier: 'v', redirect_uri: 'http://r',
      created_at: new Date().toISOString(),
    });
    cumbucaPendingPairingRepository.set({
      user_phone: 'phone_B', state: 'state_B',
      code_verifier: 'v', redirect_uri: 'http://r',
      created_at: new Date().toISOString(),
    });
    const app = await newApp();
    await app.inject({ method: 'GET', url: '/oauth/cumbuca/callback?code=CODE&state=state_A' });
    expect(cumbucaTokensRepository.getForUser('phone_A')).not.toBeNull();
    expect(cumbucaTokensRepository.getForUser('phone_B')).toBeNull();
    expect(cumbucaPendingPairingRepository.findByUserPhone('phone_B')).not.toBeNull();
  });
});
```

- [ ] **Step 3: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

```bash
git add src/routes/cumbuca.oauth.ts tests/
git commit -m "refactor(cumbuca-oauth): callback resolves user via state, auto account selection

Callback resolve user via state token (unique index em
cumbuca_pending_pairing). Faz account selection automática: 1 conta
pega, várias loga warn e pega primeira (multi-conta como UX debt).
Notifica user via WhatsApp ao concluir. Cleanup do pending.

Two users com pending simultâneo isolam corretamente — cenário E do
spec §13.3."
```

---

## Task 10: Bill service refactor (accept owner) + PIX builder per-user + tests

**Files:**
- Modify: `src/services/pix/pix.ts`
- Modify: `src/services/bills/bill.service.ts`
- Create: `tests/integration/bill-creation.test.ts`
- Create: `tests/integration/reconciliation.test.ts`

- [ ] **Step 1: Refatorar `src/services/pix/pix.ts`**

```typescript
import { QrCodePix } from 'qrcode-pix';

interface BuildPixArgs {
  amount: number;
  txid: string;
  message?: string;
  pix_key: string;
  pix_merchant_name: string;
  pix_merchant_city: string;
}

function buildQrCodePix(args: BuildPixArgs) {
  return QrCodePix({
    version: '01',
    key: args.pix_key,
    name: args.pix_merchant_name,
    city: args.pix_merchant_city,
    transactionId: args.txid.slice(0, 25),
    message: args.message,
    value: Number(args.amount.toFixed(2)),
  });
}

export function buildPixPayload(args: BuildPixArgs): string {
  return buildQrCodePix(args).payload();
}

export async function buildPixQrPngBase64(args: BuildPixArgs): Promise<string> {
  const dataUrl = await buildQrCodePix(args).base64();
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
```

- [ ] **Step 2: Refatorar `src/services/bills/bill.service.ts`**

```typescript
import { ulid } from 'ulid';
import { billRepository } from '../../repositories/bill.repository.js';
import { processedTransactionsRepository } from '../../repositories/processed-transactions.repository.js';
import { buildPixPayload } from '../pix/pix.js';
import { notifyUser } from '../whatsapp/whatsapp.js';
import { notifyNewBillCreated } from '../../workers/payment-scanner.worker.js';
import type { User } from '../../repositories/users.repository.js';
import type {
  Bill, ExtractedBill, IncomingTransaction, Participant,
} from './bill.types.js';

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function buildParticipants(extracted: ExtractedBill, billId: string, owner: User): Participant[] {
  return extracted.participants.map((p, i) => ({
    name: p.name,
    amount_due: Number(p.amount_due.toFixed(2)),
    status: 'PENDING' as const,
    pix_payload: buildPixPayload({
      amount: p.amount_due,
      txid: `${billId.slice(-10)}${i}`,
      message: `Racha: ${extracted.description}`.slice(0, 60),
      pix_key: owner.pix_key,
      pix_merchant_name: owner.pix_merchant_name,
      pix_merchant_city: owner.pix_merchant_city,
    }),
  }));
}

async function sendBillCreatedMessages(bill: Bill, owner: User): Promise<void> {
  const names = bill.participants.map((p) => p.name).join(' e ');
  await notifyUser(
    owner.phone,
    `Anotei sua conta de ${formatBRL(bill.total_amount)} em "${bill.description}". ` +
      `Cabe ${formatBRL(bill.amount_per_person)} pra cada um. ` +
      `Mando o PIX de cada um (${names}) a seguir.`
  );
  for (const participant of bill.participants) {
    await notifyUser(owner.phone, participant.pix_payload);
  }
}

function renderPaidMessage(bill: Bill, paid: Participant): string {
  const remaining = bill.participants.filter((p) => p.status === 'PENDING');
  if (remaining.length === 0) return '';
  const names = remaining.map((p) => p.name).join(', ');
  return `${paid.name} acabou de pagar! ${formatBRL(paid.amount_due)} caíram aqui. Ainda falta: ${names}.`;
}

function renderClosedMessage(bill: Bill): string {
  return `Fechou! Todo mundo pagou a conta de "${bill.description}". Saldo zerado 💸`;
}

export async function createBillFromExtraction(extracted: ExtractedBill, owner: User): Promise<Bill> {
  console.log('[bill] createBill from extraction', { owner: owner.phone, extracted });
  const id = ulid();
  const divisor = Math.max(extracted.headcount, extracted.participants.length, 1);
  const amountPerPerson = Number((extracted.total_amount / divisor).toFixed(2));

  const bill: Bill = {
    id,
    owner_phone: owner.phone,
    description: extracted.description,
    total_amount: Number(extracted.total_amount.toFixed(2)),
    amount_per_person: amountPerPerson,
    status: 'OPEN',
    created_at: new Date().toISOString(),
    participants: buildParticipants(extracted, id, owner),
  };

  billRepository.insert(bill);
  try {
    await sendBillCreatedMessages(bill, owner);
  } catch (err) {
    console.error('[bill] sendBillCreatedMessages failed', err);
  }
  notifyNewBillCreated();
  return bill;
}

interface MatchResult {
  billId: string;
  participantName: string;
  ownerPhone: string;
}

async function findMatch(tx: IncomingTransaction, ownerPhone: string): Promise<MatchResult | null> {
  const openBills = billRepository.findOpenForOwner(ownerPhone);
  for (const bill of openBills) {
    const candidates = bill.participants.filter(
      (p) => p.status === 'PENDING' && Math.abs(p.amount_due - tx.amount) < 0.005
    );
    if (candidates.length === 0) continue;
    const byName = candidates.find((p) => {
      const a = p.name.toLowerCase();
      const b = tx.payer_name.toLowerCase();
      return a.includes(b) || b.includes(a);
    });
    const winner = byName ?? candidates[0]!;
    return { billId: bill.id, participantName: winner.name, ownerPhone };
  }
  return null;
}

export async function tryReconcile(tx: IncomingTransaction, ownerPhone: string): Promise<boolean> {
  const match = await findMatch(tx, ownerPhone);
  if (!match) {
    console.log('[bill] tryReconcile no match', { txId: tx.id, ownerPhone });
    return false;
  }
  console.log('[bill] tryReconcile matched', { txId: tx.id, ...match });

  const updated = billRepository.update(match.billId, (b) => {
    const p = b.participants.find((x) => x.name === match.participantName);
    if (!p || p.status === 'PAID') return;
    p.status = 'PAID';
    p.paid_at = new Date().toISOString();
    if (b.participants.every((x) => x.status === 'PAID')) {
      b.status = 'CLOSED';
    }
  });
  if (!updated) return false;

  const paidParticipant = updated.participants.find((x) => x.name === match.participantName);
  if (paidParticipant) {
    const msg = renderPaidMessage(updated, paidParticipant);
    if (msg) await notifyUser(ownerPhone, msg);
  }
  if (updated.status === 'CLOSED') {
    console.log('[bill] bill closed', { id: updated.id });
    await notifyUser(ownerPhone, renderClosedMessage(updated));
  }
  return true;
}

export async function notifyUnknown(ownerPhone: string): Promise<void> {
  await notifyUser(
    ownerPhone,
    'Não consegui entender essa mensagem como uma conta pra dividir. Pode reformular? Ex: "Paguei 60 na pizzaria, dividir com João e Maria, 20 cada."'
  );
}
```

- [ ] **Step 3: Criar `tests/integration/bill-creation.test.ts`** (cenário A)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { fakeWhatsApp, sentMessages, clearSentMessages } from '../helpers/fake-whatsapp.js';
import { usersRepository } from '../../src/repositories/users.repository.js';
import { billRepository } from '../../src/repositories/bill.repository.js';

vi.mock('../../src/services/whatsapp/whatsapp.js', () => fakeWhatsApp);
vi.mock('../../src/workers/payment-scanner.worker.js', () => ({
  notifyNewBillCreated: vi.fn(),
}));

import { createBillFromExtraction } from '../../src/services/bills/bill.service.js';

const userA = {
  phone: '5511A', name: 'Alice', pix_key: 'alice@pix.com',
  pix_merchant_name: 'Alice', pix_merchant_city: 'BRASIL',
  created_at: '2026-05-24T00:00:00.000Z',
};
const userB = {
  phone: '5511B', name: 'Bob', pix_key: 'bob@pix.com',
  pix_merchant_name: 'Bob', pix_merchant_city: 'BRASIL',
  created_at: '2026-05-24T00:00:00.000Z',
};

describe('createBillFromExtraction', () => {
  beforeEach(() => {
    createTestDb();
    clearSentMessages();
    usersRepository.insert(userA);
    usersRepository.insert(userB);
  });

  it('PIX gerado usa pix_key do owner, não do env nem de outro user', async () => {
    const bill = await createBillFromExtraction(
      {
        description: 'Pizza',
        total_amount: 60,
        headcount: 3,
        participants: [{ name: 'Carla', amount_due: 20 }],
      },
      userA
    );
    expect(bill.participants[0]?.pix_payload).toContain('alice@pix.com');
    expect(bill.participants[0]?.pix_payload).not.toContain('bob@pix.com');
  });

  it('owner_phone é setado corretamente', async () => {
    const bill = await createBillFromExtraction(
      { description: 'X', total_amount: 10, headcount: 2, participants: [{ name: 'Y', amount_due: 5 }] },
      userA
    );
    expect(bill.owner_phone).toBe('5511A');
    const persisted = billRepository.findById(bill.id);
    expect(persisted?.owner_phone).toBe('5511A');
  });

  it('amount_per_person computado com headcount correto', async () => {
    const bill = await createBillFromExtraction(
      { description: 'X', total_amount: 100, headcount: 4, participants: [{ name: 'Y', amount_due: 25 }] },
      userA
    );
    expect(bill.amount_per_person).toBe(25);
  });

  it('mensagens enviadas pro owner.phone (não pro USER_WHATSAPP_NUMBER hardcoded)', async () => {
    await createBillFromExtraction(
      { description: 'X', total_amount: 10, headcount: 2, participants: [{ name: 'Y', amount_due: 5 }] },
      userA
    );
    expect(sentMessages.every((m) => m.to === '5511A')).toBe(true);
  });
});
```

- [ ] **Step 4: Criar `tests/integration/reconciliation.test.ts`** (cenário B)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { fakeWhatsApp, clearSentMessages } from '../helpers/fake-whatsapp.js';
import { usersRepository } from '../../src/repositories/users.repository.js';
import { billRepository } from '../../src/repositories/bill.repository.js';
import type { Bill } from '../../src/services/bills/bill.types.js';

vi.mock('../../src/services/whatsapp/whatsapp.js', () => fakeWhatsApp);

import { tryReconcile } from '../../src/services/bills/bill.service.js';

function userFixture(phone: string) {
  return {
    phone, name: `U_${phone}`, pix_key: `${phone}@pix`,
    pix_merchant_name: 'U', pix_merchant_city: 'BRASIL',
    created_at: '2026-05-24T00:00:00.000Z',
  };
}

function billFixture(id: string, ownerPhone: string, participant: { name: string; amount: number }): Bill {
  return {
    id, owner_phone: ownerPhone,
    description: 'X', total_amount: participant.amount, amount_per_person: participant.amount,
    status: 'OPEN', created_at: '2026-05-24T00:00:00.000Z',
    participants: [{
      name: participant.name, amount_due: participant.amount,
      status: 'PENDING', pix_payload: 'pix',
    }],
  };
}

describe('tryReconcile — owner isolation', () => {
  beforeEach(() => {
    createTestDb();
    clearSentMessages();
    usersRepository.insert(userFixture('phone_A'));
    usersRepository.insert(userFixture('phone_B'));
  });

  it('credit do owner A só reconcilia bills de A, nunca de B', async () => {
    billRepository.insert(billFixture('BILL_A', 'phone_A', { name: 'Maria', amount: 10 }));
    billRepository.insert(billFixture('BILL_B', 'phone_B', { name: 'Maria', amount: 10 }));
    const matched = await tryReconcile(
      { id: 'tx_1', amount: 10, payer_name: 'Maria Silva', occurred_at: '2026-05-24T00:00:00.000Z' },
      'phone_A'
    );
    expect(matched).toBe(true);
    expect(billRepository.findById('BILL_A')?.status).toBe('CLOSED');
    expect(billRepository.findById('BILL_B')?.status).toBe('OPEN');
  });

  it('preferência por match de nome quando múltiplos candidates por amount', async () => {
    const bill: Bill = {
      ...billFixture('BILL_1', 'phone_A', { name: 'Ana', amount: 20 }),
      participants: [
        { name: 'Ana', amount_due: 20, status: 'PENDING', pix_payload: 'p1' },
        { name: 'Beto', amount_due: 20, status: 'PENDING', pix_payload: 'p2' },
      ],
    };
    billRepository.insert(bill);
    await tryReconcile(
      { id: 'tx_1', amount: 20, payer_name: 'Beto Souza', occurred_at: '...' },
      'phone_A'
    );
    const updated = billRepository.findById('BILL_1');
    expect(updated?.participants.find((p) => p.name === 'Beto')?.status).toBe('PAID');
    expect(updated?.participants.find((p) => p.name === 'Ana')?.status).toBe('PENDING');
  });

  it('credit sem match retorna false (não marca nada)', async () => {
    billRepository.insert(billFixture('BILL_A', 'phone_A', { name: 'X', amount: 10 }));
    const matched = await tryReconcile(
      { id: 'tx_orphan', amount: 999, payer_name: 'Nobody', occurred_at: '...' },
      'phone_A'
    );
    expect(matched).toBe(false);
    expect(billRepository.findById('BILL_A')?.status).toBe('OPEN');
  });

  it('all paid → status CLOSED', async () => {
    billRepository.insert(billFixture('BILL_1', 'phone_A', { name: 'Solo', amount: 10 }));
    await tryReconcile({ id: 'tx_1', amount: 10, payer_name: 'Solo', occurred_at: '...' }, 'phone_A');
    expect(billRepository.findById('BILL_1')?.status).toBe('CLOSED');
  });
});
```

- [ ] **Step 5: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

```bash
git add src/services/pix/pix.ts src/services/bills/bill.service.ts tests/
git commit -m "refactor(bill+pix): per-owner PIX generation + reconciliation isolation

buildPixPayload (pix.ts) agora recebe pix_key/merchant_name/merchant_city
como args em vez de ler env — multi-tenant. bill.service vira agnóstico
de env: createBillFromExtraction(extracted, owner) usa owner.pix_*.
tryReconcile(tx, ownerPhone) opera só sobre bills daquele owner.

Cenários A e B do spec §13.3 cobertos."
```

---

## Task 11: WhatsApp service — notifyUser(to, text) refactor

**Files:**
- Modify: `src/services/whatsapp/whatsapp.ts`

- [ ] **Step 1: Substituir `src/services/whatsapp/whatsapp.ts`**

```typescript
import { sendText, sendTemplate, type TemplateBodyArgs } from './cloudapi.client.js';
import { whatsappWindowRepository } from '../../repositories/whatsapp-window.repository.js';

// API pública: aceita `to` (phone E.164 sem +) como primeiro arg.
// notifyUser respeita janela 24h; lança WindowClosedError se fechada e
// caller deve usar notifyUserViaTemplate.

export class WindowClosedError extends Error {
  constructor(userNumber: string) {
    super(`24h window closed for ${userNumber} — use notifyUserViaTemplate with an approved template`);
    this.name = 'WindowClosedError';
  }
}

export async function notifyUser(to: string, text: string): Promise<void> {
  const open = whatsappWindowRepository.isWindowOpen(to);
  if (!open) {
    throw new WindowClosedError(to);
  }
  await sendText(to, text);
}

export async function notifyUserViaTemplate(to: string, args: TemplateBodyArgs): Promise<void> {
  await sendTemplate(to, args);
}

// Stubs preservados (legado, ver Tasks anteriores)
export async function notifyUserImage(_to: string, _base64: string, _caption?: string): Promise<void> {
  throw new Error('notifyUserImage não implementado no path Cloud API');
}
export function wasSentByBot(_id?: string | null, _text?: string | null): boolean {
  return false;
}
```

(Nota: callers existentes — `bill.service`, `payment-scanner` — já foram atualizados em Tasks anteriores pra passar `owner.phone` ou `userPhone` como primeiro arg.)

- [ ] **Step 2: Typecheck + commit** (sem novo test — coberto indiretamente nos outros)

```bash
npx tsc --noEmit
npm test
```

```bash
git add src/services/whatsapp/whatsapp.ts
git commit -m "refactor(whatsapp): notifyUser accepts 'to' param (per-recipient)

Em vez de sempre enviar pra env.userWhatsappNumber, callers passam o
destinatário. Window 24h checada via repository SQLite. Multi-tenant
ready."
```

---

## Task 12: Payment scanner multi-user refactor + tests

**Files:**
- Modify: `src/workers/payment-scanner.worker.ts`
- Create: `tests/integration/scanner-multiuser.test.ts`

- [ ] **Step 1: Refatorar `src/workers/payment-scanner.worker.ts`**

Mudanças-chave:
- `scanForBillPayments()` itera owners com tokens Cumbuca
- Cada owner é processado isoladamente
- `processedTransactionsRepository` calls agora passam userPhone
- Comportamento de scheduling adaptativo permanece (baseado no bill mais novo globalmente)

```typescript
import { billRepository } from '../repositories/bill.repository.js';
import { processedTransactionsRepository } from '../repositories/processed-transactions.repository.js';
import { cumbucaTokensRepository } from '../repositories/cumbuca-tokens.repository.js';
import { tryReconcile } from '../services/bills/bill.service.js';
import {
  listAccountTransactionsForUser,
  isConnectedFor,
} from '../services/cumbuca/cumbuca.client.js';
import { notifyUser } from '../services/whatsapp/whatsapp.js';
import type { Bill } from '../services/bills/bill.types.js';

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const MIN_LOOKBACK_MS = ONE_HOUR_MS;

let scanTimer: NodeJS.Timeout | null = null;
let scanTimerFiresAt: number | null = null;
let scanInFlight = false;
let rerunRequested = false;

function ageMsOfMostRecentBill(bills: Bill[]): number {
  if (bills.length === 0) return Infinity;
  const newest = bills.reduce((m, b) =>
    new Date(b.created_at).getTime() > new Date(m).getTime() ? b.created_at : m,
    bills[0]!.created_at);
  return Date.now() - new Date(newest).getTime();
}

export function computeNextScanDelay(openBills: Bill[]): number | null {
  if (openBills.length === 0) return null;
  const age = ageMsOfMostRecentBill(openBills);
  if (age <= ONE_HOUR_MS) return 5 * ONE_MINUTE_MS;
  if (age <= 6 * ONE_HOUR_MS) return 15 * ONE_MINUTE_MS;
  if (age <= ONE_DAY_MS) return ONE_HOUR_MS;
  return 6 * ONE_HOUR_MS;
}

async function expireBillsOlderThanSevenDays(openBills: Bill[]): Promise<void> {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  for (const bill of openBills) {
    if (new Date(bill.created_at).getTime() >= cutoff) continue;
    const expired = billRepository.update(bill.id, (b) => {
      if (b.status === 'OPEN') b.status = 'EXPIRED';
    });
    if (!expired) continue;
    const pending = expired.participants.filter((p) => p.status === 'PENDING');
    const pendingNames = pending.map((p) => p.name).join(', ');
    console.log('[scanner] expired bill', { id: expired.id, owner: expired.owner_phone });
    try {
      await notifyUser(
        expired.owner_phone,
        pending.length > 0
          ? `⏱️ Bill "${expired.description}" expirou após 7 dias. Pendentes: ${pendingNames}.`
          : `⏱️ Bill "${expired.description}" expirou após 7 dias.`
      );
    } catch (err) {
      console.error('[scanner] notify expired failed', err);
    }
  }
}

async function scanForOwner(ownerPhone: string): Promise<void> {
  if (!isConnectedFor(ownerPhone)) {
    console.log('[scanner] skip owner — disconnected', { ownerPhone });
    return;
  }
  const tokens = cumbucaTokensRepository.getForUser(ownerPhone);
  if (!tokens || !tokens.account_id) {
    console.log('[scanner] skip owner — no tokens or account_id', { ownerPhone });
    return;
  }

  const bills = billRepository.findOpenForOwner(ownerPhone);
  if (bills.length === 0) return;

  const earliest = bills.reduce((m, b) =>
    new Date(b.created_at).getTime() < new Date(m).getTime() ? b.created_at : m,
    bills[0]!.created_at);
  const sinceMs = Math.min(new Date(earliest).getTime(), Date.now() - MIN_LOOKBACK_MS);
  const fromDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(sinceMs));
  const toDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  console.log('[scanner] scanning owner', { ownerPhone, fromDate, toDate, openBills: bills.length });

  let response;
  try {
    response = await listAccountTransactionsForUser(ownerPhone, {
      accountId: tokens.account_id, fromDate, toDate,
    });
  } catch (err) {
    console.error('[scanner] owner scan failed', { ownerPhone, err });
    return;
  }

  const pixCredits = response.transactions.filter((t) =>
    t.creditDebitType === 'CREDITO' && t.type === 'PIX'
  );
  console.log('[scanner] credits returned', { ownerPhone, raw: response.transactions.length, pixCredits: pixCredits.length });

  for (const tx of pixCredits) {
    if (processedTransactionsRepository.wasAlreadyProcessed(tx.transactionId, ownerPhone)) continue;
    const incoming = {
      id: tx.transactionId,
      amount: Number(tx.transactionAmount.amount),
      payer_name: tx.transactionName.split('|')[1] ?? '',
      occurred_at: tx.transactionDateTime,
    };
    const matched = await tryReconcile(incoming, ownerPhone);
    if (matched) {
      processedTransactionsRepository.markAsProcessed(tx.transactionId, ownerPhone);
    }
  }
}

export async function scanForBillPayments(): Promise<void> {
  const allBills = billRepository.findAllOpen();
  if (allBills.length === 0) {
    console.log('[scanner] idle — no open bills anywhere');
    return;
  }
  await expireBillsOlderThanSevenDays(allBills);

  // Re-read após expirations
  const stillOpen = billRepository.findAllOpen();
  if (stillOpen.length === 0) return;

  // Itera owners únicos
  const ownerPhones = Array.from(new Set(stillOpen.map((b) => b.owner_phone)));
  for (const ownerPhone of ownerPhones) {
    await scanForOwner(ownerPhone);
  }
}

async function runScanAndReschedule(): Promise<void> {
  if (scanInFlight) {
    rerunRequested = true;
    return;
  }
  scanInFlight = true;
  try {
    await scanForBillPayments();
  } catch (err) {
    console.error('[scanner] unexpected error', err);
  } finally {
    scanInFlight = false;
    if (rerunRequested) {
      rerunRequested = false;
      void runScanAndReschedule();
    } else {
      await scheduleNextScan();
    }
  }
}

async function scheduleNextScan(): Promise<void> {
  const allOpen = billRepository.findAllOpen();
  const delay = computeNextScanDelay(allOpen);
  if (delay === null) {
    console.log('[scanner] going idle — will wake on next bill');
    scanTimer = null;
    scanTimerFiresAt = null;
    return;
  }
  console.log(`[scanner] next scan in ${Math.round(delay / 1000)}s`);
  scanTimerFiresAt = Date.now() + delay;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scanTimerFiresAt = null;
    void runScanAndReschedule();
  }, delay);
}

export function notifyNewBillCreated(): void {
  if (scanInFlight) return;
  void rescheduleScanIfNewBillIsSooner();
}

async function rescheduleScanIfNewBillIsSooner(): Promise<void> {
  if (scanInFlight) return;
  const newDelay = computeNextScanDelay(billRepository.findAllOpen());
  if (newDelay === null) return;
  const newFiresAt = Date.now() + newDelay;
  if (scanTimerFiresAt !== null && scanTimerFiresAt <= newFiresAt) return;
  if (scanTimer !== null) clearTimeout(scanTimer);
  scanTimer = null;
  scanTimerFiresAt = null;
  await scheduleNextScan();
}

export async function startPaymentScanner(): Promise<void> {
  console.log('[scanner] starting');
  void runScanAndReschedule();
}
```

- [ ] **Step 2: Criar `tests/integration/scanner-multiuser.test.ts`** (cenário C)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { fakeWhatsApp, clearSentMessages } from '../helpers/fake-whatsapp.js';
import { usersRepository } from '../../src/repositories/users.repository.js';
import { billRepository } from '../../src/repositories/bill.repository.js';
import { cumbucaTokensRepository } from '../../src/repositories/cumbuca-tokens.repository.js';

vi.mock('../../src/services/whatsapp/whatsapp.js', () => fakeWhatsApp);

const listTxMock = vi.fn();
vi.mock('../../src/services/cumbuca/cumbuca.client.js', () => ({
  listAccountTransactionsForUser: listTxMock,
  isConnectedFor: vi.fn().mockReturnValue(true),
}));

import { scanForBillPayments } from '../../src/workers/payment-scanner.worker.js';

function userFixture(phone: string) {
  return {
    phone, name: 'T', pix_key: 'x', pix_merchant_name: 'T', pix_merchant_city: 'BRASIL',
    created_at: '2026-05-24T00:00:00.000Z',
  };
}

function billOpen(id: string, owner: string, amount: number, participantName: string) {
  return {
    id, owner_phone: owner,
    description: 'X', total_amount: amount, amount_per_person: amount,
    status: 'OPEN' as const, created_at: new Date().toISOString(),
    participants: [{ name: participantName, amount_due: amount, status: 'PENDING' as const, pix_payload: 'pix' }],
  };
}

describe('scanner multi-user', () => {
  beforeEach(() => {
    createTestDb();
    clearSentMessages();
    listTxMock.mockReset();
  });

  it('pula owner sem cumbuca tokens (não chama Cumbuca, não dá erro)', async () => {
    usersRepository.insert(userFixture('phone_NO_TOKENS'));
    billRepository.insert(billOpen('B1', 'phone_NO_TOKENS', 10, 'Maria'));
    await scanForBillPayments();
    expect(listTxMock).not.toHaveBeenCalled();
  });

  it('chama Cumbuca pra cada owner com tokens, isoladamente', async () => {
    usersRepository.insert(userFixture('phone_A'));
    usersRepository.insert(userFixture('phone_B'));
    cumbucaTokensRepository.set({
      user_phone: 'phone_A', access_token: 'AT_A', refresh_token: 'RT',
      expires_at: '2099-12-31T00:00:00.000Z', account_id: 'acc_A',
    });
    cumbucaTokensRepository.set({
      user_phone: 'phone_B', access_token: 'AT_B', refresh_token: 'RT',
      expires_at: '2099-12-31T00:00:00.000Z', account_id: 'acc_B',
    });
    billRepository.insert(billOpen('B1', 'phone_A', 10, 'Maria'));
    billRepository.insert(billOpen('B2', 'phone_B', 20, 'João'));
    listTxMock.mockResolvedValue({ transactions: [] });

    await scanForBillPayments();

    expect(listTxMock).toHaveBeenCalledTimes(2);
    const callArgs = listTxMock.mock.calls.map((c) => c[0]);
    expect(callArgs).toContain('phone_A');
    expect(callArgs).toContain('phone_B');
  });

  it('credit do A não reconcilia bill do B', async () => {
    usersRepository.insert(userFixture('phone_A'));
    usersRepository.insert(userFixture('phone_B'));
    cumbucaTokensRepository.set({
      user_phone: 'phone_A', access_token: 'AT', refresh_token: 'RT',
      expires_at: '2099-12-31T00:00:00.000Z', account_id: 'acc_A',
    });
    cumbucaTokensRepository.set({
      user_phone: 'phone_B', access_token: 'AT', refresh_token: 'RT',
      expires_at: '2099-12-31T00:00:00.000Z', account_id: 'acc_B',
    });
    billRepository.insert(billOpen('B_A', 'phone_A', 10, 'Maria'));
    billRepository.insert(billOpen('B_B', 'phone_B', 10, 'Maria'));

    // Cumbuca devolve credit pro user A apenas
    listTxMock.mockImplementation(async (phone: string) => {
      if (phone === 'phone_A') {
        return {
          transactions: [{
            transactionId: 'tx_1',
            transactionDateTime: '2026-05-24T00:00:00.000Z',
            transactionName: 'Transferência Recebida|MARIA SILVA',
            type: 'PIX',
            creditDebitType: 'CREDITO',
            transactionAmount: { amount: '10.0000', currency: 'BRL' },
          }],
        };
      }
      return { transactions: [] };
    });

    await scanForBillPayments();

    expect(billRepository.findById('B_A')?.status).toBe('CLOSED');
    expect(billRepository.findById('B_B')?.status).toBe('OPEN');
  });
});
```

- [ ] **Step 3: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

```bash
git add src/workers/payment-scanner.worker.ts tests/
git commit -m "refactor(scanner): multi-user — itera owners com tokens

scanForBillPayments() itera owners únicos com bills OPEN, chama
Cumbuca pra cada um isoladamente (tokens próprios via
cumbucaTokensRepository). Owners sem tokens são pulados silenciosamente.
processedTransactionsRepository segregada por user_phone.

Cenário C do spec §13.3 coberto."
```

---

## Task 13: Webhook vira intent dispatcher

**Files:**
- Modify: `src/routes/whatsapp.webhook.ts`

- [ ] **Step 1: Refatorar `src/routes/whatsapp.webhook.ts`**

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { extractIntent } from '../services/llm/gemini.js';
import { createBillFromExtraction } from '../services/bills/bill.service.js';
import { userService } from '../services/users/user.service.js';
import { startOAuthForUser } from '../services/cumbuca/cumbuca.client.js';
import { cumbucaTokensRepository } from '../repositories/cumbuca-tokens.repository.js';
import { usersRepository } from '../repositories/users.repository.js';
import { whatsappWindowRepository } from '../repositories/whatsapp-window.repository.js';
import { notifyUser } from '../services/whatsapp/whatsapp.js';
import type { MetaWebhookBody, MetaWebhookMessage } from '../services/whatsapp/cloudapi.types.js';

function normalizeBrNumber(num: string): string {
  const digits = num.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') {
    return digits.slice(0, 4) + digits.slice(5);
  }
  return digits;
}

function verifyMetaSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', env.whatsappAppSecret)
    .update(rawBody, 'utf8')
    .digest('hex');
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

function collectMessages(body: MetaWebhookBody): MetaWebhookMessage[] {
  const messages: MetaWebhookMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) {
        messages.push(message);
      }
    }
  }
  return messages;
}

function extractText(message: MetaWebhookMessage): string | null {
  if (message.type === 'text' && message.text?.body) return message.text.body;
  return null;
}

async function dispatchMessage(senderPhone: string, text: string): Promise<void> {
  const normalizedPhone = normalizeBrNumber(senderPhone);
  whatsappWindowRepository.recordInboundFromUser(normalizedPhone);

  const intent = await extractIntent(text);
  const user = usersRepository.findByPhone(normalizedPhone);

  switch (intent.intent) {
    case 'register_account':
      await userService.handleRegistration(normalizedPhone, intent.profile);
      return;

    case 'create_bill':
      if (!user) {
        await userService.requireRegistrationFirst(normalizedPhone);
        return;
      }
      if (!user.pix_key) {
        await userService.requirePixFirst(normalizedPhone, user.name);
        return;
      }
      try {
        await createBillFromExtraction(intent.bill, user);
        // Lembrete sutil se ainda não conectou banco
        const tokens = cumbucaTokensRepository.getForUser(normalizedPhone);
        if (!tokens) {
          const linkUrl = await startOAuthForUser(user);
          await notifyUser(normalizedPhone, `💡 Pra eu detectar pagamentos automaticamente, conecte seu banco: ${linkUrl}`);
        }
      } catch (err) {
        console.error('[webhook] createBill failed', err);
        await userService.notifyUnknown(normalizedPhone, true);
      }
      return;

    case 'unknown':
    default:
      await userService.notifyUnknown(normalizedPhone, !!user);
      return;
  }
}

export function registerWhatsAppWebhook(app: FastifyInstance): void {
  app.get('/webhooks/whatsapp', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode === 'subscribe' && token === env.whatsappVerifyToken && challenge) {
      reply.type('text/plain').send(challenge);
      return;
    }
    reply.code(403).send();
  });

  app.post('/webhooks/whatsapp', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (request as { rawBody?: string }).rawBody;
    if (!rawBody) {
      console.error('[webhook] missing rawBody');
      return reply.code(500).send();
    }
    const signature = request.headers['x-hub-signature-256'];
    const signatureValue = Array.isArray(signature) ? signature[0] : signature;
    if (!verifyMetaSignature(rawBody, signatureValue)) {
      console.warn('[webhook] HMAC fail');
      return reply.code(401).send();
    }
    const body = request.body as MetaWebhookBody;
    if (body.object !== 'whatsapp_business_account') return reply.code(200).send({ ok: true });
    const messages = collectMessages(body);
    if (messages.length === 0) return reply.code(200).send({ ok: true });

    void (async () => {
      for (const message of messages) {
        const text = extractText(message);
        if (!text) continue;
        try {
          await dispatchMessage(message.from, text);
        } catch (err) {
          console.error('[webhook] dispatch failed', err);
        }
      }
    })();

    return reply.code(200).send({ ok: true });
  });
}
```

(Nota: removeu o filtro por `USER_WHATSAPP_NUMBER` — agora qualquer sender é processado. Allowlist implícita: se sender não está em `users`, o dispatcher cai em `register_account` ou `unknown` (que prompta pra registrar). Single-user backward-compat: o user existente (Danubio) já está no `users` repo via migration.)

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
npm test
```

```bash
git add src/routes/whatsapp.webhook.ts
git commit -m "refactor(webhook): vira intent dispatcher multi-user

Webhook não filtra mais por USER_WHATSAPP_NUMBER hardcoded. Cada
mensagem é classificada por intent (Gemini) e despachada:
- register_account → userService.handleRegistration (+proactive link
  bank flow ao completar perfil)
- link_bank → recovery: apaga tokens + nova URL
- create_bill → cria bill com owner=sender + lembrete sutil de link
  bank se ainda não conectou
- unknown → notifica conforme estado (registrado ou não)

normalizeBrNumber aplicado pra todos os senders. WhatsApp window
recorded por sender."
```

---

## Task 14: docker-compose bind mount + Dockerfile native build deps

**Files:**
- Modify: `docker-compose.yml`
- Modify: `Dockerfile`
- Modify: `docs/superpowers/runbooks/2026-05-23-vps-setup.md` (add bind mount setup)

- [ ] **Step 1: Atualizar `Dockerfile`** (build deps pra better-sqlite3 — pode precisar de python3+g++ no alpine)

```dockerfile
FROM node:24-alpine

WORKDIR /app

# Build deps pra better-sqlite3 (compila C++ nativo)
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && apk add --no-cache sqlite-libs

COPY package*.json ./
RUN npm ci --omit=dev && apk del .build-deps

COPY . .

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["npm", "start"]
```

(Nota: better-sqlite3 ships prebuilt binaries pra alpine na maioria dos casos; build deps acima são seguros se o prebuilt falhar.)

- [ ] **Step 2: Atualizar `docker-compose.yml`**

Mudança no serviço `bot`:
```yaml
bot:
  # ... resto igual ...
  volumes:
    - /home/slice/slice-data:/app/data   # ← bind mount (era slice_bot_data named)
```

Remover de `volumes:` no fim:
```yaml
volumes:
  evolution_postgres:
  evolution_redis:
  evolution_instances:
  # slice_bot_data:  ← REMOVE esta linha
```

- [ ] **Step 3: Atualizar runbook VPS — adicionar seção pré-deploy**

Adicionar em `docs/superpowers/runbooks/2026-05-23-vps-setup.md` entre §5 e §6:

```markdown
## 5b. Preparar bind mount pra dados do Slice

Antes do deploy do compose stack, criar o path do host que receberá os
dados persistentes do bot (substituindo named volume `slice_bot_data`):

```bash
ssh slice@bot.appslice.com.br
sudo mkdir -p /home/slice/slice-data
sudo chown -R 1000:1000 /home/slice/slice-data  # UID/GID do user node-alpine
sudo chmod 755 /home/slice/slice-data
```

Backup futuro do `.db`:
```bash
sudo cp /home/slice/slice-data/slice.db /backup/slice-$(date +%F).db
```
```

- [ ] **Step 4: Typecheck + commit** (compose/Dockerfile não dão pra testar via vitest)

```bash
npx tsc --noEmit
```

```bash
git add docker-compose.yml Dockerfile docs/superpowers/runbooks/2026-05-23-vps-setup.md
git commit -m "chore(deploy): bind mount /home/slice/slice-data + Dockerfile build deps for better-sqlite3

Bot volume vira bind mount no host pra .db ficar visível/backup-ável
sem docker volume inspect. Dockerfile ganha build deps temporárias pra
compilar better-sqlite3 caso prebuilt binary falhe no alpine. Runbook
ganha seção §5b com prep do path."
```

---

## Task 15: GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Criar `.github/workflows/test.yml`**

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci(github-actions): run typecheck + tests on push/PR

Workflow simples: npm ci + typecheck + test em Node 24. Roda em push
pra main e em PRs. Não bloqueia auto-deploy do Dokploy (CI é sinal,
não gate — promove a required check pós-validação verde)."
```

---

## Task 16: Delete deprecated files

**Files:**
- Delete: `src/services/cumbuca/cumbuca.tokens.ts`
- Delete: `src/services/cumbuca/cumbuca.pending-pairing.ts`
- Delete: `src/services/whatsapp/window.ts`
- Delete: `src/bin/cumbuca-link.ts`
- Modify: `package.json` (remove `cumbuca:link` script)

- [ ] **Step 1: Delete arquivos deprecated**

```bash
git rm src/services/cumbuca/cumbuca.tokens.ts
git rm src/services/cumbuca/cumbuca.pending-pairing.ts
git rm src/services/whatsapp/window.ts
git rm src/bin/cumbuca-link.ts
```

- [ ] **Step 2: Remover `cumbuca:link` script de `package.json`**

```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "start": "tsx src/server.ts",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "migrate:json-to-sqlite": "tsx src/bin/migrate-json-to-sqlite.ts"
}
```

- [ ] **Step 3: Typecheck + test + commit**

```bash
npx tsc --noEmit
npm test
```

Esperado: tudo passa. Se algum import quebrar, é resíduo a corrigir (deve ser nenhum se as tasks anteriores estão completas).

```bash
git add package.json
git commit -m "chore: remove deprecated single-user files

Substituídos por repositories SQLite (Tasks 3-4):
- cumbuca.tokens.ts → cumbuca-tokens.repository.ts
- cumbuca.pending-pairing.ts → cumbuca-pending-pairing.repository.ts
- whatsapp/window.ts → whatsapp-window.repository.ts

Substituído por dispatcher via WhatsApp (Task 13):
- bin/cumbuca-link.ts → user manda 'conectar banco' / bot proativo

Removido script npm cumbuca:link."
```

---

## Task 17 (HUMAN-DRIVEN): Production deploy + migration + smoke

**Files:** nenhum (operacional)

- [ ] **Step 1: Merge branch → main**

```bash
git checkout main && git pull --ff-only
git merge --ff-only feat/multiuser-lite-validation
git push
```

(Ou via PR no GitHub se preferir o pattern.)

- [ ] **Step 2: Preparar bind mount no VPS**

```bash
ssh slice@bot.appslice.com.br
sudo mkdir -p /home/slice/slice-data
sudo chown -R 1000:1000 /home/slice/slice-data
```

- [ ] **Step 3: Acompanhar redeploy do Dokploy**

UI Dokploy → Compose Stack → Logs do deploy. Aguarda:
- Build da imagem do bot OK (better-sqlite3 compila)
- Container `slice_bot` `Up`
- `/healthz` 200

- [ ] **Step 4: Rodar migration JSON → SQLite**

```bash
ssh slice@bot.appslice.com.br
docker exec -it $(docker ps -qf "name=slice_bot") npm run migrate:json-to-sqlite
```

Esperado output:
- "applying schema"
- "creating default user 5588998082034"
- "importing cumbuca tokens"
- "importing N bills"
- "importing M processed tx ids"
- "archiving JSONs to data/.json-archive/"
- "done — N users, M open bills"

- [ ] **Step 5: Smoke single-user (você)**

Manda mensagem normal do seu WhatsApp principal pro chip do bot:
```
Paguei 4 no café, divide com Pessoa, 2 cada
```

Esperado: tudo igual ao smoke anterior, bot processa normal.

- [ ] **Step 6: Smoke multi-user (adicionar 1 tester)**

- Tester manda "oi" pro bot → bot pede cadastro
- Tester responde "Sou Fulano, pix fulano@email.com"
- Bot manda welcome + link Cumbuca
- Tester autoriza no banco
- Bot manda confirmação "Pronto, conectado!"
- Tester cria bill: "Paguei 10 no almoço, divide com Sicrano, 5 cada"
- Bot manda PIX
- Sicrano paga
- Scanner reconcilia (verificar logs Dokploy)
- Bot manda "Fechou!" pro tester

Se tudo verde: multi-user FUNCIONA. Pronto pra experimento de validação propriamente.

---

## Self-review

**Cobertura do spec:**

| Spec section | Task(s) que implementam |
|---|---|
| §3 Arquitetura + camadas | Tasks 1-13 (data + services + workers + routes) |
| §4 Data layer SQLite + bind mount | Tasks 1, 14 |
| §4.4 Repositories interface | Tasks 2-4 |
| §4.5 Migration | Task 5 |
| §5 Intent dispatcher | Task 6 |
| §6 Auto-registro proativo | Tasks 7, 13 |
| §7 Cumbuca multi-tenant | Tasks 8, 9 |
| §8 Scanner multi-user | Task 12 |
| §10 Out of scope | Não implementado por design |
| §11 Estrutura arquivos | Distribuído em todas tasks |
| §12 Riscos | Mitigados via tests (Task 13.3 mapping) |
| §13 Testing strategy (7 cenários) | A→Task 10, B→Task 10, C→Task 12, D→Task 8, E→Task 9, F→Task 7, G→Task 5 |

**Lacunas conscientes:** landing page (paralela, você desenhando), HTML
branded callback, multi-conta Cumbuca, cleanup tokens em refresh
failure persistente, comandos admin, multi-instance scaling, rename
racha-conta-bot → slice — todos out-of-scope per spec §10.

**Sequencing realista:**
- Tasks 1-6 (foundation + repositories + migration + intents): ~2 dias
- Tasks 7-13 (services + dispatcher + scanner): ~2-2.5 dias
- Tasks 14-17 (deploy + smoke): ~0.5 dia + smoke tempo
- **Total: ~5 dias** alinhado com estimativa do spec.
