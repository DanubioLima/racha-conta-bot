import { describe, it, expect, beforeEach } from 'vitest';
import { userRepository } from '../src/repositories/user.repository.js';
import { resetDb } from './setup.js';

beforeEach(() => resetDb());

describe('harness — banco efêmero', () => {
  it('insere e lê via repositório, e resetDb limpa', async () => {
    // ARRANGE
    await userRepository.insert({
      phone: '558800000000', name: 'Teste', pix_key: 'x@y.com',
      pix_merchant_name: 'Teste', pix_merchant_city: 'BRASIL', created_at: '2026-05-30T00:00:00Z',
    });

    // ACT
    const found = await userRepository.findByPhone('558800000000');

    // ASSERT
    expect(found?.name).toBe('Teste');

    // ACT — reset
    resetDb();

    // ASSERT
    expect(await userRepository.findByPhone('558800000000')).toBeNull();
  });
});
