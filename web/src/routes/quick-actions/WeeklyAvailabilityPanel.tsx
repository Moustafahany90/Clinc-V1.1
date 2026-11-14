import { useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
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
import { fetchWeeklyAvailability } from '../../lib/quickActions';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  SectionCard,
  Stat,
} from '../../components/ui';
import {
  DoctorFilter,
  DurationHint,
  FilterBar,
  OpeningHoursText,
  QuickActionResult,
  RefreshButton,
  ServiceFilter,
  SlotChips,
  doctorName,
} from './shared';

/**
 * Action 3 — available slots for the clinic week. The clinic week starts on
 * Saturday; any anchor date is normalised by the server, so previous/next move
 * in whole weeks without DST drift.
 */
export function WeeklyAvailabilityPanel() {
  const { user } = useAuth();
  const { doctors, services, timezone } = useClinic();
  const isDoctor = user?.role === 'DOCTOR';
  const [anchor, setAnchor] = useState(todayInZone(timezone));
  const [doctorId, setDoctorId] = useState(isDoctor ? (user?.id ?? '') : '');
  const [serviceId, setServiceId] = useState('');

  const state = useQuickAction(
    (signal) =>
      fetchWeeklyAvailability(
        {
          weekStart: anchor,
          doctorId: doctorId || undefined,
          serviceId: serviceId || undefined,
        },
        signal,
      ),
    { deps: [anchor, doctorId, serviceId] },
  );

  return (
    <SectionCard
      title="Weekly availability"
      description="Open slots for the Saturday → Friday clinic week, grouped by day and doctor."
      icon={CalendarRange}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <FilterBar>
        <div className="flex items-end gap-1.5">
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={() => setAnchor((value) => addDays(value, -7))}
            aria-label="Previous week"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <Field label="Week of" className="w-[10.5rem]">
            <Input
              type="date"
              value={anchor}
              onChange={(event) => event.target.value && setAnchor(event.target.value)}
            />
          </Field>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={() => setAnchor((value) => addDays(value, 7))}
            aria-label="Next week"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAnchor(todayInZone(timezone))}>
            This week
          </Button>
        </div>
        {!isDoctor && (
          <DoctorFilter doctors={doctors} value={doctorId} onChange={setDoctorId} />
        )}
        <ServiceFilter services={services} value={serviceId} onChange={setServiceId} />
      </FilterBar>

      <QuickActionResult state={state} loadingLabel="Building the week's availability…">
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Open slots"
                value={data.totalAvailable}
                hint={`${formatDateOnly(data.weekStart)} – ${formatDateOnly(data.weekEnd)}`}
                icon={CalendarRange}
                tone={data.totalAvailable > 0 ? 'success' : 'neutral'}
              />
              <Stat
                label="Days with openings"
                value={data.availableDays.length}
                hint={`of 7 days · ${formatLongDate(data.weekStart)} start`}
                icon={Clock}
                tone={data.availableDays.length > 0 ? 'brand' : 'neutral'}
              />
              <Stat
                label="Appointment length"
                value={`${data.durationMinutes} min`}
                hint={`${data.slotIntervalMinutes} min booking grid`}
                icon={Clock}
              />
            </div>

            {data.totalAvailable === 0 && (
              <Alert tone="info" title="No open slots this week">
                The day cards below show whether the clinic or doctor is closed, or whether every
                slot is already booked.
              </Alert>
            )}

            <div className="space-y-3">
              {data.days.map((day) => (
                <Card key={day.date} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-[13px] font-semibold text-ink-900">
                        {weekdayName(day.date)} · {formatDateOnly(day.date)}
                      </p>
                      <p className="text-[11px] text-ink-400">
                        {day.doctors.length} doctor{day.doctors.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    <Badge
                      tone={day.totalAvailable > 0 ? 'success' : day.isOpen ? 'warning' : 'muted'}
                      dot
                    >
                      {day.totalAvailable > 0 ? `${day.totalAvailable} open` : day.isOpen ? 'Fully booked' : 'Closed'}
                    </Badge>
                  </div>

                  <div className="mt-3 space-y-3">
                    {day.doctors.map((row) => (
                      <div
                        key={`${day.date}-${row.doctor.id}`}
                        className="border-t border-line pt-2.5 first:border-t-0 first:pt-0"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[12px] font-medium text-ink-700">
                            {doctorName(row.doctor)}
                          </span>
                          <OpeningHoursText hours={row.openingHours} />
                        </div>
                        <div className="mt-1.5">
                          {!row.isOpen ? (
                            <p className="text-[12px] text-ink-400">
                              {row.openingHours.reason ?? 'Not available'}
                            </p>
                          ) : row.availableCount === 0 ? (
                            <p className="text-[12px] text-ink-400">Fully booked</p>
                          ) : (
                            <SlotChips slots={row.slots} limit={8} />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>

            <DurationHint
              durationMinutes={data.durationMinutes}
              slotIntervalMinutes={data.slotIntervalMinutes}
            />
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
