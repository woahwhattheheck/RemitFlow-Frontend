import {
  act,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App.jsx';
import * as api from '../../src/services/api.js';
import { QUOTE_TTL_MS } from '../../src/services/contracts/quote.js';

async function fillValidForm(user) {
  await user.type(screen.getByLabelText(/recipient/i), 'amina@example.com');
  await user.type(screen.getByLabelText(/amount/i), '15');
  await user.selectOptions(screen.getByLabelText(/^to$/i), 'NGN');
}

describe('Send money quote freshness', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/send');
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-24T19:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows quote source, expiry, and currency metadata', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await fillValidForm(user);

    const card = await screen.findByText(/transfer summary/i);
    const quoteCard = card.closest('.quote-card');
    expect(quoteCard).not.toBeNull();
    expect(within(quoteCard).getByText(/^source$/i)).toBeInTheDocument();
    expect(within(quoteCard).getByText(/fx\.table/i)).toBeInTheDocument();
    expect(within(quoteCard).getByText(/^expires$/i)).toBeInTheDocument();
    expect(within(quoteCard).getByText(/^currencies$/i)).toBeInTheDocument();
    expect(within(quoteCard).getByText(/^quote id$/i)).toBeInTheDocument();
    expect(quoteCard).toHaveAttribute('data-quote-id');
  });

  it('blocks confirm after the quote expires and offers refresh', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const createSpy = vi.spyOn(api, 'createTransfer').mockResolvedValue({
      id: 'tx_fresh',
      recipient: 'amina@example.com',
      from: 'USD',
      to: 'NGN',
      sendAmount: '15.00',
      receiveAmount: '22000.00',
      status: 'pending',
      createdAt: '2026-09-24T19:00:00Z',
      quoteId: 'qt_test',
    });

    render(<App />);
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /review & send/i }));

    const dialog = await screen.findByRole('dialog', {
      name: /confirm your transfer/i,
    });

    await act(async () => {
      vi.advanceTimersByTime(QUOTE_TTL_MS + 50);
    });

    expect(
      within(dialog).getByText(/this quote has expired/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /confirm transfer/i }),
    ).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: /refresh quote/i }));
    expect(
      within(dialog).getByRole('button', { name: /confirm transfer/i }),
    ).not.toBeDisabled();

    await user.click(
      within(dialog).getByRole('button', { name: /confirm transfer/i }),
    );

    await screen.findByRole('dialog', { name: /transfer submitted/i }, { timeout: 5000 });
    expect(createSpy).toHaveBeenCalled();
    expect(createSpy.mock.calls[0][0].quoteId).toMatch(/^qt_/);
  });

  it('binds the quote id into the createTransfer payload', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const createSpy = vi.spyOn(api, 'createTransfer').mockImplementation(async (payload) => ({
      id: 'tx_bound',
      status: 'pending',
      createdAt: '2026-09-24T19:00:00Z',
      ...payload,
    }));

    render(<App />);
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /review & send/i }));
    const dialog = await screen.findByRole('dialog', {
      name: /confirm your transfer/i,
    });
    await user.click(
      within(dialog).getByRole('button', { name: /confirm transfer/i }),
    );

    await screen.findByRole('dialog', { name: /transfer submitted/i }, { timeout: 5000 });
    const payload = createSpy.mock.calls[0][0];
    expect(payload.quoteId).toMatch(/^qt_/);
    expect(payload.sendAmount).toBeDefined();
    expect(payload.from).toBe('USD');
    expect(payload.to).toBe('NGN');
  });
});
