import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { formatDateOnly } from '../../lib/format';
import { formatMoney } from '../../lib/money';
import { useQuickAction } from '../../lib/useQuickAction';
import { fetchWeeklyRevenue } from '../../lib/quickActions';
import { CalendarRange, RefreshCw, DollarSign } from 'lucide-react';
import {
  Badge,
  SectionCard,
  Stat,
  Table,
  TableWrap,
  TH,
  THead,
  TR,
  TBody,
  TD,
} from '../../components/ui';
import { QuickActionResult, RefreshButton } from './shared';

/**
 * Action 7 — weekly revenue.
 * The clinic week runs Saturday (start) → Friday (end), matching the server's
 * Saturday-start week. Defaults to the current week.
 * Visible to any role holding the FINANCE_READ permission.
 */
export function WeeklyRevenuePanel() {
  const { user } = useAuth();
  const { timezone } = useClinic();

  const state = useQuickAction(
    (signal) => fetchWeeklyRevenue({}, signal),
    {},
  );

  return (
    <SectionCard
      title="Weekly revenue"
      description="Saturday → Friday, clinic timezone."
      icon={CalendarRange}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <QuickActionResult state={state} loadingLabel="Loading this week's revenue…">
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Week"
                value={`${formatDateOnly(data.weekStart)} → ${formatDateOnly(data.weekEnd)}`}
                hint={`${data.timezone}`}
                icon={CalendarRange}
                tone="brand"
              />
              <Stat
                label="Net revenue"
                value={formatMoney(data.totalRevenueMinor, data.currency)}
                hint={`${data.days.length} days`}
                icon={DollarSign}
              />
              <Stat
                label="Payments"
                value={data.totalPaymentsCount}
                hint={formatMoney(data.totalPaymentsMinor, data.currency)}
                icon={DollarSign}
              />
              <Stat
                label="Refunds"
                value={formatMoney(data.totalRefundsMinor, data.currency)}
                hint="Reversed this week"
                icon={RefreshCw}
                tone="muted"
              />
            </div>

            {data.days.length > 0 && (
              <SectionCard
                title="Day-by-day"
                description="Revenue collected per clinic day (net of refunds)."
                className="mt-4"
              >
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Date</TH>
                        <TH className="text-right">Revenue</TH>
                        <TH className="text-right">Payments</TH>
                        <TH className="text-right">Refunds</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data.days.map((day) => (
                        <TR key={day.date}>
                          <TD>
                            <span className="text-[11px] text-ink-500">
                              {formatDateOnly(day.date)}
                            </span>
                          </TD>
                          <TD className="tabular text-right">
                            {formatMoney(day.revenueMinor, data.currency)}
                          </TD>
                          <TD className="tabular text-right">{day.paymentsCount}</TD>
                          <TD className="tabular text-right">
                            {formatMoney(day.refundsMinor, data.currency)}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              </SectionCard>
            )}
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
