import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTransfers } from '../../src/hooks/useTransfers.js';
import * as api from '../../src/services/api.js';
import { DEMO_PUBLIC_KEY } from '../../src/services/wallet.js';

describe('useTransfers race and cancellation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('does not let a stale slower response overwrite newer filters', async () => {
    let resolveSlow;
    const slow = new Promise((resolve) => {
      resolveSlow = resolve;
    });

    const listSpy = vi
      .spyOn(api, 'listTransfers')
      .mockImplementation((opts) => {
        if (opts.search === 'old') {
          return slow.then(() => [
            {
              id: 'tx_old',
              recipient: 'old@example.com',
              from: 'USD',
              to: 'NGN',
              sendAmount: '1',
              receiveAmount: '2',
              status: 'completed',
              createdAt: '2026-06-01T00:00:00Z',
              actorId: DEMO_PUBLIC_KEY,
            },
          ]);
        }
        return Promise.resolve([
          {
            id: 'tx_new',
            recipient: 'new@example.com',
            from: 'USD',
            to: 'NGN',
            sendAmount: '1',
            receiveAmount: '2',
            status: 'completed',
            createdAt: '2026-06-02T00:00:00Z',
            actorId: DEMO_PUBLIC_KEY,
          },
        ]);
      });

    const { result, rerender } = renderHook(
      ({ search }) =>
        useTransfers({
          actorId: DEMO_PUBLIC_KEY,
          filters: { search },
        }),
      { initialProps: { search: 'old' } },
    );

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalled();
    });

    rerender({ search: 'new' });

    await waitFor(() => {
      expect(result.current.transfers.map((t) => t.id)).toEqual(['tx_new']);
    });

    await act(async () => {
      resolveSlow();
      await slow;
    });

    // Stale "old" payload must not clobber the current filter results.
    expect(result.current.transfers.map((t) => t.id)).toEqual(['tx_new']);
  });

  it('aborts the previous request when filters change', async () => {
    const signals = [];
    vi.spyOn(api, 'listTransfers').mockImplementation((opts) => {
      signals.push(opts.signal);
      return new Promise(() => {
        /* never resolves — cancellation is the assertion */
      });
    });

    const { rerender } = renderHook(
      ({ search }) =>
        useTransfers({
          actorId: DEMO_PUBLIC_KEY,
          filters: { search },
        }),
      { initialProps: { search: 'a' } },
    );

    await waitFor(() => expect(signals.length).toBe(1));
    rerender({ search: 'ab' });
    await waitFor(() => expect(signals.length).toBe(2));
    expect(signals[0].aborted).toBe(true);
  });

  it('passes actorId on every list request', async () => {
    const listSpy = vi.spyOn(api, 'listTransfers').mockResolvedValue([]);
    renderHook(() =>
      useTransfers({ actorId: 'GCUSTOM', filters: { status: 'pending' } }),
    );
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(listSpy.mock.calls[0][0]).toMatchObject({
      actorId: 'GCUSTOM',
      status: 'pending',
    });
  });
});
