import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sentMessages } = vi.hoisted(() => ({ sentMessages: [] as { to: string; text: string }[] }));

vi.mock('../src/services/whatsapp/whatsapp.js', () => ({
  sendText: vi.fn(async (to: string, text: string) => { sentMessages.push({ to, text }); }),
  sendImage: vi.fn(),
}));
vi.mock('../src/workers/payment-scanner.worker.js', () => ({ notifyNewBillCreated: vi.fn() }));

import { closeBills, markPaid } from '../src/services/bills/bill.service.js';
import { billRepository } from '../src/repositories/bill.repository.js';
import { resetDb, registerUser, insertOpenBill } from './setup.js';

const PHONE = '558899990000';

beforeEach(() => {
  resetDb();
  sentMessages.length = 0;
});

describe('closeBills (encerrar)', () => {
  it('conta com pendente, sem confirmar → pede confirmação e NÃO fecha', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40,
      participants: [{ name: 'João', amount_due: 20 }] });

    // ACT
    const msg = await closeBills(PHONE, { reference: 'pizza' });

    // ASSERT
    expect(msg).toContain('Fecho assim mesmo?');
    expect(msg).toContain('João');
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(1); // segue aberta
  });

  it('conta com pendente + confirmed → encerra (CLOSED)', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40,
      participants: [{ name: 'João', amount_due: 20 }] });

    // ACT
    const msg = await closeBills(PHONE, { reference: 'pizza', confirmed: true });

    // ASSERT
    expect(msg).toContain('Encerrei a conta Pizza');
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });

  it('conta sem pendente → encerra direto, sem pedir confirmação', async () => {
    // ARRANGE — participante já PAID (sem pendente)
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40,
      participants: [{ name: 'João', amount_due: 40, status: 'PAID' }] });

    // ACT
    const msg = await closeBills(PHONE, {});

    // ASSERT
    expect(msg).toContain('Encerrei a conta Pizza');
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });

  it('all sem confirmar (há pendentes) → pede confirmação, nada fecha', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40, participants: [{ name: 'João', amount_due: 20 }] });
    await insertOpenBill(PHONE, { id: 'b2', description: 'Uber', total: 30, participants: [{ name: 'Ana', amount_due: 15 }] });

    // ACT
    const msg = await closeBills(PHONE, { all: true });

    // ASSERT
    expect(msg).toContain('TODAS assim mesmo?');
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(2);
  });

  it('all + confirmed → encerra todas', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40, participants: [{ name: 'João', amount_due: 20 }] });
    await insertOpenBill(PHONE, { id: 'b2', description: 'Uber', total: 30, participants: [{ name: 'Ana', amount_due: 15 }] });

    // ACT
    const msg = await closeBills(PHONE, { all: true, confirmed: true });

    // ASSERT
    expect(msg).toContain('Encerrei suas 2 contas em aberto');
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0);
  });

  it('nenhuma conta aberta → avisa', async () => {
    // ARRANGE
    await registerUser(PHONE);

    // ACT
    const msg = await closeBills(PHONE, { all: true });

    // ASSERT
    expect(msg).toContain('não tem nenhuma conta em aberto pra fechar');
  });

  it('referência casa mais de uma → pergunta qual', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Bar do Zé', total: 40, participants: [{ name: 'João', amount_due: 20 }] });
    await insertOpenBill(PHONE, { id: 'b2', description: 'Bar da esquina', total: 30, participants: [{ name: 'Ana', amount_due: 15 }] });

    // ACT
    const msg = await closeBills(PHONE, { reference: 'bar' });

    // ASSERT
    expect(msg).toContain('Qual conta?');
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(2);
  });
});

describe('markPaid por nome da CONTA', () => {
  it('conta nomeada com 1 match → quita todos os pendentes e fecha', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Netflix', total: 30,
      participants: [{ name: 'Ana', amount_due: 15 }, { name: 'Beto', amount_due: 15 }] });

    // ACT
    const msg = await markPaid(PHONE, { bill: 'Netflix' });

    // ASSERT
    expect(msg).toContain('foi paga');
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(0); // fechou
  });

  it('conta nomeada não encontrada → avisa', async () => {
    // ARRANGE
    await registerUser(PHONE);
    await insertOpenBill(PHONE, { id: 'b1', description: 'Pizza', total: 40, participants: [{ name: 'João', amount_due: 20 }] });

    // ACT
    const msg = await markPaid(PHONE, { bill: 'Netflix' });

    // ASSERT
    expect(msg).toContain('Não achei a conta "Netflix"');
    expect(await billRepository.findOpenForOwner(PHONE)).toHaveLength(1);
  });
});
