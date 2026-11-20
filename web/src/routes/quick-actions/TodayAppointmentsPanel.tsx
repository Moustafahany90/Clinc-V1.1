import { useState } from 'react';
import { CalendarDays, ListChecks, UserRound } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { formatLongDate, formatTime, todayInZone } from '../../lib/format';
import { useQuickAction } from '../../lib/useQuickAction';
import {
  QUICK_ACTION_LIMITS,
  QUICK_ACTION_STATUSES,
  fetchTodayAppointments,
} from '../../lib/quickActions';
import type { AppointmentStatus } from '../../lib/types';
import {
  Alert,
  EmptyState,
  Field,
  SectionCard,
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
  statusLabel,
} from '../../components/ui';
import {
  DoctorFilter,
  FilterBar,
  PatientCell,
  QuickActionResult,
  RefreshButton,
  doctorName,
} from './shared';

/** Action 2 — every appointment scheduled today, with permissions-aware names. */
export function TodayAppointmentsPanel() {
  const { user } = useAuth();
  const { doctors, timezone } = useClinic();
  const isDoctor = user?.role === 'DOCTOR';
  const [doctorId, setDoctorId] = useState(isDoctor ? (user?.id ?? '') : '');
  const [status, setStatus] = useState<AppointmentStatus | ''>('');
  const [limit, setLimit] = useState<number>(50);

  const state = useQuickAction(
    (signal) =>
      fetchTodayAppointments(
        {
          doctorId: doctorId || undefined,
          status: status || undefined,
          limit,
        },
        signal,
      ),
    { deps: [doctorId, status, limit] },
  );

  return (
    <SectionCard
      title="Today's appointments"
      description={`Every appointment for ${formatLongDate(todayInZone(timezone))}, including cancelled and no-show rows.`}
      icon={ListChecks}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <FilterBar>
        {!isDoctor && (
          <DoctorFilter doctors={doctors} value={doctorId} onChange={setDoctorId} />
        )}
        <Field label="Status" className="w-full sm:w-52">
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value as AppointmentStatus | '')}
          >
            <option value="">All statuses</option>
            {QUICK_ACTION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {statusLabel(value)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Show" className="w-full sm:w-36">
          <Select value={String(limit)} onChange={(event) => setLimit(Number(event.target.value))}>
            {QUICK_ACTION_LIMITS.map((value) => (
              <option key={value} value={value}>
                {value} rows
              </option>
            ))}
          </Select>
        </Field>
      </FilterBar>

      <QuickActionResult state={state} loadingLabel="Loading today's appointments…">
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Matching appointments"
                value={data.total}
                hint={data.status ? statusLabel(data.status) : 'All statuses'}
                icon={CalendarDays}
                tone="brand"
              />
              <Stat
                label="Shown"
                value={data.appointments.length}
                hint={data.hasMore ? `First ${data.limit} rows` : 'Complete list'}
                icon={ListChecks}
              />
              <Stat
                label="Patient names"
                value={data.canViewPatientNames ? 'Visible' : 'Restricted'}
                hint={
                  data.canViewPatientNames
                    ? 'Your account can view patient identities'
                    : 'Requires the “View patients” permission'
                }
                icon={UserRound}
                tone={data.canViewPatientNames ? 'success' : 'muted'}
              />
            </div>

            {!data.canViewPatientNames && (
              <Alert tone="info" title="Patient names are hidden">
                Your account can see the schedule but not patient identities. Appointment times,
                doctors and statuses remain available.
              </Alert>
            )}

            {data.hasMore && (
              <Alert tone="warning">
                Showing the first {data.limit} of {data.total} appointments. Narrow the doctor or
                status filter to see the rest.
              </Alert>
            )}

            {data.appointments.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title="No appointments match this view"
                description={
                  data.status || data.doctorId
                    ? 'Try clearing the doctor or status filter.'
                    : 'Nothing is scheduled for today yet.'
                }
              />
            ) : (
              <TableWrap>
                <Table>
                  <THead>
                    <TR>
                      <TH>Time</TH>
                      <TH>Patient</TH>
                      <TH>Doctor</TH>
                      <TH>Service / reason</TH>
                      <TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.appointments.map((appointment) => (
                      <TR key={appointment.id}>
                        <TD className="whitespace-nowrap">
                          <p className="tabular font-semibold text-ink-900">
                            {formatTime(appointment.startAt, timezone)}
                          </p>
                          <p className="tabular text-[11px] text-ink-400">
                            {formatTime(appointment.endAt, timezone)} ·{' '}
                            {appointment.durationMinutes} min
                          </p>
                        </TD>
                        <TD>
                          <PatientCell
                            appointment={appointment}
                            canViewPatientNames={data.canViewPatientNames}
                          />
                        </TD>
                        <TD className="whitespace-nowrap">{doctorName(appointment.doctor)}</TD>
                        <TD className="max-w-[16rem]">
                          <p className="truncate">
                            {appointment.service?.name ?? appointment.reason ?? 'General examination'}
                          </p>
                          {appointment.reason && appointment.service && (
                            <p className="truncate text-[11px] text-ink-400">
                              {appointment.reason}
                            </p>
                          )}
                        </TD>
                        <TD>
                          <div className="flex flex-col items-start gap-1">
                            <StatusBadge status={appointment.status} />
                            {appointment.queueStatus && (
                              <span className="text-[10px] uppercase tracking-wide text-ink-400">
                                Queue {statusLabel(appointment.queueStatus)}
                              </span>
                            )}
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
            )}
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
