import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App.jsx';
import * as api from '../../src/services/api.js';
import {
  fingerprintTransferPayload,
  idempotencyKeyFor,
  saveTransferOperation,
} from '../../src/utils/transferIntent.js';

describe('SendMoney duplicate-submission guard', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    window.history.pushState({}, '', '/send');
    vi.restoreAllMocks();
  });

  it('double-confirm with the same payload creates only one transfer', async () => {
    const spy = vi.spyOn(api, 'createTransfer');
    const user = userEvent.setup();
    render(<App />);

    await user.type(
      await screen.findByLabelText(/recipient/i),
      'amina@example.com',
    );
    await user.type(screen.getByLabelText(/^amount$/i), '25');
    await user.click(screen.getByRole('button', { name: /review & send/i }));
    const confirm = await screen.findByRole('button', {
      name: /confirm transfer/i,
    });
    await user.dblClick(confirm);

    await waitFor(
      () => {
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 5000 },
    );
    const keys = spy.mock.calls.map((c) => c[0]?.idempotencyKey).filter(Boolean);
    expect(new Set(keys).size).toBe(1);
    const created = await api.listTransfers();
    const matches = created.filter(
      (t) => t.idempotencyKey && t.idempotencyKey === keys[0],
    );
    expect(matches.length).toBe(1);
  });

  it('refresh restores in-flight status without creating a second transfer', async () => {
    const payload = {
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 25,
      receiveAmount: 36827.5,
      fee: 0.25,
      rate: 1473.1,
    };
    const fingerprint = fingerprintTransferPayload(payload);
    const idempotencyKey = await idempotencyKeyFor(fingerprint);
    const prior = await api.createTransfer({ ...payload, idempotencyKey });
    saveTransferOperation({
      idempotencyKey,
      fingerprint,
      transferId: prior.id,
      status: 'pending',
    });

    const spy = vi.spyOn(api, 'createTransfer');
    render(<App />);
    // Navigating back to send with a persisted op must not auto-submit again.
    await screen.findByRole('heading', { name: /send money/i });
    expect(spy).not.toHaveBeenCalled();
    const listed = await api.listTransfers();
    expect(listed.filter((t) => t.idempotencyKey === idempotencyKey)).toHaveLength(
      1,
    );
  });

  it('edited payload after a prior intent uses a new idempotency key', async () => {
    const spy = vi.spyOn(api, 'createTransfer');
    const user = userEvent.setup();
    render(<App />);

    await user.type(
      await screen.findByLabelText(/recipient/i),
      'amina@example.com',
    );
    await user.type(screen.getByLabelText(/^amount$/i), '10');
    await user.click(screen.getByRole('button', { name: /review & send/i }));
    await user.click(
      await screen.findByRole('button', { name: /confirm transfer/i }),
    );
    await screen.findByRole('dialog', { name: /transfer submitted/i }, { timeout: 5000 });
    await user.click(screen.getByRole('button', { name: /close/i }));

    await user.clear(screen.getByLabelText(/^amount$/i));
    await user.type(screen.getByLabelText(/^amount$/i), '20');
    await user.click(screen.getByRole('button', { name: /review & send/i }));
    await user.click(
      await screen.findByRole('button', { name: /confirm transfer/i }),
    );
    await screen.findByRole('dialog', { name: /transfer submitted/i }, { timeout: 5000 });

    const keys = spy.mock.calls.map((c) => c[0]?.idempotencyKey).filter(Boolean);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
