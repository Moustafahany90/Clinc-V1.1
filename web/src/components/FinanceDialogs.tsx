import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Banknote, ReceiptText, Undo2 } from 'lucide-react';
import { api, errorMessage, toApiFailure } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { formatMoney, minorToInput, parseMoneyToMinor } from '../lib/money';
import { todayInZone } from '../lib/format';
import type { Charge, Patient } from '../lib/types';
import { PatientSearch } from './PatientSearch';
import { useToast } from './toast';
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Select,
  Textarea,
} from './ui';

function useResetOnOpen(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset();
    // The reset callback is intentionally read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

function PatientPanel({
  patient,
  onChange,
  disabled,
}: {
  patient: Patient | null;
  onChange: (patient: Patient | null) => void;
  disabled?: boolean;
}) {
  return patient ? (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted/60 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-ink-900">
          {patient.firstName} {patient.lastName}
        </p>
        <p className="truncate text-[11px] text-ink-500">
          {patient.patientNumber}
          {patient.phone ? ` · ${patient.phone}` : ''}
        </p>
      </div>
      {!disabled && (
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
          Change
        </Button>
      )}
    </div>
  ) : (
    <PatientSearch value={patient} onChange={onChange} disabled={disabled} autoFocus />
  );
}

export interface ChargeSeed {
  description?: string;
  amountMinor?: number;
  serviceId?: string | null;
}

export function ChargeDialog({
  open,
  onOpenChange,
  patient: presetPatient = null,
  appointmentId,
  seed,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patient?: Patient | null;
  appointmentId?: string;
  seed?: ChargeSeed;
  onSaved?: () => void;
}) {
  const { services } = useClinic();
  const toast = useToast();
  const [patient, setPatient] = useState<Patient | null>(presetPatient);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useResetOnOpen(open, () => {
    setPatient(presetPatient);
    setDescription(seed?.description ?? '');
    setAmount(seed?.amountMinor ? minorToInput(seed.amountMinor) : '');
    setServiceId(seed?.serviceId ?? '');
    setBusy(false);
    setError(null);
  });

  function chooseService(nextId: string) {
    setServiceId(nextId);
    const service = services.find((item) => item.id === nextId);
    if (service) {
      setDescription(service.name);
      if (service.priceMinor > 0) setAmount(minorToInput(service.priceMinor));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!patient) {
      setError('Select the patient to bill.');
      return;
    }
    if (!description.trim()) {
      setError('Add a short description for the charge.');
      return;
    }
    const amountMinor = parseMoneyToMinor(amount);
    if (!amountMinor || amountMinor < 1) {
      setError('Enter an amount greater than zero (for example 250.00).');
      return;
    }
    setBusy(true);
    try {
      if (appointmentId) {
        await api.post(`/appointments/${appointmentId}/charge`, {
          description: description.trim(),
          amountMinor,
          serviceId: serviceId || null,
        });
      } else {
        await api.post('/payments/charges', {
          patientId: patient.id,
          description: description.trim(),
          amountMinor,
          serviceId: serviceId || null,
        });
      }
      toast.success('Charge recorded', `${formatMoney(amountMinor)} · ${description.trim()}`);
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="md">
        <DialogHeader
          title="Record a charge"
          description="A charge is what the patient owes. It is separate from money received."
          icon={ReceiptText}
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger" title="Could not record charge">{error}</Alert>}

            <div>
              <p className="mb-1.5 text-[12px] font-medium text-ink-700">Patient</p>
              <PatientPanel patient={patient} onChange={setPatient} disabled={Boolean(presetPatient)} />
            </div>

            <Field label="Service" htmlFor="charge-service" hint="Optional. Fills the description and price.">
              <Select
                id="charge-service"
                value={serviceId}
                onChange={(event) => chooseService(event.target.value)}
              >
                <option value="">Custom charge</option>
                {services
                  .filter((service) => service.isActive)
                  .map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name} · {formatMoney(service.priceMinor)}
                    </option>
                  ))}
              </Select>
            </Field>

            <Field label="Description" htmlFor="charge-description" required>
              <Input
                id="charge-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="e.g. Abdominal ultrasound"
                maxLength={200}
                required
              />
            </Field>

            <Field label="Amount (EGP)" htmlFor="charge-amount" required hint="Two decimal places.">
              <Input
                id="charge-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                required
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Record charge
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface OpenCharge extends Charge {
  balanceMinor: number;
}

export function PaymentDialog({
  open,
  onOpenChange,
  patient: presetPatient = null,
  seedAmountMinor,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patient?: Patient | null;
  seedAmountMinor?: number;
  onSaved?: () => void;
}) {
  const { paymentMethods } = useClinic();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const [patient, setPatient] = useState<Patient | null>(presetPatient);
  const [amount, setAmount] = useState('');
  const [methodKey, setMethodKey] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [charges, setCharges] = useState<OpenCharge[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [loadingCharges, setLoadingCharges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeMethods = useMemo(
    () => paymentMethods.filter((method) => method.isActive),
    [paymentMethods],
  );
  const selectedMethod = activeMethods.find((method) => method.key === methodKey);
  const amountMinor = parseMoneyToMinor(amount) ?? 0;
  const allocatedMinor = Object.values(allocations).reduce(
    (sum, value) => sum + (parseMoneyToMinor(value) ?? 0),
    0,
  );
  const unallocatedMinor = Math.max(0, amountMinor - allocatedMinor);

  useResetOnOpen(open, () => {
    setPatient(presetPatient);
    setAmount(seedAmountMinor ? minorToInput(seedAmountMinor) : '');
    setMethodKey(activeMethods[0]?.key ?? '');
    setReference('');
    setNotes('');
    setCharges([]);
    setAllocations({});
    setBusy(false);
    setError(null);
  });

  useEffect(() => {
    if (!open || !patient) {
      setCharges([]);
      setAllocations({});
      return;
    }
    if (!hasPermission('PAYMENTS_READ')) return;
    let active = true;
    setLoadingCharges(true);
    api
      .get<{ charges: OpenCharge[] }>('/payments/charges/list', {
        params: { patientId: patient.id, status: 'OPEN', pageSize: 100 },
      })
      .then((res) => {
        if (active) setCharges(res.data.charges);
      })
      .catch(() => {
        if (active) setCharges([]);
      })
      .finally(() => {
        if (active) setLoadingCharges(false);
      });
    return () => {
      active = false;
    };
  }, [open, patient, hasPermission]);

  function applyRemainder() {
    let remaining = amountMinor;
    const next: Record<string, string> = {};
    for (const charge of charges) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, charge.balanceMinor);
      if (take > 0) {
        next[charge.id] = minorToInput(take);
        remaining -= take;
      }
    }
    setAllocations(next);
  }

  function toggleCharge(charge: OpenCharge, checked: boolean) {
    setAllocations((prev) => {
      const next = { ...prev };
      if (checked) {
        const remaining = Math.max(0, amountMinor - allocatedMinor);
        const take = Math.min(charge.balanceMinor, remaining || charge.balanceMinor);
        next[charge.id] = minorToInput(take);
      } else {
        delete next[charge.id];
      }
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!patient) {
      setError('Select the patient making the payment.');
      return;
    }
    if (!amountMinor || amountMinor < 1) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (!methodKey) {
      setError('Select a payment method.');
      return;
    }
    if (selectedMethod?.requiresReference && !reference.trim()) {
      setError(`${selectedMethod.label} payments require a reference number.`);
      return;
    }
    setBusy(true);
    try {
      await api.post('/payments', {
        patientId: patient.id,
        amountMinor,
        methodKey,
        reference: reference.trim(),
        notes: notes.trim(),
        allocations: [],
      });
      toast.success('Payment recorded', formatMoney(amountMinor));
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      setError(toApiFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="lg">
        <DialogHeader
          title="Record a payment"
          description="Payments are money actually received. Unallocated money is kept as a patient deposit."
          icon={Banknote}
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger" title="Could not record payment">{error}</Alert>}

            <div>
              <p className="mb-1.5 text-[12px] font-medium text-ink-700">Patient</p>
              <PatientPanel patient={patient} onChange={setPatient} disabled={Boolean(presetPatient)} />
            </div>

            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Amount received (EGP)" htmlFor="payment-amount" required>
                <Input
                  id="payment-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                  required
                />
              </Field>
              <Field
                label="Method"
                htmlFor="payment-method"
                required
                hint={selectedMethod?.requiresReference ? 'This method requires a reference.' : undefined}
              >
                <Select
                  id="payment-method"
                  value={methodKey}
                  onChange={(event) => setMethodKey(event.target.value)}
                  required
                >
                  <option value="">Select a method</option>
                  {activeMethods.map((method) => (
                    <option key={method.key} value={method.key}>
                      {method.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Reference"
                htmlFor="payment-reference"
                required={selectedMethod?.requiresReference}
              >
                <Input
                  id="payment-reference"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="e.g. transfer reference"
                  maxLength={120}
                />
              </Field>
              <Field label="Received on" htmlFor="payment-date" hint="Defaults to today.">
                <Input id="payment-date" type="date" value={todayInZone()} disabled readOnly />
              </Field>
              <Field label="Notes" htmlFor="payment-notes" className="sm:col-span-2">
                <Textarea
                  id="payment-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                  maxLength={1000}
                />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RefundDialog({
  open,
  onOpenChange,
  payment,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: { id: string; amountMinor: number; refundedMinor?: number } | null;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refundable = payment ? payment.amountMinor - (payment.refundedMinor ?? 0) : 0;

  useResetOnOpen(open, () => {
    setAmount(minorToInput(refundable));
    setReason('');
    setBusy(false);
    setError(null);
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!payment) return;
    const amountMinor = parseMoneyToMinor(amount);
    if (!amountMinor || amountMinor < 1) {
      setError('Enter a refund amount greater than zero.');
      return;
    }
    if (amountMinor > refundable) {
      setError(`At most ${formatMoney(refundable)} remains refundable.`);
      return;
    }
    if (reason.trim().length < 3) {
      setError('Give a reason for the refund.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/payments/${payment.id}/refund`, {
        amountMinor,
        reason: reason.trim(),
      });
      toast.success('Refund recorded', formatMoney(amountMinor));
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm">
        <DialogHeader
          title="Record a refund"
          description="The original payment is never rewritten. A separate refund record is added."
          icon={Undo2}
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger" title="Could not record refund">{error}</Alert>}
            <div className="rounded-xl border border-line bg-surface-muted/60 px-3 py-2.5 text-[12px]">
              <p className="text-ink-500">
                Original payment <span className="tabular font-semibold text-ink-800">{formatMoney(payment?.amountMinor ?? 0)}</span>
              </p>
              <p className="mt-0.5 text-ink-500">
                Refundable now <span className="tabular font-semibold text-ink-800">{formatMoney(refundable)}</span>
              </p>
            </div>
            <Field label="Refund amount (EGP)" htmlFor="refund-amount" required>
              <Input
                id="refund-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
            </Field>
            <Field label="Reason" htmlFor="refund-reason" required hint="Stored in the audit trail.">
              <Textarea
                id="refund-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                maxLength={500}
                required
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={busy}>
              Record refund
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
