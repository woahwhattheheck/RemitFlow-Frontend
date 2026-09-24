import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../src/App.jsx';

function seedTransfers(count) {
  const transfers = Array.from({ length: count }, (_, i) => ({
    id: `tx_${1000 + i}`,
    recipient: `person${i}@example.com`,
    from: 'USD',
    to: 'NGN',
    sendAmount: 100 + i,
    receiveAmount: (100 + i) * 1400,
    status: i % 2 === 0 ? 'completed' : 'pending',
    createdAt: `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
  }));
  localStorage.setItem('remitflow.transfers', JSON.stringify(transfers));
  return transfers;
}

async function gotoTransfers() {
  window.history.pushState({}, '', '/transfers');
  render(<App />);
  await screen.findByRole('heading', { name: /your transfers/i });
  await screen.findByLabelText(/select all transfers on this page/i);
}

describe('Transfers snapshot pagination', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('pages through a frozen snapshot without gaps', async () => {
    const user = userEvent.setup();
    seedTransfers(12);
    await gotoTransfers();

    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();

    // Newest by createdAt: person11 is June 12.
    expect(
      screen.getByRole('group', { name: /transfer to person11@e/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: /transfer to person6@e/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText(/page 2 of 3/i)).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: /transfer to person6@e/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: /transfer to person11@e/i }),
    ).not.toBeInTheDocument();
  });

  it('resets to page 1 when filters change', async () => {
    const user = userEvent.setup();
    seedTransfers(12);
    await gotoTransfers();

    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText(/page 2 of /i)).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText(/filter by status/i),
      'pending',
    );

    expect(await screen.findByText(/page 1 of /i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
  });
});
