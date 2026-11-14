import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Clock, RefreshCw, UserRound } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Field,
  LoadingBlock,
  Select,
  StatusBadge,
} from '../../components/ui';
import { formatTime, minutesToLabel } from '../../lib/format';
import type { DoctorOption, Service } from '../../lib/types';
import type { QuickActionState } from '../../lib/useQuickAction';
import type {
  QuickActionAppointment,
  QuickActionDoctor,
  QuickActionOpeningHours,
  QuickActionPatient,
  QuickActionSlot,
} from '../../lib/quickActions';
import { cn } from '../../lib/utils';

export function doctorName(doctor: QuickActionDoctor): string {
  return `Dr ${doctor.firstName} ${doctor.lastName}`;
}

export function patientName(patient: QuickActionPatient): string {
  return `${patient.firstName} ${patient.lastName}`;
}

export function RefreshButton({
  state,
  disabled,
}: {
  state: QuickActionState<unknown>;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={state.reload}
      loading={state.isLoading}
      disabled={disabled || state.isLoading}
    >
      {!state.isLoading && <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
      Refresh
    </Button>
  );
}

/** Shared loading / error / empty plumbing for every action panel. */
export function QuickActionResult<T>({
  state,
  loadingLabel = 'Retrieving live clinic data…',
  children,
}: {
  state: QuickActionState<T>;
  loadingLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (state.isLoading) return <LoadingBlock label={loadingLabel} />;
  if (state.isError) {
    return (
      <Alert tone="danger" title="Could not retrieve this information">
        {state.error ?? 'Please try again.'}
      </Alert>
    );
  }
  if (state.isIdle || !state.data) return null;
  return <>{children(state.data)}</>;
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-3">{children}</div>;
}

export function DoctorFilter({
  doctors,
  value,
  onChange,
  label = 'Doctor',
  includeAll = true,
  className = 'w-full sm:w-60',
}: {
  doctors: DoctorOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  includeAll?: boolean;
  className?: string;
}) {
  return (
    <Field label={label} className={className}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {includeAll && <option value="">All doctors</option>}
        {!includeAll && !value && <option value="">Choose a doctor</option>}
        {doctors.map((doctor) => (
          <option key={doctor.id} value={doctor.id}>
            Dr {doctor.firstName} {doctor.lastName}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function ServiceFilter({
  services,
  value,
  onChange,
  className = 'w-full sm:w-60',
}: {
  services: Service[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const active = services.filter((service) => service.isActive);
  return (
    <Field label="Service" hint="Controls the appointment length." className={className}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Clinic default</option>
        {active.map((service) => (
          <option key={service.id} value={service.id}>
            {service.name} · {service.durationMinutes} min
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Slot times are clinic-local minutes from midnight, so they never shift with
 * the viewer's machine timezone. Long lists expand inline instead of opening a
 * dialog.
 */
export function SlotChips({
  slots,
  limit = 12,
  emptyLabel = 'No open slots',
  className,
}: {
  slots: QuickActionSlot[];
  limit?: number;
  emptyLabel?: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (slots.length === 0) {
    return <p className={cn('text-[12px] text-ink-400', className)}>{emptyLabel}</p>;
  }
  const visible = expanded ? slots : slots.slice(0, limit);
  const hidden = slots.length - visible.length;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {visible.map((slot) => (
        <span
          key={slot.start}
          className="tabular rounded-lg border border-line bg-white px-2 py-1 text-[11px] font-medium text-ink-700"
        >
          {minutesToLabel(slot.minute)}
        </span>
      ))}
      {slots.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="rounded-lg border border-dashed border-line-strong px-2 py-1 text-[11px] font-medium text-brand-700 transition-colors hover:border-brand-300 hover:bg-brand-50"
        >
          {expanded ? 'Show less' : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

export function OpeningHoursText({ hours }: { hours: QuickActionOpeningHours }) {
  if (!hours.isOpen) {
    return <span className="text-[11px] text-ink-400">{hours.reason ?? 'Closed'}</span>;
  }
  return (
    <span className="tabular inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-500">
      <span>
        {minutesToLabel(hours.openMinute)} – {minutesToLabel(hours.closeMinute)}
      </span>
      {hours.breakStartMinute != null && hours.breakEndMinute != null && (
        <span className="text-ink-400">
          Break {minutesToLabel(hours.breakStartMinute)} – {minutesToLabel(hours.breakEndMinute)}
        </span>
      )}
    </span>
  );
}

export function PatientCell({
  appointment,
  canViewPatientNames,
}: {
  appointment: QuickActionAppointment;
  canViewPatientNames: boolean;
}) {
  if (!canViewPatientNames || !appointment.patient) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-400">
        <UserRound className="h-3.5 w-3.5" aria-hidden />
        Name restricted
      </span>
    );
  }
  return (
    <div className="min-w-0">
      <Link
        to={`/patients/${appointment.patient.id}`}
        className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700"
      >
        {patientName(appointment.patient)}
      </Link>
      <p className="tabular truncate text-[11px] text-ink-400">{appointment.patient.patientNumber}</p>
    </div>
  );
}

export function AppointmentLine({
  appointment,
  canViewPatientNames,
  timezone,
}: {
  appointment: QuickActionAppointment;
  canViewPatientNames: boolean;
  timezone: string;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <div className="w-[4.5rem] shrink-0">
        <p className="tabular text-[13px] font-semibold text-ink-900">
          {formatTime(appointment.startAt, timezone)}
        </p>
        <p className="tabular text-[10px] text-ink-400">
          {formatTime(appointment.endAt, timezone)}
        </p>
      </div>
      <div className="min-w-0 flex-1">
        <PatientCell appointment={appointment} canViewPatientNames={canViewPatientNames} />
        <p className="mt-0.5 truncate text-[11px] text-ink-500">
          {appointment.service?.name ?? appointment.reason ?? 'General examination'}
          {appointment.reason && appointment.service ? ` · ${appointment.reason}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {appointment.queueStatus && (
          <Badge tone="muted" dot>
            Queue {appointment.queueStatus.toLowerCase().replace('_', ' ')}
          </Badge>
        )}
        <StatusBadge status={appointment.status} />
      </div>
    </li>
  );
}

export function DurationHint({
  durationMinutes,
  slotIntervalMinutes,
}: {
  durationMinutes: number;
  slotIntervalMinutes: number;
}) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-ink-400">
      <Clock className="h-3 w-3" aria-hidden />
      {durationMinutes} min appointments · {slotIntervalMinutes} min grid
    </p>
  );
}
