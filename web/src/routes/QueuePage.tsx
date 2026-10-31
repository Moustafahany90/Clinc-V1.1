import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Ban,
  CheckCheck,
  ListOrdered,
  PhoneCall,
  Play,
  Plus,
  RotateCcw,
  Stethoscope,
  Timer,
  UserPlus,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import {
  addDays,
  formatTime,
  secondsToClock,
  todayInZone,
} from '../lib/format';
import type { PaymentMethod, Patient, QueueEntry, Service } from '../lib/types';
import { PatientSearch } from '../components/PatientSearch';
import { ReasonDialog } from '../components/dialogs';
import { useToast } from '../components/toast';
import {
  Alert,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Stat,
  StatusBadge,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface QueueResponse {
  date: string;
  entries: (QueueEntry & { waitingSeconds: number | null; examSeconds: number | null })[];
}

interface QueueSummary {
  date: string;
  counts: {
    total: number;
    waiting: number;
    called: number;
    inExam: number;
    skipped: number;
    done: number;
  };
  waitingTime: {
    measuredPatients: number;
    averageMinutes: number | null;
    longestMinutes: number | null;
  };
}

function patientName(entry: QueueEntry): string {
  if (!entry.patient) return 'Patient';
  return `${entry.patient.firstName} ${entry.patient.lastName}`;
}

export function QueuePage() {
  const { user, hasPermission } = useAuth();
  const { doctors, services, timezone } = useClinic();
  const toast = useToast();
  const today = todayInZone(timezone);
  const [date, setDate] = useState(today);
  const [doctorId, setDoctorId] = useState(user?.role === 'DOCTOR' ? user.id : '');
  const [status, setStatus] = useState('');
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [skipTarget, setSkipTarget] = useState<QueueEntry | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const state = useAsyncData<QueueResponse>(
    async () => {
      const res = await api.get<QueueResponse>('/queue', {
        params: {
          date,
          ...(doctorId ? { doctorId } : {}),
          ...(status ? { status } : {}),
        },
      });
      return res.data;
    },
    [date, doctorId, status],
  );

  const summary = useAsyncData<QueueSummary>(
    async () => {
      const res = await api.get<QueueSummary>('/queue/summary', { params: { date } });
      return res.data;
    },
    [date],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      state.reload();
      summary.reload();
    }, 30_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, doctorId, status]);

  const editable = date === today;
  const canWrite = hasPermission('QUEUE_WRITE') && editable;
  const entries = state.data?.entries ?? [];
  const counts = summary.data?.counts;

  async function move(entry: QueueEntry, next: string, reason?: string) {
    setBusyId(entry.id);
    try {
      await api.patch(`/queue/${entry.id}/status`, {
        status: next,
        ...(reason ? { reason } : {}),
      });
      toast.success('Queue updated', `${patientName(entry)} · ${next.toLowerCase().replace('_', ' ')}`);
      state.reload();
      summary.reload();
      return true;
    } catch (err) {
      toast.error('Could not update the queue', errorMessage(err));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        title="Waiting queue"
        description="Live arrival order, exam progress and waiting times. Only today's queue can be changed."
        actions={
          (hasPermission('QUEUE_WRITE') || hasPermission('APPOINTMENTS_WRITE')) && (
            <Button onClick={() => setWalkInOpen(true)} disabled={!editable}>
              <UserPlus className="h-4 w-4" aria-hidden />
              Add walk-in
            </Button>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Waiting" value={counts?.waiting ?? 0} icon={Timer} tone="warning" />
        <Stat label="Called" value={counts?.called ?? 0} icon={PhoneCall} tone="brand" />
        <Stat label="In exam" value={counts?.inExam ?? 0} icon={Stethoscope} tone="info" />
        <Stat
          label="Average wait"
          value={
            summary.data?.waitingTime.averageMinutes != null
              ? `${summary.data.waitingTime.averageMinutes} min`
              : '—'
          }
          hint={
            summary.data?.waitingTime.measuredPatients
              ? `${summary.data.waitingTime.measuredPatients} measured today`
              : 'No completed waits yet'
          }
          icon={CheckCheck}
          tone="success"
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Date" className="w-[10.5rem]">
            <Input type="date" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} />
          </Field>
          <div className="flex gap-1.5">
            <Button variant="secondary" onClick={() => setDate(addDays(date, -1))}>
              Previous
            </Button>
            <Button variant="secondary" onClick={() => setDate(today)}>
              Today
            </Button>
            <Button variant="secondary" onClick={() => setDate(addDays(date, 1))}>
              Next
            </Button>
          </div>
          {user?.role !== 'DOCTOR' && (
            <Field label="Doctor" className="w-full sm:w-60">
              <Select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}>
                <option value="">All doctors</option>
                {doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    Dr {doctor.firstName} {doctor.lastName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Status" className="w-full sm:w-44">
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="WAITING">Waiting</option>
              <option value="CALLED">Called</option>
              <option value="IN_EXAM">In exam</option>
              <option value="SKIPPED">Skipped</option>
              <option value="DONE">Done</option>
            </Select>
          </Field>
        </div>
        {!editable && (
          <Alert tone="info" className="mt-3">
            You are viewing another day. Queue status changes are only possible for today.
          </Alert>
        )}
      </Card>

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Card>
        {state.loading && !state.data ? (
          <LoadingBlock label="Loading the queue…" />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={ListOrdered}
            title="The queue is empty"
            description="Patients appear here when they arrive for an appointment, or when you add a walk-in."
            action={
              editable ? (
                <Button variant="secondary" onClick={() => setWalkInOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Add walk-in
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH>Patient</TH>
                    <TH>Doctor</TH>
                    <TH>Appointment</TH>
                    <TH>Waiting</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {entries.map((entry) => (
                    <TR key={entry.id}>
                      <TD className="tabular text-ink-500">{entry.position ?? '—'}</TD>
                      <TD>
                        {entry.patient ? (
                          <Link
                            to={`/patients/${entry.patient.id}`}
                            className="font-medium text-ink-900 hover:text-brand-700"
                          >
                            {patientName(entry)}
                          </Link>
                        ) : (
                          patientName(entry)
                        )}
                        <p className="mt-0.5 font-mono text-[11px] text-ink-400">
                          {entry.patient?.patientNumber ?? ''}
                        </p>
                      </TD>
                      <TD className="whitespace-nowrap">
                        {entry.doctor ? `Dr ${entry.doctor.firstName} ${entry.doctor.lastName}` : '—'}
                      </TD>
                      <TD className="whitespace-nowrap text-ink-600">
                        {entry.appointment ? (
                          <>
                            {formatTime(entry.appointment.startAt, timezone)}
                            <span className="ml-1 text-[11px] text-ink-400">
                              {entry.appointment.service?.name ?? ''}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD className="tabular whitespace-nowrap text-ink-600">
                        {entry.status === 'IN_EXAM'
                          ? secondsToClock(entry.examSeconds)
                          : secondsToClock(entry.waitingSeconds)}
                      </TD>
                      <TD>
                        <StatusBadge status={entry.status} />
                        {entry.skipReason && (
                          <p className="mt-1 max-w-[12rem] text-[11px] text-ink-400">
                            {entry.skipReason}
                          </p>
                        )}
                      </TD>
                      <TD>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {canWrite && entry.status === 'WAITING' && (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                loading={busyId === entry.id}
                                onClick={() => void move(entry, 'CALLED')}
                              >
                                <PhoneCall className="h-3.5 w-3.5" aria-hidden />
                                Call
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => void move(entry, 'IN_EXAM')}
                                loading={busyId === entry.id}
                              >
                                <Play className="h-3.5 w-3.5" aria-hidden />
                                Start
                              </Button>
                            </>
                          )}
                          {canWrite && entry.status === 'CALLED' && (
                            <>
                              <Button
                                size="sm"
                                onClick={() => void move(entry, 'IN_EXAM')}
                                loading={busyId === entry.id}
                              >
                                <Play className="h-3.5 w-3.5" aria-hidden />
                                Start exam
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void move(entry, 'WAITING')}
                                loading={busyId === entry.id}
                              >
                                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                                Back
                              </Button>
                            </>
                          )}
                          {canWrite && entry.status === 'IN_EXAM' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => void move(entry, 'DONE')}
                              loading={busyId === entry.id}
                            >
                              <CheckCheck className="h-3.5 w-3.5" aria-hidden />
                              Complete
                            </Button>
                          )}
                          {canWrite && entry.status === 'SKIPPED' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => void move(entry, 'WAITING')}
                              loading={busyId === entry.id}
                            >
                              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                              Rejoin
                            </Button>
                          )}
                          {canWrite && ['WAITING', 'CALLED'].includes(entry.status) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setSkipTarget(entry)}
                              loading={busyId === entry.id}
                            >
                              <Ban className="h-3.5 w-3.5" aria-hidden />
                              Skip
                            </Button>
                          )}
                          {entry.status === 'DONE' && (
                            <span className="text-[11px] text-ink-400">Completed</span>
                          )}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[11px] text-ink-400">
              <span>{entries.length} entries shown</span>
              <button
                type="button"
                onClick={() => {
                  state.reload();
                  summary.reload();
                }}
                className="inline-flex items-center gap-1 font-medium text-brand-700 hover:text-brand-800"
              >
                Refresh now
                <ArrowRight className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </>
        )}
      </Card>

      <ReasonDialog
        open={skipTarget !== null}
        onOpenChange={(next) => !next && setSkipTarget(null)}
        title="Skip this patient"
        description="Skipping marks the appointment as a no-show. The patient can be returned to the queue later."
        label="Reason"
        confirmLabel="Skip patient"
        busy={busyId === skipTarget?.id}
        onConfirm={(reason) => {
          if (!skipTarget) return;
          void move(skipTarget, 'SKIPPED', reason).then((ok) => {
            if (ok) setSkipTarget(null);
          });
        }}
      />

      <WalkInDialog open={walkInOpen} onOpenChange={setWalkInOpen} onCreated={() => {
        state.reload();
        summary.reload();
      }} />
    </div>
  );
}

function WalkInDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { user } = useAuth();
  const { doctors, services } = useClinic();
  const toast = useToast();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [doctorId, setDoctorId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPatient(null);
    setDoctorId(user?.role === 'DOCTOR' ? user.id : doctors[0]?.id ?? '');
    setServiceId('');
    setBusy(false);
    setError(null);
  }, [open, user, doctors]);

  const activeServices = useMemo<Service[]>(
    () => services.filter((service) => service.isActive),
    [services],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!patient) {
      setError('Select the patient who has arrived.');
      return;
    }
    if (!doctorId) {
      setError('Select the doctor who will see the patient.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/queue/walk-in', {
        patientId: patient.id,
        doctorId,
        ...(serviceId ? { serviceId } : {}),
      });
      toast.success('Walk-in added to the queue', `${patient.firstName} ${patient.lastName}`);
      onCreated();
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
          title="Add a walk-in"
          description="Creates a same-day arrived appointment and adds the patient to the queue."
          icon={UserPlus}
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Patient" required>
              <PatientSearch value={patient} onChange={setPatient} autoFocus />
            </Field>
            <Field label="Doctor" required>
              <Select
                value={doctorId}
                onChange={(event) => setDoctorId(event.target.value)}
                disabled={user?.role === 'DOCTOR'}
              >
                <option value="">Select a doctor…</option>
                {doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    Dr {doctor.firstName} {doctor.lastName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Service" hint="Optional. Its duration is used for the appointment.">
              <Select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
                <option value="">No specific service</option>
                {activeServices.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name} · {service.durationMinutes} min
                  </option>
                ))}
              </Select>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Add to queue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
