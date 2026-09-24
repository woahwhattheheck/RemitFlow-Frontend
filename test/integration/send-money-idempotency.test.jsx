import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App.jsx';
import * as api from '../../src/services/api.js';
import {
  fingerprintTransferPayload,
  getLatestRecoverableOperation,
  idempotencyKeyFor,
  saveTransferOperation,
} from '../../src/utils/transferIntent.js';

async function fillValidForm(user, amount = '25') {
  await user.type(
    await screen.findByLabelText(/recipient/i),
    'amina@example.com',
  );
  await user.type(screen.getByLabelText(/^amount$/i), amount);
}

describe('SendMoney duplicate-submission guard', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    window.history.pushState({}, '', '/send');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('double-confirm with the same payload creates only one transfer', async () => {
    const user = userEvent.setup();
    render(<App />);

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /review & send/i }));
    const dialog = await screen.findByRole('dialog', {
      name: /confirm your transfer/i,
    });
    const confirm = within(dialog).getByRole('button', {
      name: /confirm transfer/i,
    });

    // Rapid double activation of Confirm; submissionLock + idempotency key
    // must keep a single persisted record.
    act(() => {
      confirm.click();
      confirm.click();
    });

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

  it('allows another identical transfer after the first was acknowledged', async () => {
    const user = userEvent.setup();
    render(<App />);
    await fillValidForm(user, '25');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await user.click(screen.getByRole('button', { name: /review & send/i }));
      const confirm = await screen.findByRole('dialog', { name: /confirm your transfer/i });
      await user.click(within(confirm).getByRole('button', { name: /confirm transfer/i }));
      const success = await screen.findByRole('dialog', { name: /transfer submitted/i }, { timeout: 5000 });
      await user.click(within(success).getByRole('button', { name: /^close$/i }));
    }
    const listed = await api.listTransfers();
    const sent = listed.filter((t) => t.recipient === 'amina@example.com' && Number(t.sendAmount) === 25 && t.idempotencyKey);
    expect(sent).toHaveLength(2);
    expect(sent[0].idempotencyKey).not.toBe(sent[1].idempotencyKey);
    expect(sessionStorage.getItem('remitflow.transferOps')).not.toContain('amina@example.com');
  });

  it('refresh restores in-flight status without creating a second transfer', async () => {
    const payload = {
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 25,
      receiveAmount: 36642.38,
      fee: 0.25,
      rate: 1480.5,
    };
    const fingerprint = fingerprintTransferPayload(payload);
    const idempotencyKey = await idempotencyKeyFor(fingerprint);
    const prior = await api.createTransfer({ ...payload, idempotencyKey });
    saveTransferOperation({
      idempotencyKey,
      fingerprint,
      transferId: prior.id,
      status: 'succeeded',
    });

    const spy = vi.spyOn(api, 'createTransfer');
    render(<App />);
    await screen.findByRole('heading', { name: /send money/i });

    // Reconcile restores the success dialog from the safe operation reference.
    expect(
      await screen.findByRole('dialog', { name: /transfer submitted/i }),
    ).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    const listed = await api.listTransfers();
    expect(
      listed.filter((t) => t.idempotencyKey === idempotencyKey),
    ).toHaveLength(1);
  });

  it('reconciles an accepted transfer after refresh even without its transfer id', async () => {
    const payload = {
      recipient: 'amina@example.com', from: 'USD', to: 'NGN',
      sendAmount: 25, receiveAmount: 36642.38, fee: 0.25, rate: 1480.5,
    };
    const fingerprint = await idempotencyKeyFor(fingerprintTransferPayload(payload));
    const idempotencyKey = await idempotencyKeyFor(fingerprint, 'prior-intent');
    await api.createTransfer({ ...payload, idempotencyKey });
    saveTransferOperation({ idempotencyKey, fingerprint, status: 'unknown' });
    const spy = vi.spyOn(api, 'createTransfer');
    render(<App />);
    expect(await screen.findByRole('dialog', { name: /transfer submitted/i }))
      .toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    expect(getLatestRecoverableOperation()?.status).toBe('succeeded');
  });

  it('timeout retry with the same intent reuses the idempotency key', async () => {
    const payload = {
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: 40,
      receiveAmount: 50000,
      fee: 0.4,
      rate: 1480.5,
      idempotencyKey: 'idem_timeout_reuse',
    };
    const first = await api.createTransfer(payload);
    // Simulate a client timeout after the server accepted: replay same key.
    const replay = await api.createTransfer(payload);
    expect(replay.id).toBe(first.id);
    const listed = await api.listTransfers();
    expect(
      listed.filter((t) => t.idempotencyKey === 'idem_timeout_reuse'),
    ).toHaveLength(1);
  });

  it('navigation away and back restores the succeeded intent without a second create', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'createTransfer');
    render(<App />);

    await fillValidForm(user, '30');
    await user.click(screen.getByRole('button', { name: /review & send/i }));
    const dialog = await screen.findByRole('dialog', {
      name: /confirm your transfer/i,
    });
    await user.click(
      within(dialog).getByRole('button', { name: /confirm transfer/i }),
    );
    await screen.findByRole(
      'dialog',
      { name: /transfer submitted/i },
      { timeout: 5000 },
    );

    const callsAfterSubmit = spy.mock.calls.length;
    expect(callsAfterSubmit).toBeGreaterThanOrEqual(1);
    expect(getLatestRecoverableOperation()?.status).toBe('succeeded');

    // Navigate to Transfers then back to Send — reconcile must not re-create.
    await user.click(screen.getByRole('button', { name: /view transfers/i }));
    await screen.findByRole(
      'heading',
      { name: /your transfers/i },
      {
        timeout: 5000,
      },
    );
    const sendLinks = screen.getAllByRole('link', { name: /send money/i });
    await user.click(sendLinks[0]);
    await screen.findByRole('heading', { name: /send money/i });

    await waitFor(() => {
      expect(
        screen.getByRole('dialog', { name: /transfer submitted/i }),
      ).toBeInTheDocument();
    });
    expect(spy).toHaveBeenCalledTimes(callsAfterSubmit);
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
