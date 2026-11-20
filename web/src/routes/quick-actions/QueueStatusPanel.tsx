import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { useQuickAction } from '../../lib/useQuickAction';
import { fetchQueueStatusToday } from '../../lib/quickActions';
import { ListChecks, RefreshCw, TrendingUp } from 'lucide-react';
import {
  Alert,
  Badge,
  SectionCard,
  Stat,
} from '../../components/ui';
import { QuickActionResult, RefreshButton } from './shared';

/**
 * Action 11 — queue status today (waiting / called / inExam / done / skipped).
 * Permission: QUEUE_READ
 */
export function QueueStatusPanel() {
  const { user } = useAuth();
  const { timezone } = useClinic();

  const state = useQuickAction((signal) => fetchQueueStatusToday(signal), {});

  return (
    <SectionCard
      title="Queue status"
      description={`Today's clinic queue (${timezone}).`}
      icon={ListChecks}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <QuickActionResult state={state} loadingLabel="Loading queue status…">
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Waiting"
                value={data.waiting}
                hint={`Patients waiting for an appointment`}
                icon={ListChecks}
                tone="brand"
              />
              <Stat
                label="Called"
                value={data.called}
                hint="Patients called to the waiting room"
                icon={RefreshCw}
                tone="success"
              />
              <Stat
                label="In exam"
                value={data.inExam}
                hint="Patients in the exam room"
                icon={TrendingUp}
                tone="info"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Stat
                label="Done"
                value={data.done}
                hint="Patients who finished their visit"
                icon={TrendingUp}
                tone="success"
              />
              <Stat
                label="Skipped"
                value={data.skipped}
                hint="Patients who did not show up"
                icon={TrendingUp}
                tone="danger"
              />
            </div>

            {data.waiting === 0 && data.called === 0 && data.inExam === 0 && data.done === 0 && data.skipped === 0 && (
              <Alert tone="info">The queue is empty today.</Alert>
            )}

            {data.waiting > 0 && (
              <Alert tone="warning">
                {data.waiting} {data.waiting === 1 ? 'patient is' : 'patients are'} still waiting for
                their appointment.
              </Alert>
            )}
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
