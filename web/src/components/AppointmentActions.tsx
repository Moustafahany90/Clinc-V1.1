import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Check, ChevronDown, LogIn, MoreVertical, Stethoscope, UserX, XCircle } from 'lucide-react';
import { api, toApiFailure } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Appointment } from '../lib/types';
import { AppointmentDialog } from './AppointmentDialog';
import { ReasonDialog } from './dialogs';
import { useToast } from './toast';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui';

const TERMINAL = new Set(['DONE', 'CANCELLED', 'NO_SHOW']);

/**
 * Status controls shared by the agenda, patient record and dashboard. The
 * server remains the authority on which transitions are legal.
 */
export function AppointmentActions({
  appointment,
  onChanged,
  size = 'sm',
}: {
  appointment: Appointment;
  onChanged?: (appointment?: Appointment) => void;
  size?: 'sm' | 'md';
}) {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [reasonAction, setReasonAction] = useState<'CANCELLED' | 'NO_SHOW' | 'DONE' | null>(null);
  const [busy, setBusy] = useState(false);

  const canWriteAppointments = hasPermission('APPOINTMENTS_WRITE');
  const canOverrideAppointments = hasPermission('APPOINTMENTS_OVERRIDE');
  const canWriteClinical = hasPermission('CLINICAL_WRITE');
  const terminal = TERMINAL.has(appointment.status);
  const clinicalStepsComplete = appointment.visit?.status === 'COMPLETED';
  const canComplete = canWriteAppointments && (clinicalStepsComplete || canOverrideAppointments);

  async function changeStatus(status: string, reason?: string, overrideReason?: string) {
    setBusy(true);
    try {
      const res = await api.post<{ appointment: Appointment }>(`/appointments/${appointment.id}/status`, {
        status,
        ...(reason ? { reason } : {}),
        ...(overrideReason ? { overrideReason } : {}),
      });
      toast.success('Appointment updated', `Now ${status.toLowerCase().replace('_', ' ')}.`);
      onChanged?.(res.data.appointment);
      return true;
    } catch (err) {
      const failure = toApiFailure(err);
      if (status === 'DONE' && !overrideReason) {
        const details = failure.details as { requiresOverride?: boolean } | undefined;
        if (details?.requiresOverride) {
          setReasonAction('DONE');
          toast.info('Clinical steps are incomplete', 'Provide an override reason to complete anyway.');
          return false;
        }
      }
      toast.error('Could not update the appointment', failure.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function startVisit() {
    if (appointment.visit) {
      navigate(`/visits/${appointment.visit.id}`);
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ visit: { id: string } }>('/visits', {
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        doctorId: appointment.doctorId,
      });
      toast.success('Visit started');
      onChanged?.();
      navigate(`/visits/${res.data.visit.id}`);
    } catch (err) {
      toast.error('Could not start the visit', toApiFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size={size === 'sm' ? 'sm' : 'md'}
            loading={busy}
            aria-label="Appointment actions"
          >
            Actions
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuLabel>Appointment</DropdownMenuLabel>
          {appointment.status === 'BOOKED' && canWriteAppointments && (
            <DropdownMenuItem onSelect={() => void changeStatus('CONFIRMED')}>
              <Check className="h-4 w-4" aria-hidden />
              Confirm booking
            </DropdownMenuItem>
          )}
          {['BOOKED', 'CONFIRMED'].includes(appointment.status) && canWriteAppointments && (
            <DropdownMenuItem onSelect={() => void changeStatus('ARRIVED')}>
              <LogIn className="h-4 w-4" aria-hidden />
              Mark arrived
            </DropdownMenuItem>
          )}
          {['ARRIVED', 'WAITING', 'IN_EXAM'].includes(appointment.status) && canWriteClinical && (
            <DropdownMenuItem onSelect={() => void startVisit()}>
              <Stethoscope className="h-4 w-4" aria-hidden />
              {appointment.visit ? 'Open visit' : 'Start visit'}
            </DropdownMenuItem>
          )}
          {appointment.status === 'REPORT_REVIEW' && canComplete && (
            <DropdownMenuItem onSelect={() => void changeStatus('DONE')}>
              <Check className="h-4 w-4" aria-hidden />
              Mark complete
            </DropdownMenuItem>
          )}
          {appointment.status === 'REPORT_REVIEW' && canWriteAppointments && !canComplete && (
            <DropdownMenuItem disabled>
              <Check className="h-4 w-4" aria-hidden />
              Completion needs an administrator override
            </DropdownMenuItem>
          )}
          {!terminal && canWriteAppointments && (
            <>
              <DropdownMenuItem onSelect={() => setRescheduleOpen(true)}>
                <CalendarClock className="h-4 w-4" aria-hidden />
                Reschedule
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setReasonAction('CANCELLED')}>
                <XCircle className="h-4 w-4" aria-hidden />
                Cancel appointment
              </DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={() => setReasonAction('NO_SHOW')}>
                <UserX className="h-4 w-4" aria-hidden />
                Mark no-show
              </DropdownMenuItem>
            </>
          )}
          {terminal && (
            <DropdownMenuItem disabled>
              <MoreVertical className="h-4 w-4" aria-hidden />
              No further changes
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AppointmentDialog
        open={rescheduleOpen}
        onOpenChange={setRescheduleOpen}
        appointment={appointment}
        onSaved={(saved) => onChanged?.(saved)}
      />

      <ReasonDialog
        open={reasonAction !== null}
        onOpenChange={(next) => !next && setReasonAction(null)}
        title={
          reasonAction === 'CANCELLED'
            ? 'Cancel appointment'
            : reasonAction === 'NO_SHOW'
              ? 'Record a no-show'
              : 'Complete with an override'
        }
        description={
          reasonAction === 'CANCELLED'
            ? 'The patient will be notified if messaging is configured. The reason is kept in the audit trail.'
            : reasonAction === 'NO_SHOW'
              ? 'The patient did not attend. Record why this is being marked as a no-show.'
              : 'The visit or report is not complete. Explain why the appointment is being closed anyway.'
        }
        label="Reason"
        confirmLabel={
          reasonAction === 'CANCELLED'
            ? 'Cancel appointment'
            : reasonAction === 'NO_SHOW'
              ? 'Mark no-show'
              : 'Complete anyway'
        }
        tone={reasonAction === 'DONE' ? 'warning' : 'danger'}
        busy={busy}
        onConfirm={(reason) => {
          if (!reasonAction) return;
          const action = reasonAction;
          void changeStatus(action, reason, action === 'DONE' ? reason : undefined).then((ok) => {
            if (ok) setReasonAction(null);
          });
        }}
      />
    </>
  );
}
