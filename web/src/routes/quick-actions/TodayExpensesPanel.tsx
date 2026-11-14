import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { formatMoney } from '../../lib/money';
import { useQuickAction } from '../../lib/useQuickAction';
import { fetchTodayExpenses } from '../../lib/quickActions';
import { PieChart, RefreshCw } from 'lucide-react';
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
 * Action 8 — today's expenses.
 * Shows the category breakdown. Row-level detail is shown only when the
 * EXPENSES_READ permission is held.
 * Requires the FINANCE_READ permission (route level); details respect
 * EXPENSES_READ (value level).
 */
export function TodayExpensesPanel() {
  const { user } = useAuth();
  const { timezone } = useClinic();
  const hasExpensesRead = user?.permissions?.includes('EXPENSES_READ');

  const state = useQuickAction((signal) => fetchTodayExpenses(signal), {});

  return (
    <SectionCard
      title="Today's expenses"
      description={`Money spent today in ${timezone}, grouped by category.`}
      icon={PieChart}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <QuickActionResult state={state} loadingLabel="Loading today's expenses…">
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Total spent"
                value={formatMoney(data.totalMinor, data.currency)}
                hint={`${data.count} recorded expense(s)`}
                icon={PieChart}
                tone="brand"
              />
              <Stat
                label="Largest category"
                value={
                  data.byCategory.length > 0
                    ? data.byCategory.reduce((a, b) =>
                        a.totalMinor >= b.totalMinor ? a : b,
                      ).name
                    : '—'
                }
                hint="Highest spend category"
                icon={PieChart}
                tone="muted"
              />
              <Stat
                label="Categories"
                value={data.byCategory.length}
                hint="Expense buckets"
                icon={PieChart}
                tone="muted"
              />
              <Stat
                label="Details"
                value={hasExpensesRead ? 'Visible' : 'Restricted'}
                hint={
                  hasExpensesRead
                    ? 'Row-level expense records'
                    : 'Requires the EXPENSES_READ permission'
                }
                icon={RefreshCw}
                tone={hasExpensesRead ? 'success' : 'muted'}
              />
            </div>

            {data.byCategory.length > 0 && (
              <SectionCard
                title="By category"
                description="Expense totals grouped by category."
                className="mt-4"
              >
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Category</TH>
                        <TH className="text-right">Amount</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data.byCategory.map((cat) => (
                        <TR key={cat.name}>
                          <TD>{cat.name}</TD>
                          <TD className="tabular font-semibold">
                            {formatMoney(cat.totalMinor, data.currency)}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              </SectionCard>
            )}

            {hasExpensesRead && data.details && data.details.length > 0 && (
              <SectionCard
                title="Expense records"
                description="Individual expense rows for today."
                className="mt-4"
              >
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Date</TH>
                        <TH>Category</TH>
                        <TH>Amount</TH>
                        <TH>Description</TH>
                        <TH>Reference</TH>
                        <TH>Method</TH>
                        <TH>Status</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data.details.map((expense) => (
                        <TR key={expense.id}>
                          <TD className="tabular">{expense.expenseDate.toISOString().slice(0, 10)}</TD>
                          <TD>{expense.category.name}</TD>
                          <TD className="tabular">
                            {formatMoney(expense.amountMinor, data.currency)}
                          </TD>
                          <TD className="max-w-[14rem]">{expense.description ?? '—'}</TD>
                          <TD className="max-w-[10rem] truncate">
                            {expense.reference ?? '—'}
                          </TD>
                          <TD>{expense.methodKey ?? '—'}</TD>
                          <TD>
                            <Badge tone="info">{expense.status}</Badge>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              </SectionCard>
            )}

            {!hasExpensesRead && data.details && data.details.length > 0 && (
              <Alert tone="info">
                Expense row details are hidden. Your account can see the category
                summary but not the individual expense records.
              </Alert>
            )}
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}

/**
 * Small helper so the panel can pass a Lucide icon as a prop value.
 */
