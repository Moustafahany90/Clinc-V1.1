import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { formatMoney } from '../../lib/money';
import { useQuickAction } from '../../lib/useQuickAction';
import { fetchFinancialSummary } from '../../lib/quickActions';
import { DollarSign, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import {
  SectionCard,
  Stat,
} from '../../components/ui';
import { QuickActionResult, RefreshButton } from './shared';

/**
 * Action 9 — financial summary.
 * A one-line today snapshot: revenue, expenses and net. The shortest answer in
 * the Quick Actions grid, and the first number a nurse or receptionist glances
 * at after opening the clinic.
 * Visible to any role holding the FINANCE_READ permission.
 */
export function FinancialSummaryPanel() {
  const { user } = useAuth();
  const { timezone } = useClinic();

  const state = useQuickAction((signal) => fetchFinancialSummary(signal), {});

  return (
    <SectionCard
      title="Financial summary"
      description={`Today's revenue, expenses and net in ${timezone}.`}
      icon={DollarSign}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <QuickActionResult
        state={state}
        loadingLabel="Loading financial summary…"
      >
        {(data) => (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Revenue"
                value={formatMoney(data.revenueTodayMinor, data.currency)}
                hint="Collected revenue (payments minus refunds)"
                icon={TrendingUp}
                tone="success"
              />
              <Stat
                label="Expenses"
                value={formatMoney(data.expensesTodayMinor, data.currency)}
                hint="Recorded today"
                icon={TrendingDown}
                tone="danger"
              />
              <Stat
                label="Net"
                value={formatMoney(data.netMinor, data.currency)}
                hint="Revenue − expenses"
                icon={DollarSign}
                tone={
                  data.netMinor >= 0 ? 'success' : 'danger'
                }
              />
            </div>

            <div className="rounded-xl border border-line bg-surface-muted/40 p-3 text-sm text-ink-700">
              <p className="text-xs text-ink-500 mb-1">Tip</p>
              <p>
                Net income is the money that actually left the clinic today after
                refunds and spending. Use the revenue and expense panels for the
                full detail.
              </p>
            </div>
          </div>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
