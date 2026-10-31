import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CalendarPlus,
  ClipboardList,
  CreditCard,
  FileText,
  Pencil,
  Phone,
  Plus,
  Receipt,
  Stethoscope,
  UserRound,
  Wallet,
  XCircle,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import { ageFromDob, dateOnlyInZone, formatDateOnly, formatDateTime, formatTime } from '../lib/format';
import { formatMoney } from '../lib/money';
import type { Appointment, Ledger, Patient, Visit } from '../lib/types';
import { AppointmentActions } from '../components/AppointmentActions';
import { AppointmentDialog } from '../components/AppointmentDialog';
import { ChargeDialog, PaymentDialog, RefundDialog } from '../components/FinanceDialogs';
import { NewVisitDialog } from '../components/NewVisitDialog';
import { PatientDialog } from '../components/PatientDialog';
import { ReasonDialog } from '../components/dialogs';
import { useToast } from '../components/toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  KeyValue,
  LoadingBlock,
  PageHeader,
  Stat,
  StatusBadge,
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

const APPOINTMENT_HISTORY_LIMIT = 200;

export function PatientDetailPage() {
  const { id = '' } = useParams();
  const { hasPermission } = useAuth();
  const { currency, timezone } = useClinic();
  const navigate = useNavigate();
  const toast = useToast();

  const [editOpen, setEditOpen] = useState(false);
  const [appointmentOpen, setAppointmentOpen] = useState(false);
  const [visitOpen, setVisitOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [refundTarget, setRefundTarget] = useState<{
    id: string;
    amountMinor: number;
    refundedMinor: number;
  } | null>(null);
  const [voidTarget, setVoidTarget] = useState<Ledger['charges'][number] | null>(null);
  const [busy, setBusy] = useState(false);

  const clinical = hasPermission('CLINICAL_READ');
  const billing = hasPermission('PAYMENTS_READ') || hasPermission('FINANCE_READ');
  const hasValidId = Boolean(id && id !== 'undefined' && id !== 'null');

  const patientState = useAsyncData<{ patient: Patient }>(
    async () => (await api.get<{ patient: Patient }>(`/patients/${id}`)).data,
    [id],
    hasValidId,
  );

  const appointmentsState = useAsyncData<{ appointments: Appointment[] }>(
    async () =>
      (
        await api.get<{ appointments: Appointment[] }>('/appointments', {
          params: { patientId: id, limit: APPOINTMENT_HISTORY_LIMIT },
        })
      ).data,
    [id],
    hasValidId,
  );

  const visitsState = useAsyncData<{ visits: Visit[] }>(
    async () =>
      (
        await api.get<{ visits: Visit[] }>('/visits', {
          params: { patientId: id, pageSize: 50 },
        })
      ).data,
    [id],
    hasValidId && clinical,
  );

  const ledgerState = useAsyncData<Ledger>(
    async () => (await api.get<Ledger>(`/patients/${id}/ledger`)).data,
    [id],
    hasValidId && billing,
  );

  const patient = patientState.data?.patient ?? null;
  const appointments = appointmentsState.data?.appointments ?? [];
  const visits = visitsState.data?.visits ?? [];
  const ledger = ledgerState.data;

  async function voidCharge(reason: string) {
    if (!voidTarget) return;
    setBusy(true);
    try {
      await api.post(`/payments/charges/${voidTarget.id}/void`, { reason });
      toast.success('Charge voided');
      setVoidTarget(null);
      ledgerState.reload();
    } catch (err) {
      toast.error('Could not void the charge', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function reloadAll() {
    patientState.reload();
    appointmentsState.reload();
    if (clinical) visitsState.reload();
    if (billing) ledgerState.reload();
  }

  if (patientState.loading && !patient) return <LoadingBlock label="Loading patient record…" />;

  if (patientState.error) {
    return (
      <div className="space-y-4">
        <Alert tone="danger">{patientState.error}</Alert>
        <Button variant="secondary" asChild>
          <Link to="/patients">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to patients
          </Link>
        </Button>
      </div>
    );
  }

  if (!patient) return null;

  const upcoming = appointments.filter(
    (item) => !['DONE', 'CANCELLED', 'NO_SHOW'].includes(item.status),
  );
  const drafts = visits.filter((visit) => visit.status !== 'COMPLETED');

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={patient.patientNumber}
        title={`${patient.firstName} ${patient.lastName}`}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{patient.phone ?? 'No phone number'}</span>
            {patient.dateOfBirth && <span>· {formatDateOnly(patient.dateOfBirth)}</span>}
            {patient.dateOfBirth && <span>· {ageFromDob(patient.dateOfBirth)}</span>}
            {patient.email && <span>· {patient.email}</span>}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link to="/patients">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Patients
              </Link>
            </Button>
            {hasPermission('PATIENTS_WRITE') && (
              <Button variant="secondary" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Button>
            )}
            {hasPermission('APPOINTMENTS_WRITE') && (
              <Button onClick={() => setAppointmentOpen(true)}>
                <CalendarPlus className="h-4 w-4" aria-hidden />
                Book appointment
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {!patient.isActive && <Badge tone="danger">Inactive patient</Badge>}
        {patient.gender && <Badge tone="muted">{patient.gender.toLowerCase()}</Badge>}
        {patient.nationalId && <Badge tone="muted">ID {patient.nationalId}</Badge>}
        <Badge tone="brand">{appointments.length} appointments</Badge>
        {clinical && <Badge tone="info">{visits.length} visits</Badge>}
        {billing && ledger && (
          <Badge tone={ledger.summary.outstandingMinor > 0 ? 'warning' : 'success'}>
            {formatMoney(ledger.summary.outstandingMinor, currency)} outstanding
          </Badge>
        )}
      </div>

      <Tabs defaultValue="overview" className="space-y-0">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="appointments">Appointments</TabsTrigger>
          {clinical && <TabsTrigger value="clinical">Clinical</TabsTrigger>}
          {billing && <TabsTrigger value="billing">Billing</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <Card>
              <CardHeader title="Patient details" icon={UserRound} />
              <div className="grid gap-5 px-5 py-4 sm:grid-cols-2">
                <KeyValue label="Patient number">{patient.patientNumber}</KeyValue>
                <KeyValue label="Registered">
                  {formatDateTime(patient.createdAt, timezone)}
                </KeyValue>
                <KeyValue label="Phone">
                  {patient.phone ? (
                    <a
                      href={`tel:${patient.phone}`}
                      className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                    >
                      <Phone className="h-3 w-3" aria-hidden />
                      {patient.phone}
                    </a>
                  ) : (
                    '—'
                  )}
                </KeyValue>
                <KeyValue label="Email">{patient.email ?? '—'}</KeyValue>
                <KeyValue label="Date of birth">
                  {formatDateOnly(patient.dateOfBirth)}
                  {patient.dateOfBirth ? ` · ${ageFromDob(patient.dateOfBirth)}` : ''}
                </KeyValue>
                <KeyValue label="Gender">{patient.gender ?? '—'}</KeyValue>
                <KeyValue label="National / ID number">{patient.nationalId ?? '—'}</KeyValue>
                <KeyValue label="Address">{patient.address ?? '—'}</KeyValue>
                <KeyValue label="Notes" className="sm:col-span-2">
                  <span className="whitespace-pre-wrap font-normal text-ink-700">
                    {patient.notes ?? '—'}
                  </span>
                </KeyValue>
              </div>
            </Card>

            <div className="space-y-4">
              <Stat
                label="Upcoming appointments"
                value={upcoming.length}
                hint={upcoming[0] ? `Next ${formatDateTime(upcoming[0].startAt, timezone)}` : 'Nothing booked'}
                icon={ClipboardList}
                tone="brand"
              />
              {clinical && (
                <Stat
                  label="Open visits"
                  value={drafts.length}
                  hint={drafts.length > 0 ? 'Draft or in review' : 'All visits completed'}
                  icon={Stethoscope}
                  tone="info"
                />
              )}
              {billing && ledger && (
                <>
                  <Stat
                    label="Outstanding balance"
                    value={formatMoney(ledger.summary.outstandingMinor, currency)}
                    hint="Charges not yet covered by payments"
                    icon={Wallet}
                    tone={ledger.summary.outstandingMinor > 0 ? 'warning' : 'success'}
                  />
                  <Stat
                    label="Credit held"
                    value={formatMoney(ledger.summary.unallocatedMinor, currency)}
                    hint="Payments/deposits not yet allocated"
                    icon={CreditCard}
                    tone="neutral"
                  />
                </>
              )}
            </div>
          </div>

          {appointmentsState.error && <Alert tone="danger">{appointmentsState.error}</Alert>}
        </TabsContent>

        <TabsContent value="appointments" className="space-y-4">
          <Card>
            <CardHeader
              title="Appointment history"
              description="All bookings for this patient, newest scheduling actions included."
              icon={ClipboardList}
              action={
                hasPermission('APPOINTMENTS_WRITE') ? (
                  <Button size="sm" onClick={() => setAppointmentOpen(true)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Book
                  </Button>
                ) : undefined
              }
            />
            {appointmentsState.loading && !appointmentsState.data ? (
              <LoadingBlock label="Loading appointments…" />
            ) : appointments.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No appointments yet"
                description="Book the first appointment for this patient."
                action={
                  hasPermission('APPOINTMENTS_WRITE') ? (
                    <Button variant="secondary" onClick={() => setAppointmentOpen(true)}>
                      Book appointment
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <TableWrap>
                <Table>
                  <THead>
                    <TR>
                      <TH>When</TH>
                      <TH>Doctor</TH>
                      <TH>Service</TH>
                      <TH>Status</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {appointments.map((appointment) => (
                      <TR key={appointment.id}>
                        <TD className="whitespace-nowrap">
                          <p className="font-medium text-ink-800">
                            {formatDateOnly(dateOnlyInZone(appointment.startAt, timezone))}
                          </p>
                          <p className="text-[11px] text-ink-400">
                            {formatTime(appointment.startAt, timezone)} –{' '}
                            {formatTime(appointment.endAt, timezone)}
                          </p>
                        </TD>
                        <TD className="whitespace-nowrap">
                          {appointment.doctor
                            ? `Dr ${appointment.doctor.firstName} ${appointment.doctor.lastName}`
                            : '—'}
                        </TD>
                        <TD>
                          {appointment.service?.name ?? '—'}
                          {appointment.reason && (
                            <p className="mt-0.5 text-[11px] text-ink-400">{appointment.reason}</p>
                          )}
                        </TD>
                        <TD>
                          <StatusBadge status={appointment.status} />
                          {appointment.isManualOverride && (
                            <p className="mt-0.5 text-[10px] uppercase tracking-wide text-amber-ink">
                              outside hours
                            </p>
                          )}
                        </TD>
                        <TD>
                          <div className="flex justify-end gap-1.5">
                            {appointment.visit && clinical && (
                              <Button size="sm" variant="ghost" asChild>
                                <Link to={`/visits/${appointment.visit.id}`}>Visit</Link>
                              </Button>
                            )}
                            <AppointmentActions
                              appointment={appointment}
                              onChanged={() => reloadAll()}
                            />
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
            )}
          </Card>
        </TabsContent>

        {clinical && (
          <TabsContent value="clinical" className="space-y-4">
            <Card>
              <CardHeader
                title="Clinical visits"
                description="Owned by the responsible doctor. Reception has no access to these records."
                icon={Stethoscope}
                action={
                  hasPermission('CLINICAL_WRITE') ? (
                    <Button size="sm" onClick={() => setVisitOpen(true)}>
                      <Plus className="h-3.5 w-3.5" aria-hidden />
                      Start visit
                    </Button>
                  ) : undefined
                }
              />
              {visitsState.loading && !visitsState.data ? (
                <LoadingBlock label="Loading visits…" />
              ) : visits.length === 0 ? (
                <EmptyState
                  icon={Stethoscope}
                  title="No clinical visits"
                  description="Start a visit from an appointment or directly from this record."
                  action={
                    hasPermission('CLINICAL_WRITE') ? (
                      <Button variant="secondary" onClick={() => setVisitOpen(true)}>
                        Start visit
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Date</TH>
                        <TH>Doctor</TH>
                        <TH>Examination</TH>
                        <TH>Status</TH>
                        <TH>Reports</TH>
                        <TH className="text-right">Open</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {visits.map((visit) => (
                        <TR key={visit.id}>
                          <TD className="whitespace-nowrap text-ink-600">
                            {formatDateOnly(dateOnlyInZone(visit.visitDate, timezone))}
                          </TD>
                          <TD className="whitespace-nowrap">
                            {visit.doctor
                              ? `Dr ${visit.doctor.firstName} ${visit.doctor.lastName}`
                              : '—'}
                          </TD>
                          <TD className="max-w-[16rem] truncate">
                            {visit.examinationType ?? visit.chiefComplaint ?? '—'}
                          </TD>
                          <TD>
                            <StatusBadge status={visit.status} />
                          </TD>
                          <TD>
                            {visit.reports && visit.reports.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {visit.reports.map((report) => (
                                  <Badge
                                    key={report.id}
                                    tone={
                                      report.status === 'DRAFT'
                                        ? 'warning'
                                        : report.status === 'AMENDED'
                                          ? 'brand'
                                          : 'success'
                                    }
                                  >
                                    <FileText className="h-3 w-3" aria-hidden />v
                                    {report.versionNumber}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className="text-[12px] text-ink-400">None</span>
                            )}
                          </TD>
                          <TD className="text-right">
                            <Button size="sm" variant="secondary" asChild>
                              <Link to={`/visits/${visit.id}`}>Open</Link>
                            </Button>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              )}
            </Card>
          </TabsContent>
        )}

        {billing && (
          <TabsContent value="billing" className="space-y-6">
            {ledgerState.error && <Alert tone="danger">{ledgerState.error}</Alert>}
            {ledgerState.loading && !ledger ? (
              <LoadingBlock label="Loading the patient ledger…" />
            ) : !ledger ? null : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat
                    label="Charged"
                    value={formatMoney(ledger.summary.chargesMinor, currency)}
                    icon={Receipt}
                    tone="neutral"
                  />
                  <Stat
                    label="Payments received"
                    value={formatMoney(ledger.summary.paymentsMinor, currency)}
                    icon={Wallet}
                    tone="success"
                  />
                  <Stat
                    label="Outstanding"
                    value={formatMoney(ledger.summary.outstandingMinor, currency)}
                    icon={CreditCard}
                    tone={ledger.summary.outstandingMinor > 0 ? 'warning' : 'success'}
                  />
                  <Stat
                    label="Unallocated credit"
                    value={formatMoney(ledger.summary.unallocatedMinor, currency)}
                    hint={
                      ledger.summary.refundsMinor > 0
                        ? `${formatMoney(ledger.summary.refundsMinor, currency)} refunded`
                        : undefined
                    }
                    icon={Wallet}
                    tone="brand"
                  />
                </div>

                <Card>
                  <CardHeader
                    title="Charges"
                    description="Charges are amounts billed. Payments and refunds are recorded separately."
                    icon={Receipt}
                    action={
                      hasPermission('PAYMENTS_WRITE') ? (
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" onClick={() => setChargeOpen(true)}>
                            <Plus className="h-3.5 w-3.5" aria-hidden />
                            Charge
                          </Button>
                          <Button size="sm" onClick={() => setPaymentOpen(true)}>
                            <Wallet className="h-3.5 w-3.5" aria-hidden />
                            Payment
                          </Button>
                        </div>
                      ) : undefined
                    }
                  />
                  {ledger.charges.length === 0 ? (
                    <EmptyState
                      icon={Receipt}
                      title="No charges recorded"
                      description="Add a charge when a service is billed."
                    />
                  ) : (
                    <TableWrap>
                      <Table>
                        <THead>
                          <TR>
                            <TH>Date</TH>
                            <TH>Description</TH>
                            <TH className="text-right">Amount</TH>
                            <TH className="text-right">Allocated</TH>
                            <TH className="text-right">Balance</TH>
                            <TH>Status</TH>
                            <TH className="text-right">Actions</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {ledger.charges.map((charge) => (
                            <TR key={charge.id}>
                              <TD className="whitespace-nowrap text-ink-600">
                                {formatDateOnly(dateOnlyInZone(charge.createdAt, timezone))}
                              </TD>
                              <TD>{charge.description}</TD>
                              <TD className="tabular whitespace-nowrap text-right">
                                {formatMoney(charge.amountMinor, currency)}
                              </TD>
                              <TD className="tabular whitespace-nowrap text-right text-ink-500">
                                {formatMoney(charge.allocatedMinor, currency)}
                              </TD>
                              <TD className="tabular whitespace-nowrap text-right font-medium">
                                {formatMoney(charge.balanceMinor, currency)}
                              </TD>
                              <TD>
                                <StatusBadge status={charge.status} />
                              </TD>
                              <TD className="text-right">
                                {hasPermission('PAYMENTS_WRITE') &&
                                  charge.status === 'OPEN' &&
                                  charge.allocatedMinor === 0 && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setVoidTarget(charge)}
                                    >
                                      <XCircle className="h-3.5 w-3.5" aria-hidden />
                                      Void
                                    </Button>
                                  )}
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
                    title="Payments"
                    description="Money received, including deposits that are not yet allocated."
                    icon={Wallet}
                  />
                  {ledger.payments.length === 0 ? (
                    <EmptyState icon={Wallet} title="No payments recorded" />
                  ) : (
                    <TableWrap>
                      <Table>
                        <THead>
                          <TR>
                            <TH>Received</TH>
                            <TH>Method</TH>
                            <TH className="text-right">Amount</TH>
                            <TH className="text-right">Allocated</TH>
                            <TH className="text-right">Refunded</TH>
                            <TH className="text-right">Unallocated</TH>
                            <TH>Status</TH>
                            <TH className="text-right">Actions</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {ledger.payments.map((payment) => {
                            const refundable = payment.amountMinor - payment.refundedMinor;
                            return (
                              <TR key={payment.id}>
                                <TD className="whitespace-nowrap text-ink-600">
                                  {formatDateTime(payment.receivedAt, timezone)}
                                </TD>
                                <TD>
                                  {payment.method}
                                  {payment.reference && (
                                    <p className="text-[11px] text-ink-400">{payment.reference}</p>
                                  )}
                                </TD>
                                <TD className="tabular whitespace-nowrap text-right">
                                  {formatMoney(payment.amountMinor, currency)}
                                </TD>
                                <TD className="tabular whitespace-nowrap text-right text-ink-500">
                                  {formatMoney(payment.allocatedMinor, currency)}
                                </TD>
                                <TD className="tabular whitespace-nowrap text-right text-ink-500">
                                  {formatMoney(payment.refundedMinor, currency)}
                                </TD>
                                <TD className="tabular whitespace-nowrap text-right">
                                  {formatMoney(payment.unallocatedMinor, currency)}
                                </TD>
                                <TD>
                                  <StatusBadge status={payment.status} />
                                </TD>
                                <TD className="text-right">
                                  {hasPermission('REFUNDS_WRITE') &&
                                    payment.status === 'COMPLETED' &&
                                    refundable > 0 && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                          setRefundTarget({
                                            id: payment.id,
                                            amountMinor: payment.amountMinor,
                                            refundedMinor: payment.refundedMinor,
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
                  )}
                </Card>

                <Card>
                  <CardHeader
                    title="Ledger timeline"
                    description="Charges, payments and refunds in chronological order."
                    icon={ClipboardList}
                  />
                  {ledger.timeline.length === 0 ? (
                    <EmptyState icon={ClipboardList} title="Nothing recorded yet" />
                  ) : (
                    <TableWrap>
                      <Table>
                        <THead>
                          <TR>
                            <TH>Date</TH>
                            <TH>Type</TH>
                            <TH>Description</TH>
                            <TH>Method</TH>
                            <TH className="text-right">Amount</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {ledger.timeline.map((row) => (
                            <TR key={`${row.type}-${row.id}`}>
                              <TD className="whitespace-nowrap text-ink-600">
                                {formatDateTime(row.date, timezone)}
                              </TD>
                              <TD>
                                <Badge
                                  tone={
                                    row.type === 'CHARGE'
                                      ? 'warning'
                                      : row.type === 'REFUND'
                                        ? 'danger'
                                        : 'success'
                                  }
                                >
                                  {row.type}
                                </Badge>
                              </TD>
                              <TD>{row.description}</TD>
                              <TD className="whitespace-nowrap text-ink-500">
                                {row.method ?? '—'}
                              </TD>
                              <TD
                                className={`tabular whitespace-nowrap text-right font-medium ${
                                  row.type === 'REFUND' ? 'text-clay-700' : ''
                                }`}
                              >
                                {row.type === 'REFUND' ? '−' : ''}
                                {formatMoney(row.amountMinor, currency)}
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    </TableWrap>
                  )}
                </Card>
              </>
            )}
          </TabsContent>
        )}
      </Tabs>

      <PatientDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        patient={patient}
        onSaved={() => {
          setEditOpen(false);
          patientState.reload();
        }}
      />

      <AppointmentDialog
        open={appointmentOpen}
        onOpenChange={setAppointmentOpen}
        initialPatient={patient}
        onSaved={() => reloadAll()}
      />

      {clinical && (
        <NewVisitDialog
          open={visitOpen}
          onOpenChange={setVisitOpen}
          initialPatient={patient}
          onCreated={(visit) => navigate(`/visits/${visit.id}`)}
        />
      )}

      {billing && (
        <>
          <ChargeDialog
            open={chargeOpen}
            onOpenChange={setChargeOpen}
            patient={patient}
            onSaved={() => ledgerState.reload()}
          />
          <PaymentDialog
            open={paymentOpen}
            onOpenChange={setPaymentOpen}
            patient={patient}
            onSaved={() => ledgerState.reload()}
          />
          <RefundDialog
            open={refundTarget !== null}
            onOpenChange={(next) => !next && setRefundTarget(null)}
            payment={refundTarget}
            onSaved={() => ledgerState.reload()}
          />
          <ReasonDialog
            open={voidTarget !== null}
            onOpenChange={(next) => !next && setVoidTarget(null)}
            title="Void this charge?"
            description={
              voidTarget
                ? `${voidTarget.description} · ${formatMoney(voidTarget.amountMinor, currency)}`
                : undefined
            }
            label="Void reason"
            confirmLabel="Void charge"
            busy={busy}
            onConfirm={(reason) => void voidCharge(reason)}
          />
        </>
      )}
    </div>
  );
}
