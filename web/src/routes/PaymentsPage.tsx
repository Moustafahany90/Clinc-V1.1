import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import { addDays, endOfMonth, formatDateTime, startOfMonth, todayInZone } from '../lib/format';
import { formatMoney } from '../lib/money';
import type { Patient, Payment } from '../lib/types';
import { PaymentDialog, RefundDialog } from '../components/FinanceDialogs';
import { PatientSearch } from '../components/PatientSearch';
import { useToast } from '../components/toast';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface PaymentList {
  payments: Payment[];
  total: number;
  page: number;
  pageSize: number;
}

export function PaymentsPage() {
  const { hasPermission } = useAuth();
  const { currency, paymentMethods, timezone } = useClinic();
  const toast = useToast();

  const today = todayInZone(timezone);
  const [from, setFrom] = useState(startOfMonth(today));
  const [to, setTo] = useState(today);
  const [methodKey, setMethodKey] = useState('');
  const [patient, setPatient] = useState<Patient | null>(null);
  const [paymentPage, setPaymentPage] = useState(1);

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [refundTarget, setRefundTarget] = useState<{
    id: string;
    amountMinor: number;
    refundedMinor: number;
  } | null>(null);

  const paymentsState = useAsyncData<PaymentList>(
    async () => {
      const res = await api.get<PaymentList>('/payments', {
        params: {
          page: paymentPage,
          pageSize: 25,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(methodKey ? { methodKey } : {}),
          ...(patient ? { patientId: patient.id } : {}),
        },
      });
      return res.data;
    },
    [paymentPage, from, to, methodKey, patient?.id],
  );

  const activeMethods = useMemo(
    () => paymentMethods.filter((method) => method.isActive),
    [paymentMethods],
  );

  const canWrite = hasPermission('PAYMENTS_WRITE');
  const canRefund = hasPermission('REFUNDS_WRITE');
  const payments = paymentsState.data?.payments ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Payments"
        description="Record money received, track payment methods, and process refunds."
        actions={
          canWrite ? (
            <Button onClick={() => setPaymentOpen(true)}>
              <Wallet className="h-4 w-4" aria-hidden />
              Record payment
            </Button>
          ) : undefined
        }
      />

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="From">
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => {
                setFrom(event.target.value);
                setPaymentPage(1);
              }}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => {
                setTo(event.target.value);
                setPaymentPage(1);
              }}
            />
          </Field>
          <Field label="Method">
            <Select
              value={methodKey}
              onChange={(event) => {
                setMethodKey(event.target.value);
                setPaymentPage(1);
              }}
            >
              <option value="">All methods</option>
              {activeMethods.map((method) => (
                <option key={method.key} value={method.key}>
                  {method.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Patient" className="sm:col-span-2">
            {patient ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-line-strong bg-white px-3 py-2">
                <span className="min-w-0 truncate text-[13px] text-ink-800">
                  {patient.firstName} {patient.lastName}
                  <span className="ml-2 font-mono text-[11px] text-ink-400">
                    {patient.patientNumber}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPatient(null);
                    setPaymentPage(1);
                  }}
                  className="rounded p-0.5 text-ink-400 hover:text-ink-700"
                  aria-label="Clear patient filter"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : (
              <PatientSearch
                value={patient}
                onChange={(next) => {
                  setPatient(next);
                  setPaymentPage(1);
                }}
                placeholder="Filter by patient…"
              />
            )}
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
          <button
            type="button"
            className="font-medium text-brand-700 hover:text-brand-800"
            onClick={() => {
              setFrom(startOfMonth(today));
              setTo(today);
              setPaymentPage(1);
            }}
          >
            This month
          </button>
          <span>·</span>
          <button
            type="button"
            className="font-medium text-brand-700 hover:text-brand-800"
            onClick={() => {
              setFrom(addDays(today, -30));
              setTo(today);
              setPaymentPage(1);
            }}
          >
            Last 30 days
          </button>
          <span>·</span>
          <button
            type="button"
            className="font-medium text-brand-700 hover:text-brand-800"
            onClick={() => {
              const previousMonthDay = addDays(startOfMonth(today), -1);
              setFrom(startOfMonth(previousMonthDay));
              setTo(endOfMonth(previousMonthDay));
              setPaymentPage(1);
            }}
          >
            Previous month
          </button>
        </div>
      </Card>

      {paymentsState.error && <Alert tone="danger">{paymentsState.error}</Alert>}

      <Card>
        {paymentsState.loading && !paymentsState.data ? (
          <LoadingBlock label="Loading payments…" />
        ) : payments.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No payments in this period"
            description="Adjust the date range, or record a payment."
            action={
              canWrite ? (
                <Button variant="secondary" onClick={() => setPaymentOpen(true)}>
                  Record payment
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Received</TH>
                    <TH>Patient</TH>
                    <TH>Method</TH>
                    <TH>Reference</TH>
                    <TH className="text-right">Amount</TH>
                    <TH className="text-right">Refunded</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {payments.map((payment) => {
                    const refundedMinor = (payment.refunds ?? []).reduce(
                      (sum, refund) => sum + refund.amountMinor,
                      0,
                    );
                    const refundable = payment.amountMinor - refundedMinor;
                    return (
                      <TR key={payment.id}>
                        <TD className="whitespace-nowrap text-ink-600">
                          {formatDateTime(payment.receivedAt, timezone)}
                        </TD>
                        <TD>
                          {payment.patient ? (
                            <>
                              <Link
                                to={`/patients/${payment.patient.id}`}
                                className="font-medium text-ink-900 hover:text-brand-700"
                              >
                                {payment.patient.firstName} {payment.patient.lastName}
                              </Link>
                              <p className="mt-0.5 font-mono text-[11px] text-ink-400">
                                {payment.patient.patientNumber}
                              </p>
                            </>
                          ) : (
                            '—'
                          )}
                        </TD>
                        <TD className="whitespace-nowrap">
                          {payment.method?.label ?? payment.methodKey}
                        </TD>
                        <TD className="max-w-[10rem] truncate text-ink-500">
                          {payment.reference ?? '—'}
                        </TD>
                        <TD className="tabular whitespace-nowrap text-right font-medium">
                          {formatMoney(payment.amountMinor, currency)}
                        </TD>
                        <TD className="tabular whitespace-nowrap text-right text-ink-500">
                          {refundedMinor > 0 ? formatMoney(refundedMinor, currency) : '—'}
                        </TD>
                        <TD>
                          <StatusBadge status={payment.status} />
                        </TD>
                        <TD className="text-right">
                          {canRefund && payment.status === 'COMPLETED' && refundable > 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setRefundTarget({
                                  id: payment.id,
                                  amountMinor: payment.amountMinor,
                                  refundedMinor,
                                })
                              }
                            >
                              Refund
                            </Button>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
            <Pagination
              page={paymentPage}
              pageSize={paymentsState.data?.pageSize ?? 25}
              total={paymentsState.data?.total ?? 0}
              onPageChange={setPaymentPage}
            />
          </>
        )}
      </Card>

      <PaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        onSaved={() => {
          paymentsState.reload();
        }}
      />

      <RefundDialog
        open={refundTarget !== null}
        onOpenChange={(next) => !next && setRefundTarget(null)}
        payment={refundTarget}
        onSaved={() => {
          paymentsState.reload();
        }}
      />
    </div>
  );
}
