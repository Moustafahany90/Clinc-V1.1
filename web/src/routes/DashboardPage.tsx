import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BarChart3,
  CalendarDays,
  CalendarPlus,
  ClipboardList,
  Clock,
  FileText,
  ListOrdered,
  Receipt,
  Stethoscope,
  Users,
  Wallet,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import { formatLongDate, formatTime, todayInZone } from '../lib/format';
import { formatMoney } from '../lib/money';
import type { DashboardData } from '../lib/types';
import { fullName } from '../lib/utils';
import { AppointmentDialog } from '../components/AppointmentDialog';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingBlock,
  PageHeader,
  SectionCard,
  Stat,
  StatusBadge,
} from '../components/ui';

export function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const { timezone, currency } = useClinic();
  const [bookingOpen, setBookingOpen] = useState(false);
  const today = todayInZone(timezone);
  const state = useAsyncData<DashboardData>(async () => {
    const res = await api.get<DashboardData>('/dashboard');
    return res.data;
  }, []);

  const data = state.data;
  const firstName = user?.firstName ?? 'there';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={formatLongDate(today)}
        title={`Good day, ${firstName}`}
        description="A calm overview of today's clinic. Clinical details stay with the responsible doctor."
        actions={
          <>
            {hasPermission('PATIENTS_WRITE') && (
              <Button asChild variant="secondary">
                <Link to="/patients">
                  <Users className="h-4 w-4" aria-hidden />
                  Patients
                </Link>
              </Button>
            )}
            {hasPermission('APPOINTMENTS_WRITE') && (
              <Button onClick={() => setBookingOpen(true)}>
                <CalendarPlus className="h-4 w-4" aria-hidden />
                New appointment
              </Button>
            )}
          </>
        }
      />

      {state.error && (
        <Alert tone="danger" title="Could not load the dashboard">
          {state.error}
        </Alert>
      )}

      {state.loading && !data ? (
        <LoadingBlock />
      ) : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Appointments today"
              value={data.appointments.total}
              hint={`${data.appointments.byStatus.DONE ?? 0} completed · ${data.appointments.byStatus.CANCELLED ?? 0} cancelled`}
              icon={CalendarDays}
              tone="brand"
            />
            <Stat
              label="Waiting now"
              value={data.queue.waiting + data.queue.called}
              hint={`${data.queue.called} called · ${data.queue.inExam} in exam`}
              icon={ListOrdered}
              tone={data.queue.waiting > 0 ? 'warning' : 'neutral'}
            />
            {data.finance ? (
              <Stat
                label="Collected today"
                value={formatMoney(data.finance.collectedTodayMinor, currency)}
                hint={`${data.finance.paymentsToday} payment${data.finance.paymentsToday === 1 ? '' : 's'} · expenses ${formatMoney(data.finance.expensesTodayMinor, currency)}`}
                icon={Wallet}
                tone="success"
              />
            ) : (
              <Stat
                label="Patients registered"
                value={data.patientsTotal ?? '—'}
                hint="Active patient records"
                icon={Users}
              />
            )}
            {data.clinical ? (
              <Stat
                label="Clinical work"
                value={data.clinical.draftReports}
                hint={`${data.clinical.openVisits} open visit${data.clinical.openVisits === 1 ? '' : 's'} · draft reports`}
                icon={FileText}
                tone={data.clinical.draftReports > 0 ? 'warning' : 'neutral'}
              />
            ) : data.patientsTotal != null ? (
              <Stat
                label="Patients registered"
                value={data.patientsTotal}
                hint="Active patient records"
                icon={Users}
              />
            ) : (
              <Stat
                label="Queue completed"
                value={data.queue.done}
                hint="Patients seen today"
                icon={Activity}
                tone="neutral"
              />
            )}
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <SectionCard
              title="Today's schedule"
              description={`${data.appointments.total} appointment${data.appointments.total === 1 ? '' : 's'} for ${formatLongDate(today)}`}
              icon={CalendarDays}
              bodyClassName="p-0"
              action={
                hasPermission('APPOINTMENTS_READ') ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/agenda">
                      Open agenda
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </Button>
                ) : null
              }
            >
              {data.appointments.list.length === 0 ? (
                <EmptyState
                  icon={CalendarDays}
                  title="No appointments booked today"
                  description="Reception can book from the agenda. Walk-ins appear in the waiting queue."
                  action={
                    hasPermission('APPOINTMENTS_WRITE') ? (
                      <Button size="sm" onClick={() => setBookingOpen(true)}>
                        <CalendarPlus className="h-3.5 w-3.5" aria-hidden />
                        Book the first appointment
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ul className="divide-y divide-line">
                  {data.appointments.list.map((appointment) => (
                    <li
                      key={appointment.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-brand-50/30"
                    >
                      <div className="w-14 shrink-0">
                        <p className="tabular text-[13px] font-semibold text-ink-900">
                          {formatTime(appointment.startAt, timezone)}
                        </p>
                        <p className="text-[10px] text-ink-400">
                          {appointment.durationMinutes} min
                        </p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`/patients/${appointment.patientId}`}
                          className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700"
                        >
                          {fullName(appointment.patient)}
                        </Link>
                        <p className="truncate text-[11px] text-ink-500">
                          {appointment.service?.name ?? appointment.reason ?? 'General examination'}
                          {appointment.doctor ? ` · Dr ${fullName(appointment.doctor)}` : ''}
                        </p>
                      </div>
                      <StatusBadge status={appointment.status} />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <div className="space-y-4">
              <Card className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-line px-5 py-4">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-soft text-amber-ink">
                      <ListOrdered className="h-4 w-4" aria-hidden />
                    </span>
                    <div>
                      <h2 className="text-sm font-semibold text-ink-900">Waiting queue</h2>
                      <p className="text-xs text-ink-500">Live counts for today</p>
                    </div>
                  </div>
                  {hasPermission('QUEUE_READ') && (
                    <Button asChild size="sm" variant="ghost">
                      <Link to="/queue">Open</Link>
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
                  {[
                    ['Waiting', data.queue.waiting],
                    ['Called', data.queue.called],
                    ['In exam', data.queue.inExam],
                    ['Done', data.queue.done],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-surface px-3 py-3 text-center">
                      <p className="tabular text-lg font-semibold text-ink-950">{value}</p>
                      <p className="text-[10px] uppercase tracking-wide text-ink-400">{label}</p>
                    </div>
                  ))}
                </div>
              </Card>

              {data.clinical && (
                <SectionCard
                  title="Clinical follow-up"
                  description="Your own drafts and open visits"
                  icon={Stethoscope}
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] text-ink-600">Draft reports</span>
                      <Badge tone={data.clinical.draftReports > 0 ? 'warning' : 'success'}>
                        {data.clinical.draftReports}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] text-ink-600">Open visits</span>
                      <Badge tone={data.clinical.openVisits > 0 ? 'info' : 'success'}>
                        {data.clinical.openVisits}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button asChild size="sm" variant="secondary">
                        <Link to="/visits">Visits</Link>
                      </Button>
                      <Button asChild size="sm" variant="secondary">
                        <Link to="/reports">Reports</Link>
                      </Button>
                    </div>
                  </div>
                </SectionCard>
              )}

              <SectionCard title="Quick links" icon={ClipboardList}>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { to: '/agenda', label: 'Agenda', icon: CalendarDays, show: hasPermission('APPOINTMENTS_READ') },
                    { to: '/queue', label: 'Queue', icon: ListOrdered, show: hasPermission('QUEUE_READ') },
                    { to: '/patients', label: 'Patients', icon: Users, show: hasPermission('PATIENTS_READ') },
                    { to: '/payments', label: 'Payments', icon: Wallet, show: hasPermission('PAYMENTS_READ') },
                    { to: '/expenses', label: 'Expenses', icon: Receipt, show: hasPermission('EXPENSES_READ') || hasPermission('FINANCE_READ') },
                    { to: '/finance', label: 'Finance', icon: BarChart3, show: hasPermission('FINANCE_READ') },
                    { to: '/visits', label: 'Visits', icon: Stethoscope, show: hasPermission('CLINICAL_READ') },
                    { to: '/reports', label: 'Reports', icon: FileText, show: hasPermission('CLINICAL_READ') },
                  ]
                    .filter((item) => item.show)
                    .map((item) => (
                      <Link
                        key={item.to}
                        to={item.to}
                        className="flex items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-2 text-[12px] font-medium text-ink-700 transition-colors hover:border-brand-300 hover:text-brand-700"
                      >
                        <item.icon className="h-3.5 w-3.5 text-ink-400" aria-hidden />
                        {item.label}
                      </Link>
                    ))}
                </div>
                <p className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-400">
                  <Clock className="h-3 w-3" aria-hidden />
                  Timezone {timezone}
                </p>
              </SectionCard>
            </div>
          </div>
        </>
      ) : null}

      <AppointmentDialog
        open={bookingOpen}
        onOpenChange={setBookingOpen}
        onSaved={() => state.reload()}
      />
    </div>
  );
}
