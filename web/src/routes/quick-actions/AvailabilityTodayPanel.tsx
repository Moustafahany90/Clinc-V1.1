import { useState } from 'react';
import { CalendarCheck, CalendarDays, Clock, Stethoscope } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { formatLongDate, todayInZone } from '../../lib/format';
import { useQuickAction } from '../../lib/useQuickAction';
import { fetchTodayAvailability } from '../../lib/quickActions';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
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
  SlotChips,
  doctorName,
} from './shared';

/** Action 1 — available appointment slots today, grouped by doctor. */
export function AvailabilityTodayPanel() {
  const { user } = useAuth();
  const { doctors, timezone } = useClinic();
  const isDoctor = user?.role === 'DOCTOR';
  const [doctorId, setDoctorId] = useState(isDoctor ? (user?.id ?? '') : '');

  const state = useQuickAction(
    (signal) => fetchTodayAvailability({ doctorId: doctorId || undefined }, signal),
    { deps: [doctorId] },
  );

  return (
    <SectionCard
      title="Available appointments today"
      description={`Open slots for ${formatLongDate(todayInZone(timezone))}, grouped by doctor.`}
      icon={CalendarCheck}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <FilterBar>
        {!isDoctor && (
          <DoctorFilter doctors={doctors} value={doctorId} onChange={setDoctorId} />
        )}
      </FilterBar>

      <QuickActionResult state={state} loadingLabel="Checking today's availability…">
        {(data) => {
          if (data.doctors.length === 0) {
            return (
              <EmptyState
                icon={CalendarDays}
                title="No active doctors"
                description="Add an active doctor account before checking availability."
              />
            );
          }
          const openDoctors = data.doctors.filter((row) => row.isOpen);
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat
                  label="Open slots"
                  value={data.totalAvailable}
                  hint={formatLongDate(data.date)}
                  icon={CalendarCheck}
                  tone={data.totalAvailable > 0 ? 'success' : 'neutral'}
                />
                <Stat
                  label="Doctors open"
                  value={`${openDoctors.length}/${data.doctors.length}`}
                  hint="Doctors with a working window today"
                  icon={Stethoscope}
                  tone={openDoctors.length > 0 ? 'brand' : 'neutral'}
                />
                <Stat
                  label="Appointment length"
                  value={`${data.durationMinutes} min`}
                  hint={`${data.slotIntervalMinutes} min booking grid`}
                  icon={Clock}
                />
              </div>

              {data.totalAvailable === 0 && (
                <Alert tone="info" title="No open slots remain today">
                  The rows below show whether each doctor is closed, outside working hours, or
                  fully booked.
                </Alert>
              )}

              <div className="space-y-3">
                {data.doctors.map((row) => (
                  <Card key={row.doctor.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-ink-900">
                          {doctorName(row.doctor)}
                        </p>
                        {row.openingHours.isOpen && <OpeningHoursText hours={row.openingHours} />}
                      </div>
                      <Badge
                        tone={row.availableCount > 0 ? 'success' : row.isOpen ? 'warning' : 'muted'}
                        dot
                      >
                        {row.isOpen ? `${row.availableCount} open` : 'Closed'}
                      </Badge>
                    </div>

                    <div className="mt-3">
                      {!row.isOpen ? (
                        <Alert tone="warning">
                          {row.openingHours.reason ?? 'This doctor is not available today.'}
                        </Alert>
                      ) : row.availableCount === 0 ? (
                        <p className="text-[12px] text-ink-500">
                          No open slots left today — every remaining time is booked or already past.
                        </p>
                      ) : (
                        <SlotChips slots={row.slots} />
                      )}
                    </div>
                  </Card>
                ))}
              </div>

              <DurationHint
                durationMinutes={data.durationMinutes}
                slotIntervalMinutes={data.slotIntervalMinutes}
              />
            </>
          );
        }}
      </QuickActionResult>
    </SectionCard>
  );
}
