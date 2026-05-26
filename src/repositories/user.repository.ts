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
// phone é PRIMARY KEY (unique). OR REPLACE preserva o comportamento antigo do
// Record, em que insert sobrescrevia um telefone já existente.
const insertUser = db.prepare(
  `INSERT OR REPLACE INTO users (phone, name, pix_key, pix_merchant_name, pix_merchant_city, created_at)
   VALUES (@phone, @name, @pix_key, @pix_merchant_name, @pix_merchant_city, @created_at)`,
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
