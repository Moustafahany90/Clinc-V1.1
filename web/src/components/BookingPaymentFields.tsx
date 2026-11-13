import { CreditCard } from 'lucide-react';
import { formatMoney, parseMoneyToMinor } from '../lib/money';
import type { PaymentMethod } from '../lib/types';
import { Field, Input, Select } from './ui';

export type BookingPaymentStatus = 'PENDING' | 'DEPOSIT' | 'PAID';

export interface BookingPaymentValue {
  status: BookingPaymentStatus;
  amount: string;
  methodKey: string;
  reference: string;
}

export const emptyBookingPayment: BookingPaymentValue = {
  status: 'PENDING',
  amount: '',
  methodKey: '',
  reference: '',
};

export function activePaymentMethods(paymentMethods: PaymentMethod[]): PaymentMethod[] {
  return paymentMethods.filter((method) => method.isActive);
}

/** Returns a user-facing validation message, or null when the input is valid. */
export function validateBookingPayment(
  value: BookingPaymentValue,
  priceMinor: number,
  paymentMethods: PaymentMethod[],
): string | null {
  if (priceMinor <= 0 || value.status === 'PENDING') return null;

  const method = paymentMethods.find((item) => item.key === value.methodKey && item.isActive);
  if (!value.methodKey) return 'Select a payment method.';
  if (!method) return 'Select an active payment method.';
  if (method.requiresReference && !value.reference.trim()) {
    return `${method.label} payments require a reference number.`;
  }

  if (value.status === 'DEPOSIT') {
    const amount = parseMoneyToMinor(value.amount);
    if (amount == null || amount <= 0) return 'Enter a deposit greater than zero.';
    if (amount > priceMinor) return 'The deposit cannot exceed the outstanding balance.';
  }

  return null;
}

/** Builds the optional API payload for booking-time payment capture. */
export function bookingPaymentPayload(
  value: BookingPaymentValue,
  priceMinor: number,
): Record<string, unknown> | undefined {
  if (priceMinor <= 0) return undefined;

  if (value.status === 'PENDING') return { status: 'PENDING' };

  const reference = value.reference.trim();
  if (value.status === 'PAID') {
    return {
      status: 'PAID',
      methodKey: value.methodKey,
      ...(reference ? { reference } : {}),
    };
  }

  return {
    status: 'DEPOSIT',
    amountMinor: parseMoneyToMinor(value.amount) ?? 0,
    methodKey: value.methodKey,
    ...(reference ? { reference } : {}),
  };
}

export function BookingPaymentFields({
  priceMinor,
  currency,
  value,
  onChange,
  paymentMethods,
  disabled = false,
  idPrefix,
}: {
  priceMinor: number;
  currency: string;
  value: BookingPaymentValue;
  onChange: (next: BookingPaymentValue) => void;
  paymentMethods: PaymentMethod[];
  disabled?: boolean;
  idPrefix: string;
}) {
  if (priceMinor <= 0) {
    return (
      <section className="rounded-xl border border-line bg-surface-muted/40 px-3.5 py-3">
        <p className="text-[12px] font-medium text-ink-700">Service price</p>
        <p className="mt-1 text-[11px] text-ink-500">
          This service has no configured price, so no automatic charge will be created.
        </p>
      </section>
    );
  }

  const methods = activePaymentMethods(paymentMethods);
  const selectedMethod = methods.find((method) => method.key === value.methodKey);
  const depositMinor = parseMoneyToMinor(value.amount) ?? 0;

  function setStatus(status: BookingPaymentStatus) {
    onChange({
      ...value,
      status,
      amount: status === 'DEPOSIT' ? value.amount : '',
      methodKey: status === 'PENDING' ? '' : value.methodKey || methods[0]?.key || '',
      reference: status === 'PENDING' ? '' : value.reference,
    });
  }

  const statuses: Array<{ value: BookingPaymentStatus; label: string }> = [
    { value: 'PENDING', label: 'Pending' },
    { value: 'DEPOSIT', label: 'Deposit' },
    { value: 'PAID', label: 'Fully paid' },
  ];

  return (
    <section className="rounded-xl border border-line bg-surface-muted/40 px-3.5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-800">
          <CreditCard className="h-3.5 w-3.5 text-ink-400" aria-hidden />
          Payment
        </p>
        <p className="text-[12px] font-semibold text-ink-900">
          Service price: {formatMoney(priceMinor, currency)}
        </p>
      </div>
      <p className="mt-0.5 text-[11px] text-ink-500">
        The configured price is recorded automatically. Pending keeps the full balance outstanding.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-3" role="group" aria-label="Payment status">
        {statuses.map((option) => {
          const selected = value.status === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => setStatus(option.value)}
              className={
                selected
                  ? 'rounded-lg border border-brand-500 bg-brand-50 px-3 py-2 text-[12px] font-semibold text-brand-700'
                  : 'rounded-lg border border-line bg-white px-3 py-2 text-[12px] font-medium text-ink-600 transition-colors hover:border-brand-300 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-60'
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {value.status !== 'PENDING' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {value.status === 'DEPOSIT' ? (
            <Field
              label="Deposit received"
              htmlFor={`${idPrefix}-deposit`}
              required
              hint={`Must be greater than zero and no more than ${formatMoney(priceMinor, currency)}.`}
            >
              <Input
                id={`${idPrefix}-deposit`}
                inputMode="decimal"
                placeholder="0.00"
                value={value.amount}
                onChange={(event) => onChange({ ...value, amount: event.target.value })}
                disabled={disabled}
              />
            </Field>
          ) : (
            <div className="rounded-lg border border-line bg-white px-3 py-2">
              <p className="text-[11px] text-ink-500">Amount collected now</p>
              <p className="text-[13px] font-semibold text-ink-900">
                {formatMoney(priceMinor, currency)}
              </p>
            </div>
          )}

          <Field label="Payment method" htmlFor={`${idPrefix}-method`} required>
            <Select
              id={`${idPrefix}-method`}
              value={value.methodKey}
              onChange={(event) => onChange({ ...value, methodKey: event.target.value })}
              disabled={disabled}
            >
              <option value="">Select a method…</option>
              {methods.map((method) => (
                <option key={method.key} value={method.key}>
                  {method.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Reference"
            htmlFor={`${idPrefix}-reference`}
            className="sm:col-span-2"
            hint={
              selectedMethod?.requiresReference
                ? `${selectedMethod.label} payments require a reference number.`
                : 'Optional. Card or transfer references help reconciliation.'
            }
          >
            <Input
              id={`${idPrefix}-reference`}
              value={value.reference}
              onChange={(event) => onChange({ ...value, reference: event.target.value })}
              maxLength={120}
              disabled={disabled}
            />
          </Field>
        </div>
      )}

      {value.status === 'DEPOSIT' && depositMinor > 0 && depositMinor <= priceMinor && (
        <p className="mt-2 text-[11px] text-ink-500">
          Outstanding after this deposit: {formatMoney(priceMinor - depositMinor, currency)}
        </p>
      )}
    </section>
  );
}
