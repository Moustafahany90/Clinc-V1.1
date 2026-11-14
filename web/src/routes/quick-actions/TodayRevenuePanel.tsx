import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { formatMoney } from '../../lib/money';
import { useQuickAction } from '../../lib/useQuickAction';
import { fetchTodayRevenue } from '../../lib/quickActions';
import { DollarSign, RefreshCw, TrendingUp } from 'lucide-react';
import {
  Alert,
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
 * Action 6 — today's revenue.
 * Collected revenue = payments minus refunds, per payment method.
 * Visible to any role holding the FINANCE_READ permission.
 */
export function TodayRevenuePanel() {
  const { user } = useAuth();
  const { timezone } = useClinic();
  const hasExpensesRead = user?.permissions?.includes('EXPENSES_READ');

  const state = useQuickAction((signal) => fetchTodayRevenue(signal), {});

  return (
    <SectionCard
      title="Today's revenue"
      description={`Net revenue collected today (${timezone}), after refunds.`}
      icon={TrendingUp}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <QuickActionResult state={state} loadingLabel="Loading today's revenue…">
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Net revenue"
                value={formatMoney(data.totalRevenueMinor, data.currency)}
                hint={`Refunds: ${formatMoney(data.refundsMinor, data.currency)}`}
                icon={TrendingUp}
                tone="brand"
              />
              <Stat
                label="Payments"
                value={data.paymentsCount}
                hint={`${formatMoney(data.paymentsTotalMinor, data.currency)} in`}
                icon={DollarSign}
              />
              <Stat
                label="Refunds"
                value={formatMoney(data.refundsMinor, data.currency)}
                hint="Reversed today"
                icon={RefreshCw}
                tone="muted"
              />
              <Stat
                label="Coverage"
                value={data.byMethod.length}
                hint="Payment methods in use"
                icon={DollarSign}
              />
            </div>

            {data.byMethod.length > 0 && (
              <SectionCard
                title="Net movement by method"
                description="Payments minus refunds, by payment method."
                className="mt-4"
              >
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Method</TH>
                        <TH className="text-right">Payments</TH>
                        <TH className="text-right">Refunds</TH>
                        <TH className="text-right">Net</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data.byMethod.map((row) => (
                        <TR key={row.key}>
                          <TD>{row.label}</TD>
                          <TD className="tabular">{row.paymentsCount}</TD>
                          <TD className="tabular">
                            {formatMoney(row.refundsMinor, data.currency)}
                          </TD>
                          <TD className="tabular font-semibold">
                            <Badge
                              tone={
                                row.netMinor >= 0 ? 'success' : 'danger'
                              }
                            >
                              {formatMoney(row.netMinor, data.currency)}
                            </Badge>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              </SectionCard>
            )}

            {!hasExpensesRead && (
              <Alert tone="info">
                Your account can read revenue totals. Expense row details require the
                “EXPENSES_READ” permission.
              </Alert>
            )}
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
