import { beforeEach, describe, expect, it } from 'vitest';
import {
  fingerprintTransferPayload,
  idempotencyKeyFor,
  newTransferIntentNonce,
  saveTransferOperation,
  getTransferOperation,
  getLatestRecoverableOperation,
  clearTransferOperation,
} from '../../src/utils/transferIntent.js';

describe('transferIntent', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('fingerprints the exact payload and changes when the payload changes', () => {
    const base = {
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 100,
      receiveAmount: 150000,
      fee: 1,
      rate: 1500,
    };
    const a = fingerprintTransferPayload(base);
    const b = fingerprintTransferPayload({ ...base, sendAmount: 101 });
    expect(a).not.toEqual(b);
    expect(fingerprintTransferPayload(base)).toEqual(a);
  });

  it('keeps distinct integer amounts and full decimal precision', () => {
    const base = {
      recipient: 'amina@example.com', from: 'USD', to: 'NGN',
      receiveAmount: 1500, fee: 1, rate: 1500,
    };
    const fingerprints = [1, 10, 100, '0.000000001'].map((sendAmount) =>
      fingerprintTransferPayload({ ...base, sendAmount }),
    );
    expect(new Set(fingerprints).size).toBe(4);
    expect(fingerprintTransferPayload({ ...base, sendAmount: '0.10' }))
      .toBe(fingerprintTransferPayload({ ...base, sendAmount: 0.1 }));
  });

  it('derives a stable idempotency key for the same fingerprint', async () => {
    const fp = 'usd|ngn|100';
    const k1 = await idempotencyKeyFor(fp);
    const k2 = await idempotencyKeyFor(fp);
    expect(k1).toEqual(k2);
    expect(k1.startsWith('idem_')).toBe(true);
  });

  it('uses a new key for a separate identical transfer intent', async () => {
    const fingerprint = 'same recipient and amount';
    const first = await idempotencyKeyFor(fingerprint, newTransferIntentNonce());
    const second = await idempotencyKeyFor(fingerprint, newTransferIntentNonce());
    expect(second).not.toBe(first);
  });

  it('persists only a safe operation reference across reads', () => {
    saveTransferOperation({
      idempotencyKey: 'idem_abc',
      fingerprint: 'fp',
      transferId: 'tx_1',
      status: 'submitting',
    });
    expect(getTransferOperation('idem_abc')).toMatchObject({
      idempotencyKey: 'idem_abc',
      transferId: 'tx_1',
      status: 'submitting',
    });
    expect(getLatestRecoverableOperation()?.idempotencyKey).toBe('idem_abc');
    expect(getLatestRecoverableOperation('fp')?.idempotencyKey).toBe('idem_abc');
    expect(getLatestRecoverableOperation('other')).toBeNull();
    clearTransferOperation('idem_abc');
    expect(getTransferOperation('idem_abc')).toBeNull();
  });

  it('treats a changed payload as a new intent requiring a new key', async () => {
    const a = await idempotencyKeyFor(
      fingerprintTransferPayload({
        recipient: 'a@x.com',
        from: 'USD',
        to: 'NGN',
        sendAmount: 10,
        receiveAmount: 1000,
      }),
    );
    const b = await idempotencyKeyFor(
      fingerprintTransferPayload({
        recipient: 'a@x.com',
        from: 'USD',
        to: 'NGN',
        sendAmount: 11,
        receiveAmount: 1100,
      }),
    );
    expect(a).not.toEqual(b);
  });

  it('does not treat dismissed or failed ops as recoverable', () => {
    saveTransferOperation({
      idempotencyKey: 'idem_done',
      fingerprint: 'fp',
      transferId: 'tx_1',
      status: 'dismissed',
    });
    expect(getLatestRecoverableOperation()).toBeNull();
    saveTransferOperation({
      idempotencyKey: 'idem_fail',
      fingerprint: 'fp2',
      status: 'failed',
    });
    expect(getLatestRecoverableOperation()).toBeNull();
  });
});
