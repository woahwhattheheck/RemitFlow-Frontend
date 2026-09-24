import { beforeEach, describe, expect, it } from 'vitest';
import { createTransfer, listTransfers } from '../../src/services/api.js';

describe('createTransfer idempotency', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('returns the same transfer for a repeated idempotency key', async () => {
    const payload = {
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 50,
      receiveAmount: 75000,
      fee: 1,
      rate: 1500,
      idempotencyKey: 'idem_test_repeat_1',
    };
    const first = await createTransfer(payload);
    const second = await createTransfer(payload);
    expect(second.id).toBe(first.id);
    const all = await listTransfers();
    expect(
      all.filter((t) => t.idempotencyKey === 'idem_test_repeat_1'),
    ).toHaveLength(1);
  });

  it('dedupes concurrent creates that share an idempotency key', async () => {
    const payload = {
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 50,
      receiveAmount: 75000,
      fee: 1,
      rate: 1500,
      idempotencyKey: 'idem_concurrent_1',
    };
    const [a, b] = await Promise.all([
      createTransfer(payload),
      createTransfer(payload),
    ]);
    expect(a.id).toBe(b.id);
    const all = await listTransfers();
    expect(
      all.filter((t) => t.idempotencyKey === 'idem_concurrent_1'),
    ).toHaveLength(1);
  });

  it('rejects different payloads that reuse a key, even while the first is pending', async () => {
    const payload = {
      recipient: 'amina@example.com', from: 'USD', to: 'NGN',
      sendAmount: 50, receiveAmount: 75000, fee: 1, rate: 1500,
      idempotencyKey: 'idem_conflict',
    };
    const pending = createTransfer(payload);
    await expect(createTransfer({ ...payload, sendAmount: 51 }))
      .rejects.toMatchObject({ name: 'ContractViolationError' });
    const original = await pending;
    await expect(createTransfer({ ...payload, sendAmount: 51 }))
      .rejects.toMatchObject({ name: 'ContractViolationError' });
    const listed = await listTransfers();
    expect(listed.filter((t) => t.idempotencyKey === payload.idempotencyKey))
      .toHaveLength(1);
    expect(original.sendAmount).toBe('50');
  });

  it('creates a new transfer when the idempotency key changes with the payload', async () => {
    const base = {
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 50,
      receiveAmount: 75000,
      fee: 1,
      rate: 1500,
    };
    const a = await createTransfer({ ...base, idempotencyKey: 'idem_a' });
    const b = await createTransfer({
      ...base,
      sendAmount: 51,
      idempotencyKey: 'idem_b',
    });
    expect(b.id).not.toBe(a.id);
  });
});
