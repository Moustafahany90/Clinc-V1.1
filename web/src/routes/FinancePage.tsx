import { useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
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
  endOfMonth,
  formatDateOnly,
  startOfMonth,
  todayInZone,
} from '../lib/format';
import { formatMoney } from '../lib/money';
import { RangePresets } from '../components/RangePresets';
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

/** Sentinel start date for the "everything to date" export preset. */
const ALL_TIME_FROM = '2000-01-01';

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

export function FinancePage() {
  const { hasPermission } = useAuth();
  const { currency, timezone } = useClinic();
  const toast = useToast();
  const canExport = hasPermission('FINANCE_EXPORT');

  const today = todayInZone(timezone);
  const [tab, setTab] = useState('daily');
  const [dailyDate, setDailyDate] = useState(today);
  const [exportFrom, setExportFrom] = useState(startOfMonth(today));
  const [exportTo, setExportTo] = useState(today);
  const [exporting, setExporting] = useState(false);

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
                  tab === 'daily' ? dailyDate : exportFrom || today;
                const targetTo =
                  tab === 'daily' ? dailyDate : exportTo || today;
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
                </div>
              </div>
              <RangePresets
                className="mt-3"
                presets={[
                  {
                    label: 'This month to date',
                    active: exportFrom === startOfMonth(today) && exportTo === today,
                    onClick: () => {
                      setExportFrom(startOfMonth(today));
                      setExportTo(today);
                    },
                  },
                  {
                    label: 'Previous month',
                    active:
                      exportFrom === startOfMonth(addDays(startOfMonth(today), -1)) &&
                      exportTo === endOfMonth(addDays(startOfMonth(today), -1)),
                    onClick: () => {
                      const previous = addDays(startOfMonth(today), -1);
                      setExportFrom(startOfMonth(previous));
                      setExportTo(endOfMonth(previous));
                    },
                  },
                  {
                    label: 'Everything to date',
                    active: exportFrom === ALL_TIME_FROM && exportTo === today,
                    onClick: () => {
                      // The export API needs a bounded range; this sentinel
                      // covers every record a clinic could hold.
                      setExportFrom(ALL_TIME_FROM);
                      setExportTo(today);
                    },
                  },
                ]}
              />
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
                <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
                  <Badge tone="success">
                    Collected {formatMoney(preview.totals.collectedMinor, currency)}
                  </Badge>
                  <Badge tone={preview.totals.netCashMinor >= 0 ? 'brand' : 'danger'}>
                    Net cash {formatMoney(preview.totals.netCashMinor, currency)}
                  </Badge>
                </div>
              </Card>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
