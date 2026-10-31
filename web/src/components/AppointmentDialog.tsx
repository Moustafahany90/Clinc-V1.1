import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CalendarPlus,
  CalendarSync,
  Clock,
  Plus,
  UserPlus,
} from 'lucide-react';
import { api, errorMessage, toApiFailure } from '../lib/api';
import { useAsyncData } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import {
  dateOnlyInZone,
  formatTime,
  labelToMinutes,
  minutesToLabel,
  todayInZone,
} from '../lib/format';
import { splitName } from '../lib/utils';
import type { Agenda, Appointment, Patient, Slot } from '../lib/types';
import { PatientSearch } from './PatientSearch';
import { useToast } from './toast';
import {
  Alert,
  Badge,
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

interface DuplicateMatch {
  id: string;
  patientNumber: string;
  firstName: string;
  lastName: string;
  phone: string | null;
}

interface AppointmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment?: Appointment | null;
  initialDate?: string;
  initialDoctorId?: string;
  initialPatient?: Patient | null;
  onSaved?: (appointment: Appointment) => void;
}

/**
 * Create or reschedule an appointment.
 *
 * Deliberately contains the inline patient quick-create flow: the name is split
 * into editable halves, duplicates are a soft warning, and nothing is created
 * until the user presses the explicit button.
 */
export function AppointmentDialog({
  open,
  onOpenChange,
  appointment = null,
  initialDate,
  initialDoctorId,
  initialPatient = null,
  onSaved,
}: AppointmentDialogProps) {
  const { user, hasPermission } = useAuth();
  const { doctors, services, clinic } = useClinic();
  const toast = useToast();
  const editing = Boolean(appointment);

  const [patient, setPatient] = useState<Patient | null>(null);
  const [doctorId, setDoctorId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(todayInZone());
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(15);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [requiresOverride, setRequiresOverride] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [quickOpen, setQuickOpen] = useState(false);
  const [quick, setQuick] = useState({ fullName: '', firstName: '', lastName: '', phone: '' });
  const [quickDuplicates, setQuickDuplicates] = useState<DuplicateMatch[]>([]);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);

  const canWritePatients = hasPermission('PATIENTS_WRITE');
  const canOverrideSchedule = hasPermission('APPOINTMENTS_OVERRIDE');

  useEffect(() => {
    if (!open) return;
    const defaults = {
      doctorId:
        appointment?.doctorId ??
        initialDoctorId ??
        (user?.role === 'DOCTOR' ? user.id : doctors[0]?.id) ??
        '',
      patient: appointment ? (appointment.patient as Patient | undefined) ?? null : initialPatient,
      date: appointment
        ? dateOnlyInZone(appointment.startAt)
        : initialDate ?? todayInZone(),
      time: appointment ? formatTime(appointment.startAt) : '',
      duration:
        appointment?.durationMinutes ??
        clinic?.defaultAppointmentMinutes ??
        15,
      serviceId: appointment?.serviceId ?? '',
      reason: appointment?.reason ?? '',
      notes: appointment?.notes ?? '',
    };
    setPatient(defaults.patient);
    setDoctorId(defaults.doctorId);
    setServiceId(defaults.serviceId);
    setDate(defaults.date);
    setTime(defaults.time);
    setDuration(defaults.duration);
    setReason(defaults.reason);
    setNotes(defaults.notes);
    setOverrideReason('');
    setRescheduleReason('');
    setRequiresOverride(false);
    setConflict(null);
    setError(null);
    setBusy(false);
    setQuickOpen(false);
    setQuick({ fullName: '', firstName: '', lastName: '', phone: '' });
    setQuickDuplicates([]);
    setQuickError(null);
    // Doctors / services are only needed to seed the first doctor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appointment?.id, initialDate, initialDoctorId]);

  const agendaState = useAsyncData<Agenda>(
    async () => {
      const res = await api.get<Agenda>('/appointments/agenda', {
        params: {
          date,
          ...(doctorId ? { doctorId } : {}),
          ...(serviceId ? { serviceId } : {}),
        },
      });
      return res.data;
    },
    [date, doctorId, serviceId],
    open && Boolean(date && doctorId),
  );

  const slots: Slot[] = agendaState.data?.slots ?? [];
  const window = agendaState.data?.openingHours ?? null;

  // Offer the first usable time if the user has not chosen one yet.
  useEffect(() => {
    if (!open || time) return;
    if (slots.length > 0) {
      const first = slots.find((slot) => slot.available) ?? slots[0];
      setTime(minutesToLabel(first.minute));
    } else if (window?.isOpen) {
      setTime(minutesToLabel(window.openMinute));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agendaState.data]);

  function choosePatient(next: Patient | null) {
    setPatient(next);
    setError(null);
    setConflict(null);
    if (next) setQuickOpen(false);
  }

  function chooseService(nextId: string) {
    setServiceId(nextId);
    const service = services.find((item) => item.id === nextId);
    if (service) setDuration(service.durationMinutes);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setConflict(null);

    if (!patient) {
      setError('Select an existing patient or create a new one first.');
      return;
    }
    if (!doctorId) {
      setError('Select the doctor who will see this patient.');
      return;
    }
    const startMinute = labelToMinutes(time);
    if (startMinute == null) {
      setError('Enter a valid start time.');
      return;
    }
    if (!duration || duration < 5) {
      setError('Appointments must last at least 5 minutes.');
      return;
    }

    const payload = {
      doctorId,
      serviceId: serviceId || null,
      date,
      startMinute,
      durationMinutes: duration,
      reason: reason.trim(),
      notes: notes.trim(),
      ...(canOverrideSchedule && overrideReason.trim()
        ? { overrideReason: overrideReason.trim() }
        : {}),
      ...(editing && rescheduleReason.trim() ? { rescheduleReason: rescheduleReason.trim() } : {}),
    };

    setBusy(true);
    try {
      const res = editing
        ? await api.patch<{ appointment: Appointment }>(`/appointments/${appointment!.id}`, payload)
        : await api.post<{ appointment: Appointment }>('/appointments', {
            ...payload,
            patientId: patient.id,
          });

      toast.success(
        editing ? 'Appointment rescheduled' : 'Appointment booked',
        `${patient.firstName} ${patient.lastName} · ${date} at ${time}`,
      );
      onSaved?.(res.data.appointment);
      onOpenChange(false);
    } catch (err) {
      const failure = toApiFailure(err);
      const details = failure.details as
        | { requiresOverride?: boolean; reason?: string; conflictWith?: string; startAt?: string }
        | undefined;

      if (failure.status === 409) {
        setConflict(
          'This doctor already has an appointment during that time. Choose one of the free slots below or a different time.',
        );
      } else if (failure.status === 400 && details?.requiresOverride) {
        setRequiresOverride(true);
        setError(`${details.reason ?? failure.message} Add an override reason to continue.`);
      } else {
        setError(failure.message);
      }
    } finally {
      setBusy(false);
    }
  }

  function updateQuickName(value: string) {
    const parts = splitName(value);
    setQuick((prev) => ({ ...prev, fullName: value, ...parts }));
  }

  function updateQuickHalf(key: 'firstName' | 'lastName', value: string) {
    setQuick((prev) => {
      const next = { ...prev, [key]: value };
      next.fullName = `${next.firstName} ${next.lastName}`.trim();
      return next;
    });
  }

  async function createQuickPatient(acknowledgeDuplicates = false) {
    setQuickError(null);
    if (!quick.firstName.trim() || !quick.lastName.trim()) {
      setQuickError('Enter the patient’s first and last name.');
      return;
    }
    setQuickBusy(true);
    try {
      const res = await api.post<{ patient: Patient }>('/patients', {
        firstName: quick.firstName.trim(),
        lastName: quick.lastName.trim(),
        phone: quick.phone.trim(),
        ...(acknowledgeDuplicates ? { acknowledgeDuplicates: true } : {}),
      });
      const created = res.data.patient;
      choosePatient(created);
      setQuickOpen(false);
      toast.success('Patient created and selected', `${created.patientNumber} · ${created.firstName} ${created.lastName}`);
    } catch (err) {
      const failure = toApiFailure(err);
      const matches = (failure.details as { matches?: DuplicateMatch[] } | undefined)?.matches;
      if (failure.status === 409 && matches?.length) {
        setQuickDuplicates(matches);
      } else {
        setQuickError(failure.message);
      }
    } finally {
      setQuickBusy(false);
    }
  }

  const doctorOptions =
    user?.role === 'DOCTOR'
      ? doctors.filter((doctor) => doctor.id === user.id)
      : doctors;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="xl">
        <DialogHeader
          title={editing ? 'Reschedule appointment' : 'New appointment'}
          description={
            editing
              ? 'Moving an appointment keeps its history and notifies nobody automatically.'
              : 'Booking does not create a charge. Bill the visit separately once the patient is seen.'
          }
          icon={editing ? CalendarSync : CalendarPlus}
        />

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-5">
            {error && (
              <Alert tone={conflict ? 'warning' : 'danger'} title={conflict ? 'Time no longer available' : 'Could not save appointment'}>
                {conflict ?? error}
              </Alert>
            )}

            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  Patient
                </h3>
                {!patient && canWritePatients && !quickOpen && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setQuickOpen(true)}>
                    <UserPlus className="h-3.5 w-3.5" aria-hidden />
                    New patient
                  </Button>
                )}
              </div>

              {patient ? (
                <PatientSearch value={patient} onChange={choosePatient} disabled={busy} />
              ) : quickOpen ? null : (
                <PatientSearch value={patient} onChange={choosePatient} disabled={busy} autoFocus />
              )}

              {quickOpen && (
                <div
                  className="mt-2 rounded-xl border border-brand-200 bg-brand-50/50 p-3.5"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
                      event.preventDefault();
                    }
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[13px] font-semibold text-ink-900">Quick-create a patient</p>
                      <p className="mt-0.5 text-[11px] text-ink-500">
                        The name is split into two editable fields. Check the spelling before creating.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setQuickOpen(false);
                        setQuickDuplicates([]);
                        setQuickError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>

                  {quickError && (
                    <Alert tone="danger" className="mt-2.5">
                      {quickError}
                    </Alert>
                  )}

                  {quickDuplicates.length > 0 && (
                    <Alert
                      tone="warning"
                      title="A similar patient already exists"
                      className="mt-2.5"
                    >
                      <ul className="mt-1 space-y-1.5">
                        {quickDuplicates.map((match) => (
                          <li key={match.id} className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[12px]">
                              {match.firstName} {match.lastName}{' '}
                              <span className="text-ink-500">
                                · {match.patientNumber}
                                {match.phone ? ` · ${match.phone}` : ''}
                              </span>
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                choosePatient(match as unknown as Patient);
                                setQuickDuplicates([]);
                                setQuickOpen(false);
                              }}
                            >
                              Use this patient
                            </Button>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-[11px]">
                        Records are never merged. Create a separate record only if this is a different person.
                      </p>
                    </Alert>
                  )}

                  <div className="mt-3 space-y-3">
                    <Field label="Full name" htmlFor="quick-full-name" required>
                      <Input
                        id="quick-full-name"
                        value={quick.fullName}
                        onChange={(event) => updateQuickName(event.target.value)}
                        placeholder="e.g. Mariam Hassan"
                        autoFocus
                      />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="First name" htmlFor="quick-first" required>
                        <Input
                          id="quick-first"
                          value={quick.firstName}
                          onChange={(event) => updateQuickHalf('firstName', event.target.value)}
                        />
                      </Field>
                      <Field label="Last name" htmlFor="quick-last" required>
                        <Input
                          id="quick-last"
                          value={quick.lastName}
                          onChange={(event) => updateQuickHalf('lastName', event.target.value)}
                        />
                      </Field>
                    </div>
                    <Field label="Phone" htmlFor="quick-phone" hint="Optional.">
                      <Input
                        id="quick-phone"
                        type="tel"
                        value={quick.phone}
                        onChange={(event) => setQuick((prev) => ({ ...prev, phone: event.target.value }))}
                      />
                    </Field>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        loading={quickBusy}
                        onClick={() => void createQuickPatient(quickDuplicates.length > 0)}
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden />
                        {quickDuplicates.length > 0 ? 'Create separate record' : 'Create and select'}
                      </Button>
                      <p className="text-[11px] text-ink-500">
                        Nothing is created until you press this button.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Doctor" htmlFor="appt-doctor" required>
                <Select
                  id="appt-doctor"
                  value={doctorId}
                  onChange={(event) => setDoctorId(event.target.value)}
                  disabled={user?.role === 'DOCTOR' || editing || busy}
                >
                  <option value="">Select a doctor</option>
                  {doctorOptions.map((doctor) => (
                    <option key={doctor.id} value={doctor.id}>
                      Dr {doctor.firstName} {doctor.lastName}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Service" htmlFor="appt-service" hint="Sets the default duration.">
                <Select
                  id="appt-service"
                  value={serviceId}
                  onChange={(event) => chooseService(event.target.value)}
                  disabled={busy}
                >
                  <option value="">General examination</option>
                  {services
                    .filter((service) => service.isActive)
                    .map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name} · {service.durationMinutes} min
                      </option>
                    ))}
                </Select>
              </Field>

              <Field label="Date" htmlFor="appt-date" required>
                <Input
                  id="appt-date"
                  type="date"
                  value={date}
                  min={editing ? undefined : todayInZone()}
                  onChange={(event) => {
                    setDate(event.target.value);
                    setTime('');
                  }}
                  disabled={busy}
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Start time" htmlFor="appt-time" required>
                  <Input
                    id="appt-time"
                    type="time"
                    step={300}
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    invalid={requiresOverride && canOverrideSchedule && !overrideReason.trim()}
                    disabled={busy}
                  />
                </Field>
                <Field label="Minutes" htmlFor="appt-duration" required>
                  <Input
                    id="appt-duration"
                    type="number"
                    min={5}
                    max={240}
                    step={5}
                    value={duration}
                    onChange={(event) => setDuration(Number(event.target.value) || 5)}
                    disabled={busy}
                  />
                </Field>
              </div>

              <Field label="Reason for visit" htmlFor="appt-reason" className="sm:col-span-2">
                <Input
                  id="appt-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. Follow-up abdominal scan"
                  maxLength={500}
                  disabled={busy}
                />
              </Field>

              <Field label="Reception notes" htmlFor="appt-notes" className="sm:col-span-2">
                <Textarea
                  id="appt-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                  maxLength={2000}
                  disabled={busy}
                />
              </Field>
            </section>

            <section className="rounded-xl border border-line bg-surface-muted/50 px-3.5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink-700">
                  <Clock className="h-3.5 w-3.5 text-ink-400" aria-hidden />
                  {window
                    ? window.isOpen
                      ? `Open ${minutesToLabel(window.openMinute)}–${minutesToLabel(window.closeMinute)}`
                      : 'Closed on this date'
                    : doctorId
                      ? 'Checking the schedule…'
                      : 'Choose a doctor to see availability'}
                  {window?.breakStartMinute != null && window?.breakEndMinute != null && (
                    <span className="text-ink-400">
                      · break {minutesToLabel(window.breakStartMinute)}–{minutesToLabel(window.breakEndMinute)}
                    </span>
                  )}
                </p>
                {window && !window.isOpen && (
                  <Badge tone="warning">{window.reason ?? 'Outside working hours'}</Badge>
                )}
              </div>
              {window && !window.isOpen && !canOverrideSchedule && (
                <p className="mt-2 text-[11px] text-ink-500">
                  Only an administrator can approve a booking outside the configured schedule.
                </p>
              )}

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {slots.length === 0 && window?.isOpen && (
                  <p className="text-[11px] text-ink-500">
                    No free slots for this duration. Choose another time or record an override reason.
                  </p>
                )}
                {slots.map((slot) => {
                  const label = minutesToLabel(slot.minute);
                  const selected = time === label;
                  return (
                    <button
                      key={slot.start}
                      type="button"
                      disabled={!slot.available || busy}
                      onClick={() => {
                        setTime(label);
                        setRequiresOverride(false);
                        setConflict(null);
                      }}
                      className={
                        selected
                          ? 'rounded-md bg-brand-600 px-2 py-1 text-[11px] font-semibold text-white'
                          : slot.available
                            ? 'rounded-md border border-line-strong bg-white px-2 py-1 text-[11px] font-medium text-ink-700 transition-colors hover:border-brand-400 hover:text-brand-700'
                            : 'cursor-not-allowed rounded-md border border-line bg-surface-muted px-2 py-1 text-[11px] text-ink-300 line-through'
                      }
                      title={slot.available ? 'Free slot' : 'Already booked'}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {requiresOverride && canOverrideSchedule && (
                <div className="mt-3">
                  <Field
                    label="Override reason"
                    htmlFor="appt-override"
                    required
                    hint="Recorded in the audit trail. Only use this when the clinic has agreed an exception."
                  >
                    <Input
                      id="appt-override"
                      value={overrideReason}
                      onChange={(event) => setOverrideReason(event.target.value)}
                      placeholder="e.g. Patient travelling, approved by Dr Hassan"
                      maxLength={300}
                      autoFocus
                    />
                  </Field>
                </div>
              )}
            </section>

            {editing && (
              <Field
                label="Reschedule reason"
                htmlFor="appt-reschedule-reason"
                hint="Optional, but helpful when reviewing the appointment history."
              >
                <Input
                  id="appt-reschedule-reason"
                  value={rescheduleReason}
                  onChange={(event) => setRescheduleReason(event.target.value)}
                  maxLength={300}
                  placeholder="e.g. Doctor called to an emergency"
                />
              </Field>
            )}

            {conflict && slots.some((slot) => slot.available) && (
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-amber-ink">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  Free times for this duration
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {slots
                    .filter((slot) => slot.available)
                    .slice(0, 12)
                    .map((slot) => (
                      <Button
                        key={slot.start}
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setTime(minutesToLabel(slot.minute));
                          setConflict(null);
                        }}
                      >
                        {minutesToLabel(slot.minute)}
                      </Button>
                    ))}
                </div>
              </div>
            )}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {editing ? 'Save new time' : 'Book appointment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
