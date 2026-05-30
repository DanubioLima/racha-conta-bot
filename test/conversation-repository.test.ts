import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/repositories/db.js';
import { conversationRepository } from '../src/repositories/conversation.repository.js';
import { resetDb } from './setup.js';

const PHONE = '558899990000';

beforeEach(() => resetDb());

describe('conversationRepository', () => {
  it('append e recent fazem roundtrip em ordem cronológica', async () => {
    // ARRANGE / ACT
    await conversationRepository.append(PHONE, 'user', 'oi');
    await conversationRepository.append(PHONE, 'bot', 'opa');

    // ASSERT
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns).toEqual([
      { role: 'user', text: 'oi' },
      { role: 'bot', text: 'opa' },
    ]);
  });

  it('corta o texto do turno em 500 chars', async () => {
    // ARRANGE / ACT
    await conversationRepository.append(PHONE, 'user', 'x'.repeat(600));

    // ASSERT
    const turns = await conversationRepository.recent(PHONE, 8);
    expect(turns[0]!.text).toHaveLength(500);
  });

  it('mantém no máximo 16 turnos por telefone (FIFO)', async () => {
    // ARRANGE / ACT
    for (let i = 0; i < 20; i++) {
      await conversationRepository.append(PHONE, 'user', `t${i}`);
    }

    // ASSERT — só os 16 últimos sobrevivem
    const turns = await conversationRepository.recent(PHONE, 100);
    expect(turns).toHaveLength(16);
    expect(turns[0]!.text).toBe('t4'); // t0..t3 caíram
    expect(turns[15]!.text).toBe('t19');
  });

  it('recent ignora turnos mais velhos que o TTL (6h)', async () => {
    // ARRANGE — insere um turno "velho" direto (7h atrás) + um fresco
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO conversation_turns (phone, role, text, at) VALUES (?, ?, ?, ?)')
      .run(PHONE, 'user', 'velho', sevenHoursAgo);
    await conversationRepository.append(PHONE, 'user', 'novo');

    // ACT
    const turns = await conversationRepository.recent(PHONE, 8);

    // ASSERT
    expect(turns).toEqual([{ role: 'user', text: 'novo' }]);
  });
});
