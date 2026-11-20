import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { useQuickAction } from '../../lib/useQuickAction';
import { fetchPatientsServedToday } from '../../lib/quickActions';
import { Users, TrendingUp } from 'lucide-react';
import {
  Alert,
  SectionCard,
  Stat,
} from '../../components/ui';
import { QuickActionResult, RefreshButton } from './shared';

/**
 * Action 12 — patients served today (distinct patients).
 * Permission: PATIENTS_READ
 */
export function PatientsServedPanel() {
  const { user } = useAuth();
  const { timezone } = useClinic();

  const state = useQuickAction((signal) => fetchPatientsServedToday(signal), {});

  return (
    <SectionCard
      title="Patients served today"
      description={`Distinct patients who had appointments today (${timezone}).`}
      icon={Users}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <QuickActionResult state={state} loadingLabel="Loading patients served…">
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat
                label="Patients served"
                value={data.total}
                hint={`Unique patients with appointments today`}
                icon={Users}
                tone="brand"
              />
              <Stat
                label="Today"
                value={data.total}
                hint={`All visible patient counts are clinic-wide`}
                icon={TrendingUp}
                tone="muted"
              />
            </div>

            {data.total === 0 && (
              <Alert tone="info">No patients were seen today so far.</Alert>
            )}

            {data.total > 0 && (
              <div className="rounded-xl border border-line bg-surface-muted/40 p-3 text-sm text-ink-700">
                <p className="text-xs text-ink-500 mb-1">Note</p>
                <p>
                  This panel counts distinct patients with appointments today, not
                  the total number of visits. One patient with multiple appointments
                  is counted once.
                </p>
              </div>
            )}
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
