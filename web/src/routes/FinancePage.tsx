import { useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CreditCard,
  Download,
  Printer,
  Receipt,
  Scale,
  Wallet,
} from 'lucide-react';
import { api, downloadCsv, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import {
  addDays,
  addMonths,
  endOfMonth,
  formatDateOnly,
  formatMonthLabel,
  startOfMonth,
  todayInZone,
} from '../lib/format';
import { formatMoney } from '../lib/money';
import { useToast } from '../components/toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Stat,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui';

interface MoneyPosition {
  chargesMinor: number;
  paymentsMinor: number;
  refundsMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  unallocatedMinor: number;
  balanceMinor: number;
}

interface DailyFigures {
  date: string;
  currency: string;
  charges: { count: number; totalMinor: number };
  payments: { count: number; totalMinor: number };
  refunds: { count: number; totalMinor: number };
  expenses: {
    count: number;
    totalMinor: number;
    byCategory: { name: string; totalMinor: number }[];
  };
  byMethod: {
    key: string;
    label: string;
    paymentsCount: number;
    paymentsMinor: number;
    refundsMinor: number;
    netMinor: number;
  }[];
  totals: { collectedMinor: number; netCashMinor: number; billedMinor: number };
  position: MoneyPosition;
}

interface MonthlyFigures {
  year: number;
  month: number;
  currency: string;
  from: string;
  to: string;
  days: {
    date: string;
    paymentsMinor: number;
    refundsMinor: number;
    expensesMinor: number;
    billedMinor: number;
    netCashMinor: number;
  }[];
  totals: {
    paymentsMinor: number;
    refundsMinor: number;
    expensesMinor: number;
    billedMinor: number;
    collectedMinor: number;
    netCashMinor: number;
  };
}

interface ExportPreview {
  from: string;
  to: string;
  currency: string;
  counts: { charges: number; payments: number; refunds: number; expenses: number };
  totals: {
    chargesMinor: number;
    paymentsMinor: number;
    refundsMinor: number;
    expensesMinor: number;
    collectedMinor: number;
    netCashMinor: number;
  };
  columns: string[];
}

function monthOptions(count = 18) {
  const today = todayInZone();
  const options: { value: string; label: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const date = addMonths(startOfMonth(today), -index);
    options.push({
      value: date.slice(0, 7),
      label: formatMonthLabel(date),
    });
  }
  return options;
}

export function FinancePage() {
  const { hasPermission } = useAuth();
  const { currency, timezone } = useClinic();
  const toast = useToast();
  const canExport = hasPermission('FINANCE_EXPORT');

  const today = todayInZone(timezone);
  const [tab, setTab] = useState('daily');
  const [dailyDate, setDailyDate] = useState(today);
  const [month, setMonth] = useState(startOfMonth(today).slice(0, 7));
  const [exportFrom, setExportFrom] = useState(startOfMonth(today));
  const [exportTo, setExportTo] = useState(today);
  const [exporting, setExporting] = useState(false);

  const months = monthOptions();
  const [exportYear, exportMonth] = month.split('-').map((part) => Number(part));

  const dailyState = useAsyncData<DailyFigures>(
    async () =>
      (
        await api.get<DailyFigures>('/financial-reports/daily', {
          params: { date: dailyDate },
        })
      ).data,
    [dailyDate],
    tab === 'daily',
  );

  const monthlyState = useAsyncData<MonthlyFigures>(
    async () =>
      (
        await api.get<MonthlyFigures>('/financial-reports/monthly', {
          params: { year: exportYear, month: exportMonth },
        })
      ).data,
    [exportYear, exportMonth],
    tab === 'monthly',
  );

  const exportState = useAsyncData<ExportPreview>(
    async () =>
      (
        await api.get<ExportPreview>('/financial-reports/accounting-export/preview', {
          params: { from: exportFrom, to: exportTo },
        })
      ).data,
    [exportFrom, exportTo],
    tab === 'export' && canExport,
  );

  async function runExport() {
    setExporting(true);
    try {
      await downloadCsv(exportFrom, exportTo);
      toast.success('Accounting export downloaded', `${exportFrom} → ${exportTo}`);
    } catch (err) {
      toast.error('Could not export the accounting data', errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  const daily = dailyState.data;
  const monthly = monthlyState.data;
  const preview = exportState.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Financial reports"
        description="Cash collected, amounts billed and clinic costs. Billed charges, payments, refunds and expenses are reported separately so nothing is double-counted."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                const targetFrom =
                  tab === 'daily'
                    ? dailyDate
                    : tab === 'monthly' && monthly
                      ? monthly.from
                      : exportFrom || today;
                const targetTo =
                  tab === 'daily'
                    ? dailyDate
                    : tab === 'monthly' && monthly
                      ? monthly.to
                      : exportTo || today;
                window.open(`/finance/print?from=${targetFrom}&to=${targetTo}`, '_blank');
              }}
            >
              <Printer className="h-4 w-4" aria-hidden />
              Export as PDF (Bill)
            </Button>
            {canExport && (
              <Button variant="secondary" onClick={() => setTab('export')}>
                <Download className="h-4 w-4" aria-hidden />
                Accounting export
              </Button>
            )}
          </div>
        }
      />

      {daily?.position && tab !== 'export' && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Outstanding from patients"
            value={formatMoney(daily.position.outstandingMinor, currency)}
            hint="Charged and not yet covered by payments"
            icon={Receipt}
            tone={daily.position.outstandingMinor > 0 ? 'warning' : 'success'}
          />
          <Stat
            label="Credit held for patients"
            value={formatMoney(daily.position.unallocatedMinor, currency)}
            hint="Deposits and unallocated payments"
            icon={CreditCard}
            tone="brand"
          />
          <Stat
            label="Collected all time"
            value={formatMoney(
              daily.position.paymentsMinor - daily.position.refundsMinor,
              currency,
            )}
            hint={`${formatMoney(daily.position.paymentsMinor, currency)} received · ${formatMoney(daily.position.refundsMinor, currency)} refunded`}
            icon={Wallet}
            tone="success"
          />
          <Stat
            label="Net patient balance"
            value={formatMoney(daily.position.balanceMinor, currency)}
            hint="Positive means credit held for patients"
            icon={Scale}
            tone="neutral"
          />
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="daily">Daily close</TabsTrigger>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
          {canExport && <TabsTrigger value="export">Accounting export</TabsTrigger>}
        </TabsList>

        <TabsContent value="daily" className="space-y-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Business date" className="w-48">
                  <Input
                    type="date"
                    value={dailyDate}
                    max={today}
                    onChange={(event) => setDailyDate(event.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap gap-2 pb-0.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setDailyDate(today)}
                    disabled={dailyDate === today}
                  >
                    Today
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setDailyDate(addDays(dailyDate, -1))}
                  >
                    Previous day
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setDailyDate(addDays(dailyDate, 1))}
                    disabled={dailyDate >= today}
                  >
                    Next day
                  </Button>
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  window.open(`/finance/print?from=${dailyDate}&to=${dailyDate}`, '_blank')
                }
              >
                <Printer className="h-3.5 w-3.5" aria-hidden />
                Export as PDF (Bill)
              </Button>
            </div>
          </Card>

          {dailyState.error && <Alert tone="danger">{dailyState.error}</Alert>}
          {dailyState.loading && !daily ? (
            <LoadingBlock label="Loading the day’s figures…" />
          ) : !daily ? null : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat
                  label="Collected"
                  value={formatMoney(daily.totals.collectedMinor, currency)}
                  hint={`${daily.payments.count} payment${daily.payments.count === 1 ? '' : 's'} · ${daily.refunds.count} refund${daily.refunds.count === 1 ? '' : 's'}`}
                  icon={ArrowUpRight}
                  tone="success"
                />
                <Stat
                  label="Billed"
                  value={formatMoney(daily.totals.billedMinor, currency)}
                  hint={`${daily.charges.count} charge${daily.charges.count === 1 ? '' : 's'} raised`}
                  icon={Receipt}
                  tone="warning"
                />
                <Stat
                  label="Net cash"
                  value={formatMoney(daily.totals.netCashMinor, currency)}
                  hint={`After ${formatMoney(daily.expenses.totalMinor, currency)} expenses`}
                  icon={daily.totals.netCashMinor >= 0 ? ArrowUpRight : ArrowDownRight}
                  tone={daily.totals.netCashMinor >= 0 ? 'brand' : 'danger'}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader
                    title="By payment method"
                    description="Money actually received, net of refunds on the same method."
                    icon={CreditCard}
                  />
                  {daily.byMethod.length === 0 ? (
                    <EmptyState icon={CreditCard} title="No payment methods configured" />
                  ) : (
                    <TableWrap>
                      <Table>
                        <THead>
                          <TR>
                            <TH>Method</TH>
                            <TH className="text-right">Payments</TH>
                            <TH className="text-right">Refunded</TH>
                            <TH className="text-right">Net</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {daily.byMethod.map((method) => (
                            <TR key={method.key}>
                              <TD>
                                {method.label}
                                <span className="ml-2 text-[11px] text-ink-400">
                                  {method.paymentsCount} payment
                                  {method.paymentsCount === 1 ? '' : 's'}
                                </span>
                              </TD>
                              <TD className="tabular whitespace-nowrap text-right">
                                {formatMoney(method.paymentsMinor, currency)}
                              </TD>
                              <TD className="tabular whitespace-nowrap text-right text-ink-500">
                                {method.refundsMinor > 0
                                  ? formatMoney(method.refundsMinor, currency)
                                  : '—'}
                              </TD>
                              <TD className="tabular whitespace-nowrap text-right font-medium">
                                {formatMoney(method.netMinor, currency)}
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    </TableWrap>
                  )}
                </Card>

                <Card>
                  <CardHeader
                    title="Expenses by category"
                    description="Clinic costs recorded on this date."
                    icon={Receipt}
                  />
                  {daily.expenses.byCategory.length === 0 ? (
                    <EmptyState
                      icon={Receipt}
                      title="No expenses recorded"
                      description="Nothing was spent on this date."
                    />
                  ) : (
                    <TableWrap>
                      <Table>
                        <THead>
                          <TR>
                            <TH>Category</TH>
                            <TH className="text-right">Amount</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {daily.expenses.byCategory.map((category) => (
                            <TR key={category.name}>
                              <TD>{category.name}</TD>
                              <TD className="tabular whitespace-nowrap text-right font-medium">
                                {formatMoney(category.totalMinor, currency)}
                              </TD>
                            </TR>
                          ))}
                          <TR>
                            <TD className="font-medium text-ink-800">Total</TD>
                            <TD className="tabular whitespace-nowrap text-right font-semibold">
                              {formatMoney(daily.expenses.totalMinor, currency)}
                            </TD>
                          </TR>
                        </TBody>
                      </Table>
                    </TableWrap>
                  )}
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="monthly" className="space-y-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Month" className="w-56">
                  <Select value={month} onChange={(event) => setMonth(event.target.value)}>
                    {months.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <p className="pb-2 text-[12px] text-ink-500">
                  {monthly
                    ? `${formatDateOnly(monthly.from)} → ${formatDateOnly(monthly.to)}`
                    : 'Loading period…'}
                </p>
              </div>
              {monthly && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    window.open(`/finance/print?from=${monthly.from}&to=${monthly.to}`, '_blank')
                  }
                >
                  <Printer className="h-3.5 w-3.5" aria-hidden />
                  Export as PDF (Bill)
                </Button>
              )}
            </div>
          </Card>

          {monthlyState.error && <Alert tone="danger">{monthlyState.error}</Alert>}
          {monthlyState.loading && !monthly ? (
            <LoadingBlock label="Loading the month’s figures…" />
          ) : !monthly ? null : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Stat
                  label="Collected"
                  value={formatMoney(monthly.totals.collectedMinor, currency)}
                  hint={`${formatMoney(monthly.totals.paymentsMinor, currency)} received`}
                  icon={ArrowUpRight}
                  tone="success"
                />
                <Stat
                  label="Refunds"
                  value={formatMoney(monthly.totals.refundsMinor, currency)}
                  icon={ArrowDownRight}
                  tone={monthly.totals.refundsMinor > 0 ? 'danger' : 'neutral'}
                />
                <Stat
                  label="Billed"
                  value={formatMoney(monthly.totals.billedMinor, currency)}
                  icon={Receipt}
                  tone="warning"
                />
                <Stat
                  label="Net cash"
                  value={formatMoney(monthly.totals.netCashMinor, currency)}
                  hint={`After ${formatMoney(monthly.totals.expensesMinor, currency)} expenses`}
                  icon={BarChart3}
                  tone={monthly.totals.netCashMinor >= 0 ? 'brand' : 'danger'}
                />
              </div>

              <Card>
                <CardHeader
                  title="Day by day"
                  description="Only days with activity are listed. Cash figures exclude unpaid charges."
                  icon={BarChart3}
                />
                {monthly.days.length === 0 ? (
                  <EmptyState
                    icon={BarChart3}
                    title="No activity this month"
                    description="Payments, charges and expenses will appear here."
                  />
                ) : (
                  <TableWrap>
                    <Table>
                      <THead>
                        <TR>
                          <TH>Date</TH>
                          <TH className="text-right">Billed</TH>
                          <TH className="text-right">Payments</TH>
                          <TH className="text-right">Refunds</TH>
                          <TH className="text-right">Expenses</TH>
                          <TH className="text-right">Net cash</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {monthly.days.map((day) => (
                          <TR key={day.date}>
                            <TD className="whitespace-nowrap text-ink-700">
                              {formatDateOnly(day.date)}
                            </TD>
                            <TD className="tabular whitespace-nowrap text-right text-ink-500">
                              {formatMoney(day.billedMinor, currency)}
                            </TD>
                            <TD className="tabular whitespace-nowrap text-right">
                              {formatMoney(day.paymentsMinor, currency)}
                            </TD>
                            <TD className="tabular whitespace-nowrap text-right text-ink-500">
                              {day.refundsMinor > 0 ? formatMoney(day.refundsMinor, currency) : '—'}
                            </TD>
                            <TD className="tabular whitespace-nowrap text-right text-ink-500">
                              {day.expensesMinor > 0
                                ? formatMoney(day.expensesMinor, currency)
                                : '—'}
                            </TD>
                            <TD
                              className={`tabular whitespace-nowrap text-right font-medium ${
                                day.netCashMinor < 0 ? 'text-clay-700' : ''
                              }`}
                            >
                              {formatMoney(day.netCashMinor, currency)}
                            </TD>
                          </TR>
                        ))}
                        <TR>
                          <TD className="font-semibold text-ink-900">Month total</TD>
                          <TD className="tabular whitespace-nowrap text-right font-semibold">
                            {formatMoney(monthly.totals.billedMinor, currency)}
                          </TD>
                          <TD className="tabular whitespace-nowrap text-right font-semibold">
                            {formatMoney(monthly.totals.paymentsMinor, currency)}
                          </TD>
                          <TD className="tabular whitespace-nowrap text-right font-semibold">
                            {formatMoney(monthly.totals.refundsMinor, currency)}
                          </TD>
                          <TD className="tabular whitespace-nowrap text-right font-semibold">
                            {formatMoney(monthly.totals.expensesMinor, currency)}
                          </TD>
                          <TD className="tabular whitespace-nowrap text-right font-semibold">
                            {formatMoney(monthly.totals.netCashMinor, currency)}
                          </TD>
                        </TR>
                      </TBody>
                    </Table>
                  </TableWrap>
                )}
              </Card>
            </>
          )}
        </TabsContent>

        {canExport && (
          <TabsContent value="export" className="space-y-4">
            <Card className="p-4">
              <div className="grid gap-3 sm:grid-cols-[repeat(2,minmax(0,12rem))_auto] sm:items-end">
                <Field label="From">
                  <Input
                    type="date"
                    value={exportFrom}
                    max={exportTo || undefined}
                    onChange={(event) => setExportFrom(event.target.value)}
                  />
                </Field>
                <Field label="To">
                  <Input
                    type="date"
                    value={exportTo}
                    min={exportFrom || undefined}
                    max={today}
                    onChange={(event) => setExportTo(event.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void runExport()}
                    loading={exporting}
                    disabled={!exportFrom || !exportTo}
                  >
                    <Download className="h-4 w-4" aria-hidden />
                    Download CSV
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!exportFrom || !exportTo}
                    onClick={() =>
                      window.open(`/finance/print?from=${exportFrom}&to=${exportTo}`, '_blank')
                    }
                  >
                    <Printer className="h-4 w-4" aria-hidden />
                    Export as PDF (Bill)
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <button
                  type="button"
                  className="font-medium text-brand-700 hover:text-brand-800"
                  onClick={() => {
                    setExportFrom(startOfMonth(today));
                    setExportTo(today);
                  }}
                >
                  This month to date
                </button>
                <span className="text-ink-300">·</span>
                <button
                  type="button"
                  className="font-medium text-brand-700 hover:text-brand-800"
                  onClick={() => {
                    const previous = addDays(startOfMonth(today), -1);
                    setExportFrom(startOfMonth(previous));
                    setExportTo(endOfMonth(previous));
                  }}
                >
                  Previous month
                </button>
                <span className="text-ink-300">·</span>
                <button
                  type="button"
                  className="font-medium text-brand-700 hover:text-brand-800"
                  onClick={() => {
                    setExportFrom('');
                    setExportTo(today);
                  }}
                >
                  Everything to date
                </button>
              </div>
            </Card>

            <Alert tone="info" title="What the export contains">
              One row per charge, payment, refund and expense. Amounts are in piasters
              (<code className="rounded bg-white/60 px-1">amount_minor</code>) with the currency
              alongside, so totals can be reconciled without rounding. Patient clinical data is never
              included.
            </Alert>

            {exportState.error && <Alert tone="danger">{exportState.error}</Alert>}
            {exportState.loading && !preview ? (
              <LoadingBlock label="Preparing the export preview…" />
            ) : !preview ? null : (
              <Card>
                <CardHeader
                  title="Export preview"
                  description={`${formatDateOnly(preview.from)} → ${formatDateOnly(preview.to)}`}
                  icon={Download}
                />
                <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-line p-3">
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Charges</p>
                    <p className="tabular mt-1 text-lg font-semibold">
                      {formatMoney(preview.totals.chargesMinor, currency)}
                    </p>
                    <p className="text-[11px] text-ink-400">{preview.counts.charges} rows</p>
                  </div>
                  <div className="rounded-xl border border-line p-3">
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Payments</p>
                    <p className="tabular mt-1 text-lg font-semibold">
                      {formatMoney(preview.totals.paymentsMinor, currency)}
                    </p>
                    <p className="text-[11px] text-ink-400">{preview.counts.payments} rows</p>
                  </div>
                  <div className="rounded-xl border border-line p-3">
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Refunds</p>
                    <p className="tabular mt-1 text-lg font-semibold">
                      {formatMoney(preview.totals.refundsMinor, currency)}
                    </p>
                    <p className="text-[11px] text-ink-400">{preview.counts.refunds} rows</p>
                  </div>
                  <div className="rounded-xl border border-line p-3">
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Expenses</p>
                    <p className="tabular mt-1 text-lg font-semibold">
                      {formatMoney(preview.totals.expensesMinor, currency)}
                    </p>
                    <p className="text-[11px] text-ink-400">{preview.counts.expenses} rows</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="success">
                      Collected {formatMoney(preview.totals.collectedMinor, currency)}
                    </Badge>
                    <Badge tone={preview.totals.netCashMinor >= 0 ? 'brand' : 'danger'}>
                      Net cash {formatMoney(preview.totals.netCashMinor, currency)}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        window.open(
                          `/finance/print?from=${preview.from}&to=${preview.to}`,
                          '_blank',
                        )
                      }
                    >
                      <Printer className="h-3.5 w-3.5" aria-hidden />
                      Export as PDF (Bill)
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void runExport()}
                      loading={exporting}
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden />
                      Download CSV
                    </Button>
                  </div>
                </div>
              </Card>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
