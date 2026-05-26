import { db } from './db.js';

export interface User {
  phone: string;                 // E.164 sem +, normalizado (ver webhook)
  name: string;
  pix_key: string;               // '' enquanto não coletado
  pix_merchant_name: string;     // derivado de name (≤25 chars) quando pix salvo
  pix_merchant_city: string;     // 'BRASIL'
  created_at: string;
}

const selectByPhone = db.prepare<[string], User>('SELECT * FROM users WHERE phone = ?');
// phone é PRIMARY KEY (unique). UPSERT preserva o overwrite-on-duplicate do
// Record antigo sem o DELETE+INSERT do OR REPLACE — que, com a FK bills->users,
// dispararia o ON DELETE e quebraria o re-registro de um phone que já tem bills.
const insertUser = db.prepare(
  `INSERT INTO users (phone, name, pix_key, pix_merchant_name, pix_merchant_city, created_at)
   VALUES (@phone, @name, @pix_key, @pix_merchant_name, @pix_merchant_city, @created_at)
   ON CONFLICT(phone) DO UPDATE SET
     name = excluded.name,
     pix_key = excluded.pix_key,
     pix_merchant_name = excluded.pix_merchant_name,
     pix_merchant_city = excluded.pix_merchant_city,
     created_at = excluded.created_at`,
);
const updateUser = db.prepare(
  `UPDATE users SET name = @name, pix_key = @pix_key, pix_merchant_name = @pix_merchant_name,
   pix_merchant_city = @pix_merchant_city, created_at = @created_at WHERE phone = @phone`,
);

export const userRepository = {
  async findByPhone(phone: string): Promise<User | null> {
    return selectByPhone.get(phone) ?? null;
  },

  async insert(user: User): Promise<void> {
    insertUser.run(user);
  },

  async update(phone: string, partial: Partial<User>): Promise<User | null> {
    const existing = selectByPhone.get(phone);
    if (!existing) return null;
    const updated: User = { ...existing, ...partial };
    updateUser.run(updated);
    return updated;
  },
};
