import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useAsyncData } from '../lib/hooks';
import { formatDateOnly, formatDateTime, todayInZone } from '../lib/format';
import { formatMoney } from '../lib/money';
import { Alert, Badge, Button, LoadingBlock } from '../components/ui';

interface StatementRow {
  date: string;
  type: 'CHARGE' | 'PAYMENT' | 'REFUND' | 'EXPENSE';
  flow: 'BILLED' | 'IN' | 'OUT';
  reference: string;
  patientNumber: string;
  patientName: string;
  description: string;
  method: string;
  amountMinor: number;
}

interface StatementData {
  clinic: {
    name: string;
    legalName: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    timezone: string;
  };
  from: string;
  to: string;
  currency: string;
  counts: {
    charges: number;
    payments: number;
    refunds: number;
    expenses: number;
  };
  totals: {
    chargesMinor: number;
    paymentsMinor: number;
    refundsMinor: number;
    expensesMinor: number;
    collectedMinor: number;
    netCashMinor: number;
  };
  rows: StatementRow[];
}

export function FinanceBillPrintPage() {
  const [searchParams] = useSearchParams();
  const today = todayInZone();
  const from = searchParams.get('from') || today;
  const to = searchParams.get('to') || today;

  const state = useAsyncData<StatementData>(
    async () =>
      (
        await api.get<StatementData>('/financial-reports/statement', {
          params: { from, to },
        })
      ).data,
    [from, to],
  );

  const data = state.data;

  useEffect(() => {
    if (!data) return;
    const previous = document.title;
    document.title = `Financial Bill · ${from} to ${to}`;
    return () => {
      document.title = previous;
    };
  }, [data, from, to]);

  if (state.loading && !data) return <LoadingBlock label="Preparing financial statement & bill…" />;

  if (state.error) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <Alert tone="danger">{state.error}</Alert>
        <Button variant="secondary" asChild>
          <Link to="/finance">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to finance
          </Link>
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const { clinic, currency, totals, counts, rows } = data;

  return (
    <div className="min-h-dvh bg-ink-100/60 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex w-[min(210mm,calc(100%-1.5rem))] flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" asChild>
            <Link to="/finance">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to finance
            </Link>
          </Button>
          <span className="text-[12px] text-ink-500">
            Statement Period: {formatDateOnly(from)} → {formatDateOnly(to)}
          </span>
        </div>
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4" aria-hidden />
          Print / Save as PDF
        </Button>
      </div>

      <article className="print-page mx-auto w-[min(210mm,calc(100%-1.5rem))] bg-white px-[15mm] py-[16mm] text-ink-900 shadow-card">
        {/* Header */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-ink-900 pb-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">{clinic.name}</h1>
            {clinic.legalName && (
              <p className="text-[12px] text-ink-600 font-medium">{clinic.legalName}</p>
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-ink-600">
              {[clinic.address, clinic.phone, clinic.email].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-brand-700">
              Financial Statement & Bill
            </p>
            <p className="text-[10.5px] text-ink-500">فاتورة وكشف حساب مالي</p>
            <p className="mt-1 text-[11px] text-ink-600">
              Period: {formatDateOnly(from)} → {formatDateOnly(to)}
            </p>
            <p className="text-[11px] text-ink-500">
              Generated: {formatDateTime(new Date().toISOString(), clinic.timezone)}
            </p>
          </div>
        </header>

        {/* Grand Total Summary Box */}
        <section className="my-5 rounded-xl border border-line bg-surface-muted/30 p-4 print-avoid-break">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                Summary of Accounts
              </p>
              <p className="text-base font-bold text-ink-900">Financial Summary & Bill Totals</p>
            </div>
            <div className="text-right">
              <span className="text-[11px] text-ink-500">Net Financial Position:</span>
              <p
                className={`text-xl font-bold tabular ${
                  totals.netCashMinor >= 0 ? 'text-brand-700' : 'text-clay-600'
                }`}
              >
                {formatMoney(totals.netCashMinor, currency)}
              </p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 text-[12px]">
            <div className="rounded-lg border border-line bg-white p-2.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-ink-500">
                Services Billed
              </p>
              <p className="tabular mt-1 text-sm font-semibold">
                {formatMoney(totals.chargesMinor, currency)}
              </p>
              <p className="text-[10px] text-ink-400">{counts.charges} billed charges</p>
            </div>
            <div className="rounded-lg border border-line bg-white p-2.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-ink-500">
                Payments Received
              </p>
              <p className="tabular mt-1 text-sm font-semibold text-brand-700">
                {formatMoney(totals.paymentsMinor, currency)}
              </p>
              <p className="text-[10px] text-ink-400">{counts.payments} payments collected</p>
            </div>
            <div className="rounded-lg border border-line bg-white p-2.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-ink-500">
                Refunds Issued
              </p>
              <p className="tabular mt-1 text-sm font-semibold text-clay-600">
                {formatMoney(totals.refundsMinor, currency)}
              </p>
              <p className="text-[10px] text-ink-400">{counts.refunds} refunds</p>
            </div>
            <div className="rounded-lg border border-line bg-white p-2.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-ink-500">
                Clinic Expenses
              </p>
              <p className="tabular mt-1 text-sm font-semibold text-ink-700">
                {formatMoney(totals.expensesMinor, currency)}
              </p>
              <p className="text-[10px] text-ink-400">{counts.expenses} recorded expenses</p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-2 text-[11px] text-ink-600">
            <div>
              <span>Net Collected (Payments - Refunds): </span>
              <strong className="text-ink-900">
                {formatMoney(totals.collectedMinor, currency)}
              </strong>
            </div>
            <div>
              <span>Grand Total Cash Balance: </span>
              <strong
                className={`text-sm ${
                  totals.netCashMinor >= 0 ? 'text-brand-700' : 'text-clay-600'
                }`}
              >
                {formatMoney(totals.netCashMinor, currency)}
              </strong>
            </div>
          </div>
        </section>

        {/* Itemized Transactions Table */}
        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight text-ink-900">
              Itemized Transactions & Bill Entries
            </h2>
            <span className="text-[11px] text-ink-500">{rows.length} total entries</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[11px]">
              <thead>
                <tr className="border-b-2 border-ink-900 text-[10px] font-semibold uppercase tracking-wider text-ink-600">
                  <th className="py-2 pr-2">Date</th>
                  <th className="py-2 px-2">Type</th>
                  <th className="py-2 px-2">Patient / Payee</th>
                  <th className="py-2 px-2">Description / Method</th>
                  <th className="py-2 pl-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-ink-500">
                      No financial transactions recorded for this period.
                    </td>
                  </tr>
                ) : (
                  rows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-ink-50/50">
                      <td className="py-2 pr-2 tabular whitespace-nowrap text-ink-600">
                        {row.date}
                      </td>
                      <td className="py-2 px-2 whitespace-nowrap">
                        <Badge
                          tone={
                            row.type === 'PAYMENT'
                              ? 'success'
                              : row.type === 'CHARGE'
                                ? 'neutral'
                                : row.type === 'REFUND'
                                  ? 'warning'
                                  : 'danger'
                          }
                        >
                          {row.type}
                        </Badge>
                      </td>
                      <td className="py-2 px-2">
                        {row.patientName ? (
                          <>
                            <span className="font-medium text-ink-900">{row.patientName}</span>
                            <span className="text-ink-400 ml-1">({row.patientNumber})</span>
                          </>
                        ) : (
                          <span className="text-ink-500">—</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-ink-700">
                        <span>{row.description}</span>
                        {row.method && (
                          <span className="ml-1.5 text-[10px] text-ink-500 font-medium">
                            [{row.method}]
                          </span>
                        )}
                      </td>
                      <td
                        className={`py-2 pl-2 text-right tabular font-semibold whitespace-nowrap ${
                          row.amountMinor >= 0 ? 'text-ink-900' : 'text-clay-600'
                        }`}
                      >
                        {row.amountMinor >= 0 ? '+' : ''}
                        {formatMoney(row.amountMinor, currency)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink-900 font-semibold text-[11.5px] text-ink-900 bg-surface-muted/20">
                  <td colSpan={3} className="py-2.5 pr-2">
                    Grand Total
                  </td>
                  <td className="py-2.5 px-2 text-right text-ink-600 font-normal">
                    Net Cash Position:
                  </td>
                  <td
                    className={`py-2.5 pl-2 text-right tabular text-sm font-bold ${
                      totals.netCashMinor >= 0 ? 'text-brand-700' : 'text-clay-600'
                    }`}
                  >
                    {formatMoney(totals.netCashMinor, currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* Signatures & Stamp block */}
        <section className="mt-12 pt-6 border-t border-line text-[11px] text-ink-600 print-avoid-break">
          <div className="grid grid-cols-2 gap-8">
            <div>
              <p className="font-semibold text-ink-800">Prepared & Reconciled By:</p>
              <div className="mt-8 border-b border-dashed border-ink-400 w-48" />
              <p className="mt-1 text-[10px] text-ink-500">Accounting / Clinic Administrator</p>
            </div>
            <div className="text-right">
              <p className="font-semibold text-ink-800">Authorized Signature & Clinic Stamp:</p>
              <div className="mt-8 border-b border-dashed border-ink-400 w-48 ml-auto" />
              <p className="mt-1 text-[10px] text-ink-500">Official Clinic Seal</p>
            </div>
          </div>
          <p className="mt-6 text-center text-[10px] text-ink-400">
            This bill statement was generated from the Clinic Management System. Amounts are in{' '}
            {currency}.
          </p>
        </section>
      </article>
    </div>
  );
}

