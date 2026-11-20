import { useState } from 'react';
import { CalendarCheck, CalendarX, Zap } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { formatDateOnly, formatLongDate, formatTime } from '../../lib/format';
import { useQuickAction } from '../../lib/useQuickAction';
import { fetchNextAvailable } from '../../lib/quickActions';
import { Alert, Badge, Card, EmptyState, SectionCard } from '../../components/ui';
import {
  DoctorFilter,
  FilterBar,
  QuickActionResult,
  RefreshButton,
  doctorName,
} from './shared';

/** Action 5 — the earliest open slot inside the 60-day horizon. */
export function NextAvailablePanel() {
  const { user } = useAuth();
  const { doctors, timezone } = useClinic();
  const isDoctor = user?.role === 'DOCTOR';
  const [doctorId, setDoctorId] = useState(isDoctor ? (user?.id ?? '') : '');

  const state = useQuickAction(
    (signal) => fetchNextAvailable({ doctorId: doctorId || undefined }, signal),
    { deps: [doctorId] },
  );

  return (
    <SectionCard
      title="Next available appointment"
      description="The earliest open slot for the chosen doctor, searched up to 60 days ahead."
      icon={Zap}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <FilterBar>
        {!isDoctor && (
          <DoctorFilter doctors={doctors} value={doctorId} onChange={setDoctorId} />
        )}
      </FilterBar>

      <QuickActionResult state={state} loadingLabel="Searching the next 60 days…">
        {(data) => (
          <>
            {data.found && data.result ? (
              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line bg-brand-50/60 px-5 py-4">
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-700">
                      <CalendarCheck className="h-3.5 w-3.5" aria-hidden />
                      Next available slot
                    </p>
                    <p className="tabular mt-1 text-2xl font-semibold tracking-tight text-ink-950">
                      {formatTime(data.result.startAt, timezone)}
                    </p>
                    <p className="mt-1 text-[13px] font-medium text-ink-700">
                      {formatLongDate(data.result.date)}
                    </p>
                  </div>
                  <Badge tone="success" dot>
                    Found within {data.horizonDays} days
                  </Badge>
                </div>
                <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-400">
                      Doctor
                    </p>
                    <p className="mt-0.5 text-[13px] font-medium text-ink-800">
                      {doctorName(data.result.doctor)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-400">
                      Ends
                    </p>
                    <p className="tabular mt-0.5 text-[13px] font-medium text-ink-800">
                      {formatTime(data.result.endAt, timezone)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-400">
                      Duration
                    </p>
                    <p className="mt-0.5 text-[13px] font-medium text-ink-800">
                      {data.durationMinutes} minutes
                    </p>
                  </div>
                </div>
              </Card>
            ) : (
              <EmptyState
                icon={CalendarX}
                title={`No availability in the next ${data.horizonDays} days`}
                description={
                  data.message ??
                  'Try another doctor or extend the schedule from clinic settings.'
                }
              />
            )}

            <Alert tone="info">
              Searched {formatDateOnly(data.from)} to {formatDateOnly(data.to)} (
              {data.horizonDays} clinic days). Only slots the booking engine would accept are
              counted.
            </Alert>
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
