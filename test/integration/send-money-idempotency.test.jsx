import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    const user = userEvent.setup();
    render(<App />);

    await user.type(
      await screen.findByLabelText(/recipient/i),
      'amina@example.com',
    );
    await user.type(screen.getByLabelText(/^amount$/i), '25');
    await user.click(screen.getByRole('button', { name: /review & send/i }));
    const dialog = await screen.findByRole('dialog', {
      name: /confirm your transfer/i,
    });
    const confirm = within(dialog).getByRole('button', {
      name: /confirm transfer/i,
    });

    // Rapid double activation of Confirm; submissionLock + idempotency key
    // must keep a single persisted record.
    await Promise.all([user.click(confirm), user.click(confirm)]);

    await screen.findByRole(
      'dialog',
      { name: /transfer submitted/i },
      { timeout: 5000 },
    );

    const listed = await api.listTransfers();
    const mine = listed.filter(
      (t) =>
        t.recipient === 'amina@example.com' &&
        Number(t.sendAmount) === 25 &&
        t.idempotencyKey,
    );
    expect(mine.length).toBe(1);
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
    await screen.findByRole('heading', { name: /send money/i });
    expect(spy).not.toHaveBeenCalled();
    const listed = await api.listTransfers();
    expect(listed.filter((t) => t.idempotencyKey === idempotencyKey)).toHaveLength(
      1,
    );
  });

  it('edited payload after a prior intent uses a new idempotency key', async () => {
    const firstKey = await idempotencyKeyFor(
      fingerprintTransferPayload({
        recipient: 'amina@example.com',
        from: 'USD',
        to: 'NGN',
        sendAmount: 10,
        receiveAmount: 1000,
        fee: 0.1,
        rate: 100,
      }),
    );
    const secondKey = await idempotencyKeyFor(
      fingerprintTransferPayload({
        recipient: 'amina@example.com',
        from: 'USD',
        to: 'NGN',
        sendAmount: 20,
        receiveAmount: 2000,
        fee: 0.2,
        rate: 100,
      }),
    );
    expect(firstKey).not.toEqual(secondKey);

    const a = await api.createTransfer({
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 10,
      receiveAmount: 1000,
      fee: 0.1,
      rate: 100,
      idempotencyKey: firstKey,
    });
    const a2 = await api.createTransfer({
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 10,
      receiveAmount: 1000,
      fee: 0.1,
      rate: 100,
      idempotencyKey: firstKey,
    });
    expect(a2.id).toBe(a.id);
    const b = await api.createTransfer({
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 20,
      receiveAmount: 2000,
      fee: 0.2,
      rate: 100,
      idempotencyKey: secondKey,
    });
    expect(b.id).not.toBe(a.id);
  });
});
