import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../src/services/api.js';
import { DEMO_PUBLIC_KEY } from '../../src/services/wallet.js';

const STORAGE_KEY = 'remitflow.transfers';

function seed(rows) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}

describe('listTransfers search / cancellation / scope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('requires actor scope and hides other actors', async () => {
    seed([
      {
        id: 'tx_mine',
        recipient: 'me@example.com',
        from: 'USD',
        to: 'NGN',
        sendAmount: 10,
        receiveAmount: 20,
        status: 'completed',
        createdAt: '2026-06-01T00:00:00Z',
        actorId: DEMO_PUBLIC_KEY,
      },
      {
        id: 'tx_theirs',
        recipient: 'them@example.com',
        from: 'USD',
        to: 'NGN',
        sendAmount: 10,
        receiveAmount: 20,
        status: 'completed',
        createdAt: '2026-06-02T00:00:00Z',
        actorId: 'GOTHERWALLET',
      },
    ]);

    const pending = api.listTransfers({ actorId: DEMO_PUBLIC_KEY });
    await vi.advanceTimersByTimeAsync(400);
    const rows = await pending;
    expect(rows.map((r) => r.id)).toEqual(['tx_mine']);
  });

  it('rejects when actorId is missing and no fallback is provided via empty string', async () => {
    expect(() => api.listTransfers({ actorId: '' })).toThrow(/actorId/i);
  });

  it('cancels an obsolete in-flight query via AbortSignal', async () => {
    seed([
      {
        id: 'tx_1',
        recipient: 'amina@example.com',
        from: 'USD',
        to: 'NGN',
        sendAmount: 10,
        receiveAmount: 20,
        status: 'completed',
        createdAt: '2026-06-01T00:00:00Z',
        actorId: DEMO_PUBLIC_KEY,
      },
    ]);

    const controller = new AbortController();
    const pending = api.listTransfers({
      actorId: DEMO_PUBLIC_KEY,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('caps large result sets', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `tx_${i}`,
      recipient: `user${i}@example.com`,
      from: 'USD',
      to: 'NGN',
      sendAmount: 10,
      receiveAmount: 20,
      status: 'completed',
      createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString(),
      actorId: DEMO_PUBLIC_KEY,
    }));
    seed(rows);

    const pending = api.listTransfers({
      actorId: DEMO_PUBLIC_KEY,
      limit: 40,
    });
    await vi.advanceTimersByTimeAsync(400);
    const result = await pending;
    expect(result).toHaveLength(40);
  });

  it('applies search filter server-side', async () => {
    seed([
      {
        id: 'tx_1',
        recipient: 'amina@example.com',
        from: 'USD',
        to: 'NGN',
        sendAmount: 10,
        receiveAmount: 20,
        status: 'completed',
        createdAt: '2026-06-01T00:00:00Z',
        actorId: DEMO_PUBLIC_KEY,
      },
      {
        id: 'tx_2',
        recipient: 'bola@example.com',
        from: 'USD',
        to: 'NGN',
        sendAmount: 10,
        receiveAmount: 20,
        status: 'pending',
        createdAt: '2026-06-02T00:00:00Z',
        actorId: DEMO_PUBLIC_KEY,
      },
    ]);

    const pending = api.listTransfers({
      actorId: DEMO_PUBLIC_KEY,
      search: 'bola',
    });
    await vi.advanceTimersByTimeAsync(400);
    const result = await pending;
    expect(result.map((r) => r.id)).toEqual(['tx_2']);
  });
});
