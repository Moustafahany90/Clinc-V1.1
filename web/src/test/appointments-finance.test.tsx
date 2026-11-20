import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import {
  validateBookingPayment,
  bookingPaymentPayload,
  emptyBookingPayment,
  type BookingPaymentValue,
} from '../components/BookingPaymentFields';
import { AppointmentActions } from '../components/AppointmentActions';
import { FinancePage } from '../routes/FinancePage';
import { appointment, paymentMethods, user } from './fixtures';
import { apiHelpers, apiMock, resetMocks, setUser } from './mocks';

vi.mock('../lib/api', async () => {
  const mocks = await import('./mocks');
  return { api: mocks.apiMock, ...mocks.apiHelpers };
});

vi.mock('../lib/auth', async () => {
  const mocks = await import('./mocks');
  return { useAuth: mocks.useAuthValue, can: mocks.can };
});

vi.mock('../lib/clinic', async () => {
  const mocks = await import('./mocks');
  return { useClinic: mocks.useClinicValue };
});

vi.mock('../components/toast', async () => {
  const mocks = await import('./mocks');
  return { useToast: () => mocks.toastMock };
});

const dailyFigures = {
  date: '2026-11-17',
  currency: 'USD',
  charges: { count: 2, totalMinor: 40000 },
  payments: { count: 2, totalMinor: 30000 },
  refunds: { count: 0, totalMinor: 0 },
  expenses: { count: 1, totalMinor: 5000, byCategory: [] },
  byMethod: [],
  totals: { collectedMinor: 30000, netCashMinor: 25000, billedMinor: 40000 },
  position: { collectedMinor: 30000, outstandingMinor: 10000, refundsMinor: 0, expensesMinor: 5000 },
};

const exportPreview = {
  from: '2026-11-01',
  to: '2026-11-17',
  currency: 'USD',
  counts: { charges: 2, payments: 2, refunds: 0, expenses: 1 },
  totals: {
    chargesMinor: 40000,
    paymentsMinor: 30000,
    refundsMinor: 0,
    expensesMinor: 5000,
    collectedMinor: 30000,
    netCashMinor: 25000,
  },
  columns: ['date', 'type', 'amount'],
};

beforeEach(() => {
  resetMocks();
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/financial-reports/daily') return Promise.resolve({ data: dailyFigures });
    if (url === '/financial-reports/accounting-export/preview') {
      return Promise.resolve({ data: exportPreview });
    }
    return Promise.resolve({ data: {} });
  });
});

describe('booking-time payment validation', () => {
  const price = 20000;

  it('allows an unpaid booking without payment details', () => {
    expect(validateBookingPayment(emptyBookingPayment, price, paymentMethods)).toBeNull();
    expect(bookingPaymentPayload(emptyBookingPayment, price)).toEqual({ status: 'PENDING' });
  });

  it('requires an active method and a reference when the method needs one', () => {
    expect(validateBookingPayment({ ...emptyBookingPayment, status: 'PAID' }, price, paymentMethods)).toBe(
      'Select a payment method.',
    );
    expect(
      validateBookingPayment(
        { ...emptyBookingPayment, status: 'PAID', methodKey: 'OLD' },
        price,
        paymentMethods,
      ),
    ).toBe('Select an active payment method.');
    expect(
      validateBookingPayment(
        { ...emptyBookingPayment, status: 'PAID', methodKey: 'BANK' },
        price,
        paymentMethods,
      ),
    ).toBe('Bank transfer payments require a reference number.');
  });

  it('requires a positive deposit that does not exceed the price', () => {
    const base: BookingPaymentValue = { ...emptyBookingPayment, status: 'DEPOSIT', methodKey: 'CASH' };
    expect(validateBookingPayment(base, price, paymentMethods)).toBe('Enter a deposit greater than zero.');
    expect(validateBookingPayment({ ...base, amount: '300' }, price, paymentMethods)).toBe(
      'The deposit cannot exceed the outstanding balance.',
    );
    expect(validateBookingPayment({ ...base, amount: '50' }, price, paymentMethods)).toBeNull();
    expect(bookingPaymentPayload({ ...base, amount: '50' }, price)).toEqual({
      status: 'DEPOSIT',
      amountMinor: 5000,
      methodKey: 'CASH',
    });
  });
});

describe('appointment status transitions', () => {
  it('offers booking transitions and posts the chosen status', async () => {
    const interaction = userEvent.setup();
    setUser(user('ADMIN'));
    apiMock.post.mockResolvedValue({ data: { appointment: appointment('a-1', { status: 'CONFIRMED' }) } });
    render(
      <MemoryRouter>
        <AppointmentActions appointment={appointment('a-1', { status: 'BOOKED' })} />
      </MemoryRouter>,
    );

    await interaction.click(screen.getByRole('button', { name: 'Appointment actions' }));
    const confirm = await screen.findByRole('menuitem', { name: /Confirm booking/ });
    await interaction.click(confirm);
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/appointments/a-1/status', { status: 'CONFIRMED' }),
    );
  });

  it('hides status changes for a terminal appointment', async () => {
    const interaction = userEvent.setup();
    setUser(user('ADMIN'));
    render(
      <MemoryRouter>
        <AppointmentActions appointment={appointment('a-2', { status: 'DONE' })} />
      </MemoryRouter>,
    );
    await interaction.click(screen.getByRole('button', { name: 'Appointment actions' }));
    expect(await screen.findByRole('menuitem', { name: /No further changes/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Cancel appointment/ })).toBeNull();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('hides transition controls from a read-only receptionist view of clinical completion', async () => {
    const interaction = userEvent.setup();
    setUser(user('RECEPTIONIST'));
    render(
      <MemoryRouter>
        <AppointmentActions appointment={appointment('a-3', { status: 'REPORT_REVIEW' })} />
      </MemoryRouter>,
    );
    await interaction.click(screen.getByRole('button', { name: 'Appointment actions' }));
    // Receptionists can still cancel/reschedule, but cannot complete a clinical visit.
    expect(screen.getByRole('menuitem', { name: /Cancel appointment/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /^Mark complete/ })).toBeNull();
  });
});

describe('financial reports permissions and export', () => {
  it('lets an authorised user preview and download the CSV', async () => {
    const interaction = userEvent.setup();
    setUser(user('ADMIN'));
    render(<FinancePage />);

    await interaction.click(await screen.findByRole('tab', { name: 'Accounting export' }));
    const download = await screen.findByRole('button', { name: /Download CSV/ });
    expect(apiMock.get).toHaveBeenCalledWith(
      '/financial-reports/accounting-export/preview',
      expect.objectContaining({ params: expect.anything() }),
    );
    await interaction.click(download);
    expect(apiHelpers.downloadCsv).toHaveBeenCalledTimes(1);
  });

  it('hides export and bill-print controls from a receptionist', async () => {
    setUser(user('RECEPTIONIST'));
    render(<FinancePage />);
    expect(await screen.findByRole('tab', { name: 'Daily close' })).toBeTruthy();
    // The printable bill route itself is gated in App.tsx; this page only hides
    // the accounting export controls for users without FINANCE_EXPORT.
    expect(screen.queryByRole('tab', { name: 'Accounting export' })).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalledWith(
      '/financial-reports/accounting-export/preview',
      expect.anything(),
    );
  });
});
