import { db } from './db.js';

// Registra mensagens que o Gemini não conseguiu classificar (intent unknown),
// pra analisar depois e descobrir usos não previstos. Persistido no banco,
// não em log (que rotaciona). Cap FIFO pra não crescer sem limite.
const MAX_ENTRIES = 1000;

export interface UnknownIntent {
  at: string;
  phone: string;
  text: string;
  registered: boolean;
}

interface UnknownIntentRow {
  at: string;
  phone: string;
  text: string;
  registered: number;
}

const insertEntry = db.prepare(
  'INSERT INTO unknown_intents (at, phone, text, registered) VALUES (@at, @phone, @text, @registered)',
);
const trim = db.prepare(
  `DELETE FROM unknown_intents WHERE id NOT IN (
     SELECT id FROM unknown_intents ORDER BY id DESC LIMIT ?
   )`,
);
const selectAll = db.prepare<[], UnknownIntentRow>(
  'SELECT at, phone, text, registered FROM unknown_intents ORDER BY id',
);

const recordTx = db.transaction((entry: { at: string; phone: string; text: string; registered: number }) => {
  insertEntry.run(entry);
  trim.run(MAX_ENTRIES);
});

export const unknownIntentsRepository = {
  async record(input: { phone: string; text: string; registered: boolean }): Promise<void> {
    recordTx({
      at: new Date().toISOString(),
      phone: input.phone,
      text: input.text,
      registered: input.registered ? 1 : 0,
    });
  },

  async list(): Promise<UnknownIntent[]> {
    return selectAll.all().map((row) => ({
      at: row.at,
      phone: row.phone,
      text: row.text,
      registered: row.registered === 1,
    }));
  },
};
