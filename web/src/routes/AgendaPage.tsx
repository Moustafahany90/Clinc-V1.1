import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Clock,
  Info,
  Plus,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import {
  addDays,
  formatLongDate,
  formatTime,
  minutesToLabel,
  todayInZone,
} from '../lib/format';
import type { Agenda, Appointment } from '../lib/types';
import { AppointmentActions } from '../components/AppointmentActions';
import { AppointmentDialog } from '../components/AppointmentDialog';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  StatusBadge,
} from '../components/ui';
import { cn } from '../lib/utils';

function patientName(appointment: Appointment): string {
  if (!appointment.patient) return 'Patient';
  return `${appointment.patient.firstName} ${appointment.patient.lastName}`;
}

export function AgendaPage() {
  const { user } = useAuth();
  const { doctors, timezone } = useClinic();
  const [date, setDate] = useState(todayInZone(timezone));
  const [doctorId, setDoctorId] = useState(user?.role === 'DOCTOR' ? user.id : '');
  const [newOpen, setNewOpen] = useState(false);

  const state = useAsyncData<Agenda>(
    async () => {
      const res = await api.get<Agenda>('/appointments/agenda', {
        params: {
          date,
          ...(doctorId ? { doctorId } : {}),
        },
      });
      return res.data;
    },
    [date, doctorId],
  );

  const data = state.data;
  const appointments = data?.appointments ?? [];

  const grouped = useMemo(() => {
    if (doctorId) return null;
    const map = new Map<string, { name: string; items: Appointment[] }>();
    for (const appointment of appointments) {
      const id = appointment.doctorId;
      if (!map.has(id)) {
        map.set(id, {
          name: appointment.doctor
            ? `Dr ${appointment.doctor.firstName} ${appointment.doctor.lastName}`
            : 'Unassigned doctor',
          items: [],
        });
      }
      map.get(id)!.items.push(appointment);
    }
    return [...map.values()];
  }, [appointments, doctorId]);

  const openWindow = data?.openingHours;
  const selectedDoctor = doctors.find((doctor) => doctor.id === doctorId);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        title="Agenda"
        description="Day schedule, available slots and booking controls for every doctor."
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <CalendarPlus className="h-4 w-4" aria-hidden />
            New appointment
          </Button>
        }
      />

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-end gap-1.5">
            <Button
              variant="secondary"
              size="icon"
              onClick={() => setDate((value) => addDays(value, -1))}
              aria-label="Previous day"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <div>
              <label
                htmlFor="agenda-date"
                className="mb-1 block text-[11px] font-medium uppercase tracking-[0.06em] text-ink-400"
              >
                Day
              </label>
              <Input
                id="agenda-date"
                type="date"
                value={date}
                onChange={(event) => event.target.value && setDate(event.target.value)}
                className="w-[10.5rem]"
              />
            </div>
            <Button
              variant="secondary"
              size="icon"
              onClick={() => setDate((value) => addDays(value, 1))}
              aria-label="Next day"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="ghost" onClick={() => setDate(todayInZone(timezone))}>
              Today
            </Button>
          </div>

          {user?.role !== 'DOCTOR' && (
            <Field label="Doctor" className="w-full sm:w-64">
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

          <div className="ml-auto text-right">
            <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-400">
              {formatLongDate(date)}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-500">
              {appointments.length} appointment{appointments.length === 1 ? '' : 's'}
              {selectedDoctor ? ` · Dr ${selectedDoctor.firstName} ${selectedDoctor.lastName}` : ''}
            </p>
          </div>
        </div>
      </Card>

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      {state.loading && !data ? (
        <LoadingBlock label="Loading the day schedule…" />
      ) : (
        <div className={cn('grid gap-6', doctorId ? 'lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]' : '')}>
          {doctorId && (
            <div className="space-y-4">
              <Card className="p-4">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-brand-600" aria-hidden />
                  <p className="text-sm font-semibold text-ink-900">Opening hours</p>
                </div>
                {openWindow ? (
                  openWindow.isOpen ? (
                    <div className="mt-2 text-[13px] text-ink-600">
                      <p>
                        {minutesToLabel(openWindow.openMinute)} – {minutesToLabel(openWindow.closeMinute)}
                      </p>
                      {openWindow.breakStartMinute != null && openWindow.breakEndMinute != null && (
                        <p className="mt-0.5 text-[12px] text-ink-500">
                          Break {minutesToLabel(openWindow.breakStartMinute)} –{' '}
                          {minutesToLabel(openWindow.breakEndMinute)}
                        </p>
                      )}
                    </div>
                  ) : (
                    <Alert tone="warning" className="mt-2">
                      {openWindow.reason ?? 'The clinic is closed for this doctor on this day.'}
                    </Alert>
                  )
                ) : (
                  <p className="mt-2 text-[12px] text-ink-500">No schedule configured for this day.</p>
                )}
              </Card>

              <Card className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ink-900">Slots</p>
                  <span className="text-[11px] text-ink-400">
                    {data?.durationMinutes ?? 15} min · every {data?.slotIntervalMinutes ?? 15} min
                  </span>
                </div>
                {!openWindow?.isOpen ? (
                  <p className="mt-3 text-[12px] text-ink-500">
                    {openWindow?.reason ?? 'The clinic or doctor is closed on this day.'}
                  </p>
                ) : (data?.slots.length ?? 0) === 0 ? (
                  <p className="mt-3 text-[12px] text-ink-500">No slots available.</p>
                ) : (
                  <div className="mt-3 grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-3">
                    {data?.slots.map((slot) => (
                      <button
                        key={`${slot.start}-${slot.minute}`}
                        type="button"
                        onClick={() => {
                          if (slot.available) setNewOpen(true);
                        }}
                        disabled={!slot.available}
                        title={slot.available ? 'Book this time' : 'Already booked'}
                        className={cn(
                          'tabular rounded-lg border px-1 py-1.5 text-[11px] font-medium transition-colors',
                          slot.available
                            ? 'border-line bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800'
                            : 'cursor-not-allowed border-line bg-surface-muted text-ink-300 line-through',
                        )}
                      >
                        {minutesToLabel(slot.minute)}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-3 flex items-start gap-1.5 text-[11px] text-ink-400">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  Selecting a free time opens a prefilled booking form. Overlaps are always checked
                  by the server.
                </p>
              </Card>
            </div>
          )}

          <div className="space-y-4">
            {appointments.length === 0 ? (
              <Card>
                <EmptyState
                  icon={CalendarDays}
                  title="Nothing booked for this day"
                  description={
                    doctorId
                      ? 'Choose a free slot or create an appointment to fill the day.'
                      : 'Book an appointment or choose a doctor to see available slots.'
                  }
                  action={
                    <Button onClick={() => setNewOpen(true)}>
                      <Plus className="h-4 w-4" aria-hidden />
                      New appointment
                    </Button>
                  }
                />
              </Card>
            ) : doctorId ? (
              <div className="space-y-2">
                {appointments.map((appointment) => (
                  <Card
                    key={appointment.id}
                    className="flex flex-wrap items-center gap-4 p-4 transition-colors hover:border-brand-200"
                  >
                    <div className="w-[4.5rem] shrink-0">
                      <p className="tabular text-sm font-semibold text-ink-950">
                        {formatTime(appointment.startAt, timezone)}
                      </p>
                      <p className="tabular text-[11px] text-ink-400">
                        {formatTime(appointment.endAt, timezone)}
                      </p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {appointment.patient ? (
                          <Link
                            to={`/patients/${appointment.patient.id}`}
                            className="truncate text-sm font-semibold text-ink-900 hover:text-brand-700"
                          >
                            {patientName(appointment)}
                          </Link>
                        ) : (
                          <span className="text-sm font-semibold text-ink-900">Patient</span>
                        )}
                        <StatusBadge status={appointment.status} />
                        {appointment.isManualOverride && (
                          <span className="text-[10px] font-medium uppercase tracking-wide text-amber-ink">
                            outside hours
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-[12px] text-ink-500">
                        {appointment.patient?.patientNumber ?? '—'}
                        {appointment.service ? ` · ${appointment.service.name}` : ''}
                        {appointment.reason ? ` · ${appointment.reason}` : ''}
                      </p>
                    </div>
                    <AppointmentActions appointment={appointment} onChanged={() => state.reload()} />
                  </Card>
                ))}
              </div>
            ) : (
              <div className="space-y-5">
                {grouped?.map((group) => (
                  <div key={group.name}>
                    <div className="mb-2 flex items-center justify-between">
                      <h2 className="text-[13px] font-semibold text-ink-800">{group.name}</h2>
                      <span className="text-[11px] text-ink-400">
                        {group.items.length} appointment{group.items.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {group.items.map((appointment) => (
                        <Card key={appointment.id} className="flex flex-wrap items-center gap-4 p-4">
                          <div className="w-[4.5rem] shrink-0">
                            <p className="tabular text-sm font-semibold text-ink-950">
                              {formatTime(appointment.startAt, timezone)}
                            </p>
                            <p className="tabular text-[11px] text-ink-400">
                              {formatTime(appointment.endAt, timezone)}
                            </p>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link
                                to={`/patients/${appointment.patientId}`}
                                className="truncate text-sm font-semibold text-ink-900 hover:text-brand-700"
                              >
                                {patientName(appointment)}
                              </Link>
                              <StatusBadge status={appointment.status} />
                            </div>
                            <p className="mt-1 text-[12px] text-ink-500">
                              {appointment.service?.name ?? 'No service selected'}
                            </p>
                          </div>
                          <AppointmentActions
                            appointment={appointment}
                            onChanged={() => state.reload()}
                          />
                        </Card>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <AppointmentDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        initialDate={date}
        initialDoctorId={doctorId || undefined}
        onSaved={() => state.reload()}
      />
    </div>
  );
}
