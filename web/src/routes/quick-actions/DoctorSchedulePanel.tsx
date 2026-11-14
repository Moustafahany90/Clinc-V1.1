import { useState } from 'react';
import { CalendarClock, CalendarDays, Clock, Stethoscope } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import {
  addDays,
  formatDateOnly,
  formatLongDate,
  todayInZone,
  weekdayName,
} from '../../lib/format';
import { useQuickAction } from '../../lib/useQuickAction';
import { fetchDoctorSchedule } from '../../lib/quickActions';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Field,
  Input,
  SectionCard,
  Stat,
} from '../../components/ui';
import {
  AppointmentLine,
  DoctorFilter,
  FilterBar,
  OpeningHoursText,
  QuickActionResult,
  RefreshButton,
  SlotChips,
  doctorName,
} from './shared';

const MAX_RANGE_DAYS = 31;

/** Action 4 — one doctor's appointments and open slots for a day or short range. */
export function DoctorSchedulePanel() {
  const { user } = useAuth();
  const { doctors, timezone } = useClinic();
  const isDoctor = user?.role === 'DOCTOR';
  const today = todayInZone(timezone);
  const [doctorId, setDoctorId] = useState(isDoctor ? (user?.id ?? '') : '');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const state = useQuickAction(
    (signal) => fetchDoctorSchedule({ doctorId, from, to }, signal),
    { enabled: Boolean(doctorId), deps: [doctorId, from, to] },
  );

  function changeFrom(value: string) {
    if (!value) return;
    setFrom(value);
    if (to < value) setTo(value);
  }

  function changeTo(value: string) {
    if (!value) return;
    setTo(value < from ? from : value);
  }

  return (
    <SectionCard
      title="Doctor schedule"
      description="Appointments and remaining availability for one doctor, for a single day or up to 31 days."
      icon={CalendarClock}
      action={<RefreshButton state={state} disabled={!doctorId} />}
      bodyClassName="space-y-4"
    >
      <FilterBar>
        {!isDoctor && (
          <DoctorFilter
            doctors={doctors}
            value={doctorId}
            onChange={setDoctorId}
            includeAll={false}
            className="w-full sm:w-64"
          />
        )}        <Field label="From" className="w-[10.5rem]">
          <Input
            type="date"
            value={from}
            max={to}
            onChange={(event) => changeFrom(event.target.value)}
          />
        </Field>
        <Field label="To" hint={`Up to ${MAX_RANGE_DAYS} days.`} className="w-[10.5rem]">
          <Input
            type="date"
            value={to}
            min={from}
            max={addDays(from, MAX_RANGE_DAYS - 1)}
            onChange={(event) => changeTo(event.target.value)}
          />
        </Field>
      </FilterBar>

      {!doctorId ? (
        <EmptyState
          icon={Stethoscope}
          title="Choose a doctor"
          description="Pick a doctor to see their appointments and remaining open slots for the selected date range."
        />
      ) : (
        <QuickActionResult state={state} loadingLabel="Loading the doctor's schedule…">
          {(data) => (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat
                  label="Appointments"
                  value={data.totalAppointments}
                  hint={`${formatDateOnly(data.from)} – ${formatDateOnly(data.to)}`}
                  icon={CalendarDays}
                  tone="brand"
                />
                <Stat
                  label="Open slots"
                  value={data.totalAvailable}
                  hint={`${data.durationMinutes} min · ${data.slotIntervalMinutes} min grid`}
                  icon={CalendarClock}
                  tone={data.totalAvailable > 0 ? 'success' : 'neutral'}
                />
                <Stat
                  label="Doctor"
                  value={doctorName(data.doctor)}
                  hint={`${data.days.length} day${data.days.length === 1 ? '' : 's'} shown`}
                  icon={Stethoscope}
                />
              </div>

              {data.truncated && (
                <Alert tone="warning" title="Appointment list truncated">
                  This range has more than 500 appointments. Narrow the date range to see the full
                  details.
                </Alert>
              )}

              {!data.canViewPatientNames && (
                <Alert tone="info" title="Patient names are hidden">
                  Your account can see the schedule but not patient identities.
                </Alert>
              )}

              <div className="space-y-3">
                {data.days.map((day) => (
                  <Card key={day.date} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-ink-900">
                          {weekdayName(day.date)} · {formatLongDate(day.date)}
                        </p>
                        <OpeningHoursText hours={day.openingHours} />
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone="brand" dot>
                          {day.appointments.length} appointment
                          {day.appointments.length === 1 ? '' : 's'}
                        </Badge>
                        <Badge
                          tone={
                            day.availableCount > 0 ? 'success' : day.isOpen ? 'warning' : 'muted'
                          }
                          dot
                        >
                          {day.isOpen ? `${day.availableCount} open` : 'Closed'}
                        </Badge>
                      </div>
                    </div>

                    {!day.isOpen && (
                      <Alert tone="warning" className="mt-3">
                        {day.openingHours.reason ?? 'Not available on this day.'}
                      </Alert>
                    )}

                    {day.appointments.length > 0 && (
                      <ul className="mt-3 divide-y divide-line border-t border-line">
                        {day.appointments.map((appointment) => (
                          <AppointmentLine
                            key={appointment.id}
                            appointment={appointment}
                            canViewPatientNames={data.canViewPatientNames}
                            timezone={timezone}
                          />
                        ))}
                      </ul>
                    )}

                    {day.isOpen && (
                      <div className={day.appointments.length > 0 ? 'mt-3' : 'mt-3'}>
                        <div className="mb-1.5 flex items-center gap-1.5">
                          <Clock className="h-3 w-3 text-ink-400" aria-hidden />
                          <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-400">
                            Open slots
                          </p>
                        </div>
                        <SlotChips
                          slots={day.slots}
                          emptyLabel="No open slots left on this day."
                        />
                      </div>
                    )}

                    {!day.isOpen && day.appointments.length === 0 && (
                      <p className="mt-2 text-[12px] text-ink-400">No appointments on this day.</p>
                    )}
                  </Card>
                ))}
              </div>
            </>
          )}
        </QuickActionResult>
      )}
    </SectionCard>
  );
}
