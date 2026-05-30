import { db } from './db.js';

export interface HistoryTurn {
  role: 'user' | 'bot';
  text: string;
}

const MAX_TURNS_PER_PHONE = 16; // cap FIFO por telefone (não cresce sem limite)
const WINDOW_TTL_HOURS = 6;     // contexto mais velho que isso não volta
const MAX_TURN_TEXT = 500;      // corta texto longo (tokens + superfície de injection)

interface TurnRow {
  role: 'user' | 'bot';
  text: string;
}

const insertTurn = db.prepare(
  'INSERT INTO conversation_turns (phone, role, text, at) VALUES (@phone, @role, @text, @at)',
);
// phone aparece 2x: o subquery correlacionado não reusa o `?` externo. Este trim
// a cada append é o que limita o crescimento — no máximo MAX_TURNS_PER_PHONE por
// telefone (o TTL é só filtro de leitura no recent, não apaga linhas).
const trimPhone = db.prepare(
  `DELETE FROM conversation_turns WHERE phone = ? AND id NOT IN (
     SELECT id FROM conversation_turns WHERE phone = ? ORDER BY id DESC LIMIT ?
   )`,
);
const selectRecent = db.prepare<[string, string, number], TurnRow>(
  `SELECT role, text FROM conversation_turns
   WHERE phone = ? AND at >= ?
   ORDER BY id DESC LIMIT ?`,
);

const appendTx = db.transaction(
  (entry: { phone: string; role: string; text: string; at: string }) => {
    insertTurn.run(entry);
    trimPhone.run(entry.phone, entry.phone, MAX_TURNS_PER_PHONE);
  },
);

export const conversationRepository = {
  async append(phone: string, role: 'user' | 'bot', text: string): Promise<void> {
    appendTx({ phone, role, text: text.slice(0, MAX_TURN_TEXT), at: new Date().toISOString() });
  },

  // Últimos `limit` turnos dentro do TTL, em ordem cronológica (antigo → novo).
  async recent(phone: string, limit = 8): Promise<HistoryTurn[]> {
    const cutoff = new Date(Date.now() - WINDOW_TTL_HOURS * 60 * 60 * 1000).toISOString();
    const rows = selectRecent.all(phone, cutoff, limit);
    return rows.reverse().map((row) => ({ role: row.role, text: row.text }));
  },
};
