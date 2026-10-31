import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock,
  CreditCard,
  FlaskConical,
  Mail,
  MessageSquare,
  Plus,
  QrCode,
  Receipt,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  Stethoscope,
  Trash2,
  Unlink,
  Wallet,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import {
  formatDateOnly,
  labelToMinutes,
  minutesToLabel,
  todayInZone,
} from '../lib/format';
import { formatMoney, minorToInput, parseMoneyToMinor } from '../lib/money';
import type {
  Clinic,
  DoctorAvailability,
  ExpenseCategory,
  PaymentMethod,
  ScheduleException,
  Service,
  WhatsAppConnectResult,
  WhatsAppSettingsStatus,
  WorkingHours,
} from '../lib/types';
import { ConfirmDialog } from '../components/dialogs';
import { ReportTemplatesCard } from '../components/ReportTemplatesCard';
import { useToast } from '../components/toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Switch,
  Table,
  TableWrap,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  buttonVariants,
} from '../components/ui';
import { cn } from '../lib/utils';

const DAYS = [
  { n: 1, label: 'Monday' },
  { n: 2, label: 'Tuesday' },
  { n: 3, label: 'Wednesday' },
  { n: 4, label: 'Thursday' },
  { n: 5, label: 'Friday' },
  { n: 6, label: 'Saturday' },
  { n: 7, label: 'Sunday' },
];

const TIMEZONES = [
  'Africa/Cairo',
  'Africa/Alexandria',
  'Asia/Riyadh',
  'Asia/Dubai',
  'Asia/Amman',
  'Europe/London',
  'UTC',
];

interface SettingsResponse {
  clinic: Clinic;
  emailConfigured: boolean;
  emailWarning: string | null;
  serverTimezone: string;
}

interface GettingStarted {
  items: { key: string; label: string; done: boolean; optional?: boolean }[];
  completed: boolean;
  emailConfigured: boolean;
}

export function SettingsPage() {
  const { refreshClinic } = useClinic();
  const [tab, setTab] = useState('clinic');

  const settingsState = useAsyncData<SettingsResponse>(
    async () => (await api.get<SettingsResponse>('/settings')).data,
    [],
  );

  const settings = settingsState.data;

  function refreshSettings() {
    settingsState.reload();
    void refreshClinic();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Clinic settings"
        description="Clinic identity, opening hours, examination services, payment methods and email delivery. Changes are recorded in the audit log."
        actions={
          <span className="hidden items-center gap-1.5 text-[11px] text-ink-500 sm:flex">
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {settings?.serverTimezone ?? 'Africa/Cairo'}
          </span>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="clinic">Clinic details</TabsTrigger>
          <TabsTrigger value="hours">Hours & schedule</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="templates">Report templates</TabsTrigger>
          <TabsTrigger value="finance">Payments & categories</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
          <TabsTrigger value="setup">Getting started</TabsTrigger>
        </TabsList>

        <TabsContent value="clinic" className="space-y-4">
          {settingsState.error && <Alert tone="danger">{settingsState.error}</Alert>}
          {settingsState.loading && !settings ? (
            <LoadingBlock label="Loading clinic settings…" />
          ) : settings ? (
            <ClinicDetailsCard settings={settings} onSaved={refreshSettings} />
          ) : null}
        </TabsContent>

        <TabsContent value="hours" className="space-y-4">
          <HoursAndScheduleTab />
        </TabsContent>

        <TabsContent value="services" className="space-y-4">
          <ServicesCard />
        </TabsContent>

        <TabsContent value="templates" className="space-y-4">
          <ReportTemplatesCard />
        </TabsContent>

        <TabsContent value="finance" className="space-y-4">
          <PaymentMethodsCard />
          <ExpenseCategoriesCard />
        </TabsContent>

        <TabsContent value="email" className="space-y-4">
          {settingsState.error && <Alert tone="danger">{settingsState.error}</Alert>}
          {settingsState.loading && !settings ? (
            <LoadingBlock label="Loading email settings…" />
          ) : settings ? (
            <EmailCard settings={settings} onSaved={refreshSettings} />
          ) : null}
        </TabsContent>

        <TabsContent value="whatsapp" className="space-y-4">
          <WhatsAppCard />
        </TabsContent>

        <TabsContent value="setup" className="space-y-4">
          <GettingStartedCard onGoTo={setTab} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Clinic details                                                             */
/* -------------------------------------------------------------------------- */

function ClinicDetailsCard({
  settings,
  onSaved,
}: {
  settings: SettingsResponse;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState(settings.clinic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(settings.clinic);
  }, [settings]);

  function update<K extends keyof Clinic>(key: K, value: Clinic[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.patch('/settings', {
        name: form.name.trim(),
        legalName: form.legalName?.trim() || null,
        phone: form.phone?.trim() || null,
        email: form.email?.trim() || null,
        address: form.address?.trim() || null,
        timezone: form.timezone,
        currency: form.currency.toUpperCase(),
        defaultAppointmentMinutes: form.defaultAppointmentMinutes,
        slotIntervalMinutes: form.slotIntervalMinutes,
      });
      toast.success('Clinic details saved');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Clinic identity"
        description="Shown on printed reports and the sign-in screen."
        icon={SettingsIcon}
      />
      <form onSubmit={save} className="space-y-4 px-5 py-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Clinic name" required>
            <Input
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
              required
              maxLength={160}
            />
          </Field>
          <Field label="Legal name" hint="Optional. Used on official documents only.">
            <Input
              value={form.legalName ?? ''}
              onChange={(event) => update('legalName', event.target.value || null)}
              maxLength={160}
            />
          </Field>
          <Field label="Phone">
            <Input
              value={form.phone ?? ''}
              onChange={(event) => update('phone', event.target.value || null)}
              maxLength={30}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.email ?? ''}
              onChange={(event) => update('email', event.target.value || null)}
            />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Textarea
              value={form.address ?? ''}
              onChange={(event) => update('address', event.target.value || null)}
              rows={2}
              maxLength={400}
            />
          </Field>
          <Field label="Timezone" hint="All appointments, reports and reports use this timezone.">
            <Select
              value={form.timezone}
              onChange={(event) => update('timezone', event.target.value)}
            >
              {[...new Set([form.timezone, ...TIMEZONES])].map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" hint="Three-letter code. Amounts are always stored in piasters.">
            <Input
              value={form.currency}
              onChange={(event) => update('currency', event.target.value.toUpperCase())}
              maxLength={3}
            />
          </Field>
          <Field
            label="Default appointment length"
            hint="Minutes. New bookings start with this duration."
          >
            <Input
              type="number"
              min={5}
              max={120}
              step={5}
              value={form.defaultAppointmentMinutes}
              onChange={(event) =>
                update('defaultAppointmentMinutes', Number(event.target.value) || 15)
              }
            />
          </Field>
          <Field label="Slot interval" hint="Granularity of bookable start times, in minutes.">
            <Input
              type="number"
              min={5}
              max={60}
              step={5}
              value={form.slotIntervalMinutes}
              onChange={(event) => update('slotIntervalMinutes', Number(event.target.value) || 15)}
            />
          </Field>
        </div>
        <div className="flex justify-end border-t border-line pt-4">
          <Button type="submit" loading={busy}>
            <Save className="h-4 w-4" aria-hidden />
            Save clinic details
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Working hours                                                              */
/* -------------------------------------------------------------------------- */

function HoursAndScheduleTab() {
  const [hoursVersion, setHoursVersion] = useState(0);
  return (
    <>
      <HoursCard onSaved={() => setHoursVersion((value) => value + 1)} />
      <DoctorAvailabilityCard clinicHoursVersion={hoursVersion} />
      <ExceptionsCard />
    </>
  );
}

function HoursCard({ onSaved }: { onSaved?: () => void }) {
  const toast = useToast();
  const state = useAsyncData<{ workingHours: WorkingHours[] }>(
    async () => (await api.get<{ workingHours: WorkingHours[] }>('/settings/working-hours')).data,
    [],
  );
  const [hours, setHours] = useState<WorkingHours[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    const byDay = new Map(state.data.workingHours.map((row) => [row.dayOfWeek, row]));
    setHours(
      DAYS.map(
        ({ n }) =>
          byDay.get(n) ?? {
            dayOfWeek: n,
            isOpen: false,
            openMinute: 9 * 60,
            closeMinute: 17 * 60,
            breakStartMinute: null,
            breakEndMinute: null,
          },
      ),
    );
  }, [state.data]);

  function update(index: number, patch: Partial<WorkingHours>) {
    setHours((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function save() {
    setError(null);
    for (const row of hours) {
      const label = DAYS.find((day) => day.n === row.dayOfWeek)?.label ?? 'That day';
      if (row.isOpen && row.openMinute >= row.closeMinute) {
        setError(`${label}: opening time must be before closing time.`);
        return;
      }
      const hasBreakStart = row.breakStartMinute != null;
      const hasBreakEnd = row.breakEndMinute != null;
      if (row.isOpen && hasBreakStart !== hasBreakEnd) {
        setError(`${label}: set both break times or neither.`);
        return;
      }
      if (
        row.isOpen &&
        row.breakStartMinute != null &&
        row.breakEndMinute != null &&
        (row.breakStartMinute >= row.breakEndMinute ||
          row.breakStartMinute < row.openMinute ||
          row.breakEndMinute > row.closeMinute)
      ) {
        setError(`${label}: the break must fall inside the opening hours.`);
        return;
      }
    }
    setBusy(true);
    try {
      await api.put('/settings/working-hours', {
        workingHours: hours.map((row) => ({
          dayOfWeek: row.dayOfWeek,
          isOpen: row.isOpen,
          openMinute: row.openMinute,
          closeMinute: row.closeMinute,
          breakStartMinute: row.breakStartMinute,
          breakEndMinute: row.breakEndMinute,
        })),
      });
      toast.success('Opening hours saved');
      state.reload();
      onSaved?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Clinic opening hours"
        description="Appointments outside these hours require an explicit override with a reason."
        icon={CalendarClock}
        action={
          <Button size="sm" onClick={() => void save()} loading={busy} disabled={hours.length !== 7}>
            <Save className="h-3.5 w-3.5" aria-hidden />
            Save hours
          </Button>
        }
      />
      {state.loading && hours.length === 0 ? (
        <LoadingBlock label="Loading opening hours…" />
      ) : (
        <div className="px-5 py-4">
          {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
          <div className="space-y-2">
            {hours.map((row, index) => {
              const label = DAYS.find((day) => day.n === row.dayOfWeek)?.label ?? '';
              const breakEnabled = row.breakStartMinute != null && row.breakEndMinute != null;
              return (
                <div
                  key={row.dayOfWeek}
                  className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[10rem_1fr] sm:items-center"
                >
                  <Checkbox
                    id={`hours-open-${row.dayOfWeek}`}
                    checked={row.isOpen}
                    onCheckedChange={(checked) => update(index, { isOpen: checked })}
                    label={label}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <TimeInput
                      value={row.openMinute}
                      disabled={!row.isOpen}
                      onChange={(value) => update(index, { openMinute: value })}
                    />
                    <span className="text-[11px] text-ink-400">to</span>
                    <TimeInput
                      value={row.closeMinute}
                      disabled={!row.isOpen}
                      onChange={(value) => update(index, { closeMinute: value })}
                    />
                    <label className="ml-2 flex items-center gap-1.5 text-[11px] text-ink-500">
                      <input
                        type="checkbox"
                        checked={breakEnabled}
                        disabled={!row.isOpen}
                        onChange={(event) =>
                          update(
                            index,
                            event.target.checked
                              ? { breakStartMinute: 13 * 60, breakEndMinute: 14 * 60 }
                              : { breakStartMinute: null, breakEndMinute: null },
                          )
                        }
                        className="h-3.5 w-3.5 rounded border-line-strong accent-brand-600"
                      />
                      Break
                    </label>
                    {breakEnabled && (
                      <>
                        <TimeInput
                          value={row.breakStartMinute ?? 13 * 60}
                          disabled={!row.isOpen}
                          onChange={(value) => update(index, { breakStartMinute: value })}
                        />
                        <span className="text-[11px] text-ink-400">to</span>
                        <TimeInput
                          value={row.breakEndMinute ?? 14 * 60}
                          disabled={!row.isOpen}
                          onChange={(value) => update(index, { breakEndMinute: value })}
                        />
                      </>
                    )}
                    {!row.isOpen && <Badge tone="muted">Closed</Badge>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

function TimeInput({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="time"
      value={minutesToLabel(Math.min(value, 1439))}
      disabled={disabled}
      onChange={(event) => {
        const parsed = labelToMinutes(event.target.value);
        if (parsed != null) onChange(parsed);
      }}
      className="h-8 w-[7.5rem] rounded-md border border-line-strong bg-white px-2 text-[12px] text-ink-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-surface-muted disabled:text-ink-400"
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Doctor availability                                                        */
/* -------------------------------------------------------------------------- */

function DoctorAvailabilityCard({ clinicHoursVersion = 0 }: { clinicHoursVersion?: number }) {
  const { doctors } = useClinic();
  const toast = useToast();
  const [doctorId, setDoctorId] = useState('');
  const [rows, setRows] = useState<DoctorAvailability[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  const clinicHoursState = useAsyncData<{ workingHours: WorkingHours[] }>(
    async () => (await api.get<{ workingHours: WorkingHours[] }>('/settings/working-hours')).data,
    [clinicHoursVersion],
  );

  useEffect(() => {
    if (!doctorId && doctors.length > 0) setDoctorId(doctors[0].id);
  }, [doctors, doctorId]);

  const state = useAsyncData<{
    doctor: { id: string; firstName: string; lastName: string };
    availability: DoctorAvailability[];
    exceptions: ScheduleException[];
  }>(
    async () =>
      (await api.get(`/settings/doctors/${doctorId}/availability`)).data as {
        doctor: { id: string; firstName: string; lastName: string };
        availability: DoctorAvailability[];
        exceptions: ScheduleException[];
      },
    [doctorId],
    Boolean(doctorId),
  );

  const clinicByDay = useMemo(
    () => new Map((clinicHoursState.data?.workingHours ?? []).map((row) => [row.dayOfWeek, row])),
    [clinicHoursState.data],
  );

  useEffect(() => {
    if (!state.data || clinicHoursState.loading) return;
    const byDay = new Map(state.data.availability.map((row) => [row.dayOfWeek, row]));
    setRows(
      DAYS.map(({ n }) => {
        const clinic = clinicByDay.get(n);
        return (
          byDay.get(n) ?? {
            dayOfWeek: n,
            // A doctor with no override inherits the clinic schedule. Showing
            // 09:00-17:00 here used to create a silent override that shrank or
            // re-opened the clinic day when the administrator pressed Save.
            isWorking: clinic?.isOpen ?? false,
            openMinute: clinic?.openMinute ?? 780,
            closeMinute: clinic?.closeMinute ?? 1260,
          }
        );
      }),
    );
  }, [state.data, clinicByDay, clinicHoursState.loading]);

  function update(index: number, patch: Partial<DoctorAvailability>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function useClinicHours() {
    setError(null);
    setRows(
      DAYS.map(({ n }) => {
        const clinic = clinicByDay.get(n);
        return {
          dayOfWeek: n,
          isWorking: clinic?.isOpen ?? false,
          openMinute: clinic?.openMinute ?? 780,
          closeMinute: clinic?.closeMinute ?? 1260,
        };
      }),
    );
  }

  async function save() {
    if (!doctorId) return;
    setError(null);
    const invalid = rows.find((row) => row.isWorking && row.openMinute >= row.closeMinute);
    if (invalid) {
      const label = DAYS.find((day) => day.n === invalid.dayOfWeek)?.label ?? 'That day';
      setError(`${label}: the start time must be before the end time.`);
      return;
    }
    setBusy(true);
    try {
      await api.put(`/settings/doctors/${doctorId}/availability`, {
        availability: rows.map((row) => ({
          dayOfWeek: row.dayOfWeek,
          isWorking: row.isWorking,
          openMinute: row.openMinute,
          closeMinute: row.closeMinute,
        })),
      });
      toast.success('Doctor availability saved');
      state.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearOverrides() {
    if (!doctorId) return;
    setError(null);
    setBusy(true);
    try {
      await api.delete(`/settings/doctors/${doctorId}/availability`);
      toast.success('Doctor now follows the clinic opening hours');
      setClearOpen(false);
      state.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hasOverrides = (state.data?.availability.length ?? 0) > 0;

  return (
    <Card>
      <CardHeader
        title="Doctor availability"
        description="Further restricts the clinic hours for an individual doctor. The clinic hours always apply, including closed days."
        icon={Stethoscope}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={useClinicHours}
              disabled={rows.length !== 7}
            >
              Copy clinic hours
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              loading={busy}
              disabled={!doctorId || rows.length !== 7}
            >
              <Save className="h-3.5 w-3.5" aria-hidden />
              Save
            </Button>
          </div>
        }
      />
      <div className="space-y-3 px-5 py-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {clinicHoursState.error && (
          <Alert tone="danger">
            Could not load the clinic opening hours: {clinicHoursState.error}
          </Alert>
        )}
        {doctors.length === 0 ? (
          <Alert tone="info">
            No doctor accounts exist yet. Create one under Staff accounts to configure availability.
          </Alert>
        ) : (
          <>
            <Field label="Doctor" className="max-w-xs">
              <Select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}>
                {doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    Dr {doctor.firstName} {doctor.lastName}
                  </option>
                ))}
              </Select>
            </Field>
            {state.loading && rows.length === 0 ? (
              <LoadingBlock label="Loading availability…" />
            ) : state.error ? (
              <Alert tone="danger">{state.error}</Alert>
            ) : (
              <>
                {!hasOverrides ? (
                  <Alert tone="info">
                    This doctor inherits the clinic opening hours. Press Save only if you need a
                    different schedule for this doctor.
                  </Alert>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[12px] text-ink-500">
                      This doctor has explicitly configured hours.
                    </p>
                    <Button size="sm" variant="ghost" onClick={() => setClearOpen(true)}>
                      Inherit clinic hours
                    </Button>
                  </div>
                )}
                <div className="space-y-2">
                  {rows.map((row, index) => {
                    const label = DAYS.find((day) => day.n === row.dayOfWeek)?.label ?? '';
                    const clinic = clinicByDay.get(row.dayOfWeek);
                    return (
                      <div
                        key={row.dayOfWeek}
                        className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[10rem_1fr] sm:items-center"
                      >
                        <Checkbox
                          id={`doctor-day-${row.dayOfWeek}`}
                          checked={row.isWorking}
                          onCheckedChange={(checked) => update(index, { isWorking: checked })}
                          label={label}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <TimeInput
                            value={row.openMinute}
                            disabled={!row.isWorking}
                            onChange={(value) => update(index, { openMinute: value })}
                          />
                          <span className="text-[11px] text-ink-400">to</span>
                          <TimeInput
                            value={row.closeMinute}
                            disabled={!row.isWorking}
                            onChange={(value) => update(index, { closeMinute: value })}
                          />
                          {!row.isWorking && <Badge tone="muted">Not working</Badge>}
                          {row.isWorking && clinic && !clinic.isOpen && (
                            <Badge tone="muted">Clinic closed</Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="Inherit the clinic opening hours?"
        description="This removes this doctor's custom weekly availability. Their future appointments are not changed; bookings will follow the clinic hours from now on."
        confirmLabel="Use clinic hours"
        busy={busy}
        onConfirm={() => void clearOverrides()}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Schedule exceptions                                                        */
/* -------------------------------------------------------------------------- */

function ExceptionsCard() {
  const { doctors } = useClinic();
  const { timezone } = useClinic();
  const toast = useToast();
  const [date, setDate] = useState(todayInZone(timezone));
  const [doctorId, setDoctorId] = useState('');
  const [isClosed, setIsClosed] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleException | null>(null);

  const state = useAsyncData<{ exceptions: ScheduleException[] }>(
    async () => (await api.get<{ exceptions: ScheduleException[] }>('/settings/exceptions')).data,
    [],
  );

  async function add(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/settings/exceptions', {
        date,
        ...(doctorId ? { doctorId } : {}),
        isClosed,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success('Schedule exception added', formatDateOnly(date));
      setReason('');
      state.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.delete(`/settings/exceptions/${deleteTarget.id}`);
      toast.success('Exception removed');
      setDeleteTarget(null);
      state.reload();
    } catch (err) {
      toast.error('Could not remove the exception', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const exceptions = state.data?.exceptions ?? [];

  return (
    <Card>
      <CardHeader
        title="Closures and exceptions"
        description="Close the clinic or a single doctor for a specific date, such as a holiday."
        icon={CalendarClock}
      />
      <form onSubmit={add} className="grid gap-3 border-b border-line px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Date" required>
          <Input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            required
          />
        </Field>
        <Field label="Applies to">
          <Select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}>
            <option value="">Whole clinic</option>
            {doctors.map((doctor) => (
              <option key={doctor.id} value={doctor.id}>
                Dr {doctor.firstName} {doctor.lastName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason">
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Public holiday"
            maxLength={300}
          />
        </Field>
        <div className="flex items-end pb-1">
          <Switch
            checked={isClosed}
            onCheckedChange={setIsClosed}
            label="Closed all day"
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" loading={busy} className="w-full">
            <Plus className="h-4 w-4" aria-hidden />
            Add
          </Button>
        </div>
        {error && <Alert tone="danger" className="sm:col-span-2 lg:col-span-5">{error}</Alert>}
      </form>
      {state.loading && !state.data ? (
        <LoadingBlock label="Loading exceptions…" />
      ) : exceptions.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No upcoming exceptions"
          description="Holidays and one-off closures appear here."
        />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Applies to</TH>
                <TH>Reason</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {exceptions.map((exception) => (
                <TR key={exception.id}>
                  <TD className="whitespace-nowrap">
                    {formatDateOnly(exception.date.slice(0, 10))}
                  </TD>
                  <TD>
                    {exception.doctor
                      ? `Dr ${exception.doctor.firstName} ${exception.doctor.lastName}`
                      : 'Whole clinic'}
                  </TD>
                  <TD className="text-ink-600">{exception.reason ?? '—'}</TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeleteTarget(exception)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      Remove
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => !next && setDeleteTarget(null)}
        title="Remove this exception?"
        description="Appointments already booked on that date are not changed. Check the agenda before removing a closure."
        confirmLabel="Remove exception"
        busy={busy}
        onConfirm={() => void remove()}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Services                                                                   */
/* -------------------------------------------------------------------------- */

function ServicesCard() {
  const toast = useToast();
  const { currency, refreshServices } = useClinic();
  const state = useAsyncData<{ services: Service[] }>(
    async () => (await api.get<{ services: Service[] }>('/settings/services')).data,
    [],
  );
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Service | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/settings/services/${deleteTarget.id}`);
      toast.success('Service deleted', deleteTarget.name);
      setDeleteTarget(null);
      state.reload();
      void refreshServices();
    } catch (err) {
      toast.error('Could not delete the service', errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  const services = state.data?.services ?? [];

  return (
    <Card>
      <CardHeader
        title="Examination services"
        description="Bookable ultrasound examinations and their standard price. Prices are stored in piasters."
        icon={Stethoscope}
        action={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New service
          </Button>
        }
      />
      {state.loading && !state.data ? (
        <LoadingBlock label="Loading services…" />
      ) : services.length === 0 ? (
        <EmptyState
          icon={Stethoscope}
          title="No services yet"
          description="Add the examinations the clinic offers."
          action={<Button onClick={() => setEditing('new')}>New service</Button>}
        />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Service</TH>
                <TH>Duration</TH>
                <TH className="text-right">Price</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {services.map((service) => (
                <TR key={service.id}>
                  <TD>
                    <p className="font-medium text-ink-900">{service.name}</p>
                    {service.description && (
                      <p className="mt-0.5 max-w-md text-[11px] text-ink-400">
                        {service.description}
                      </p>
                    )}
                  </TD>
                  <TD className="whitespace-nowrap text-ink-600">{service.durationMinutes} min</TD>
                  <TD className="tabular whitespace-nowrap text-right">
                    {formatMoney(service.priceMinor, currency)}
                  </TD>
                  <TD>
                    {service.isActive ? (
                      <Badge tone="success" dot>
                        Active
                      </Badge>
                    ) : (
                      <Badge tone="muted">Inactive</Badge>
                    )}
                  </TD>
                  <TD className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(service)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger-600 hover:text-danger-700 hover:bg-danger-50"
                        onClick={() => setDeleteTarget(service)}
                        title="Delete service"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        Delete
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}

      <ServiceDialog
        service={editing}
        currency={currency}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          state.reload();
          void refreshServices();
        }}
        onError={(message) => toast.error('Could not save the service', message)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => !next && setDeleteTarget(null)}
        title="Delete service?"
        description={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.name}"? This will permanently remove the service.`
            : undefined
        }
        confirmLabel="Delete service"
        tone="danger"
        busy={deleting}
        onConfirm={() => void handleDelete()}
      />
    </Card>
  );
}

function ServiceDialog({
  service,
  currency,
  onOpenChange,
  onSaved,
  onError,
}: {
  service: Service | 'new' | null;
  currency: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [duration, setDuration] = useState('20');
  const [price, setPrice] = useState('0.00');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!service) return;
    if (service === 'new') {
      setName('');
      setDuration('20');
      setPrice('0.00');
      setDescription('');
      setIsActive(true);
    } else {
      setName(service.name);
      setDuration(String(service.durationMinutes));
      setPrice(minorToInput(service.priceMinor));
      setDescription(service.description ?? '');
      setIsActive(service.isActive);
    }
    setError(null);
  }, [service]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const priceMinor = parseMoneyToMinor(price) ?? 0;
    const payload = {
      name: name.trim(),
      durationMinutes: Number(duration) || 20,
      priceMinor,
      description: description.trim(),
      isActive,
    };
    setBusy(true);
    try {
      if (service === 'new') await api.post('/settings/services', payload);
      else if (service) await api.patch(`/settings/services/${service.id}`, payload);
      onSaved();
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(service)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader
          title={service === 'new' ? 'New service' : 'Edit service'}
          description="Services drive appointment durations and the default charge amount."
          icon={Stethoscope}
        />
        <form onSubmit={submit}>
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Name" required>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Abdominal ultrasound"
                required
                maxLength={160}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Duration (minutes)" required>
                <Input
                  type="number"
                  min={5}
                  max={240}
                  step={5}
                  value={duration}
                  onChange={(event) => setDuration(event.target.value)}
                  required
                />
              </Field>
              <Field label={`Price (${currency})`} hint="Use 0 for a service billed later.">
                <Input
                  inputMode="decimal"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                />
              </Field>
            </div>
            <Field label="Description">
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                maxLength={400}
              />
            </Field>
            <Switch
              checked={isActive}
              onCheckedChange={setIsActive}
              label="Active"
              description="Inactive services stay on historical appointments but cannot be booked."
            />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save service
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Payment methods                                                            */
/* -------------------------------------------------------------------------- */

function PaymentMethodsCard() {
  const toast = useToast();
  const { refreshPaymentMethods } = useClinic();
  const state = useAsyncData<{ paymentMethods: PaymentMethod[] }>(
    async () => (await api.get<{ paymentMethods: PaymentMethod[] }>('/settings/payment-methods')).data,
    [],
  );
  const [draft, setDraft] = useState<Record<string, PaymentMethod>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const methods = state.data?.paymentMethods ?? [];

  useEffect(() => {
    if (!state.data) return;
    setDraft(Object.fromEntries(state.data.paymentMethods.map((method) => [method.key, method])));
  }, [state.data]);

  async function save(method: PaymentMethod) {
    const row = draft[method.key] ?? method;
    setSavingKey(method.key);
    try {
      await api.patch(`/settings/payment-methods/${method.key}`, {
        label: row.label,
        requiresReference: row.requiresReference,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
      });
      toast.success('Payment method saved', row.label);
      state.reload();
      void refreshPaymentMethods();
    } catch (err) {
      toast.error('Could not save the payment method', errorMessage(err));
    } finally {
      setSavingKey(null);
    }
  }

  function update(key: string, patch: Partial<PaymentMethod>) {
    setDraft((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? methods.find((m) => m.key === key)!), ...patch },
    }));
  }

  return (
    <Card>
      <CardHeader
        title="Payment methods"
        description="Cash, card and wallet options offered at reception. Reference numbers can be required per method."
        icon={CreditCard}
      />
      {state.loading && !state.data ? (
        <LoadingBlock label="Loading payment methods…" />
      ) : (
        <div className="space-y-2 px-5 py-4">
          {methods.map((method) => {
            const row = draft[method.key] ?? method;
            return (
              <div
                key={method.key}
                className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[auto_1fr_auto_auto_auto] sm:items-center"
              >
                <Badge tone="muted">{method.key}</Badge>
                <Input
                  value={row.label}
                  onChange={(event) => update(method.key, { label: event.target.value })}
                  aria-label={`${method.key} label`}
                  maxLength={80}
                />
                <Checkbox
                  id={`method-ref-${method.key}`}
                  checked={row.requiresReference}
                  onCheckedChange={(checked) => update(method.key, { requiresReference: checked })}
                  label="Reference required"
                />
                <div className="flex items-center gap-2">
                  <Switch
                    checked={row.isActive}
                    onCheckedChange={(checked) => update(method.key, { isActive: checked })}
                    label="Active"
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={savingKey === method.key}
                  onClick={() => void save(method)}
                >
                  Save
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Expense categories                                                         */
/* -------------------------------------------------------------------------- */

function ExpenseCategoriesCard() {
  const toast = useToast();
  const state = useAsyncData<{ expenseCategories: ExpenseCategory[] }>(
    async () => (await api.get<{ expenseCategories: ExpenseCategory[] }>('/settings/expense-categories')).data,
    [],
  );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const categories = state.data?.expenseCategories ?? [];

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.post('/settings/expense-categories', { name: name.trim() });
      toast.success('Category added', name.trim());
      setName('');
      state.reload();
    } catch (err) {
      toast.error('Could not add the category', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(category: ExpenseCategory, isActive: boolean) {
    setSavingId(category.id);
    try {
      await api.patch(`/settings/expense-categories/${category.id}`, { isActive });
      state.reload();
    } catch (err) {
      toast.error('Could not update the category', errorMessage(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Expense categories"
        description="Group clinic costs for reporting. Inactive categories stay on historical expenses."
        icon={Receipt}
      />
      <form onSubmit={add} className="flex flex-wrap items-end gap-2 border-b border-line px-5 py-4">
        <Field label="New category" className="min-w-[12rem] flex-1">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Equipment maintenance"
            maxLength={80}
          />
        </Field>
        <Button type="submit" loading={busy} disabled={!name.trim()}>
          <Plus className="h-4 w-4" aria-hidden />
          Add category
        </Button>
      </form>
      {state.loading && !state.data ? (
        <LoadingBlock label="Loading categories…" />
      ) : categories.length === 0 ? (
        <EmptyState icon={Receipt} title="No expense categories" />
      ) : (
        <div className="divide-y divide-line">
          {categories.map((category) => (
            <div key={category.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="flex items-center gap-2">
                <Wallet className="h-3.5 w-3.5 text-ink-400" aria-hidden />
                <span className="text-[13px] text-ink-800">{category.name}</span>
                {!category.isActive && <Badge tone="muted">Inactive</Badge>}
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={category.isActive}
                  disabled={savingId === category.id}
                  onCheckedChange={(checked) => void toggle(category, checked)}
                  label="Active"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Email                                                                      */
/* -------------------------------------------------------------------------- */

function EmailCard({
  settings,
  onSaved,
}: {
  settings: SettingsResponse;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState(settings.clinic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ sent: boolean; reason: string | null } | null>(null);

  useEffect(() => {
    setForm(settings.clinic);
  }, [settings]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.patch('/settings', {
        emailEnabled: form.emailEnabled,
        emailProvider: form.emailProvider,
        emailFromAddress: form.emailFromAddress?.trim() || null,
        dailyDoctorDigest: form.dailyDoctorDigest,
        digestSendHour: form.digestSendHour,
      });
      toast.success('Email settings saved');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post<{ sent: boolean; reason: string | null; configured: boolean }>(
        '/settings/test-email',
        testTo.trim() ? { to: testTo.trim() } : {},
      );
      setTestResult({ sent: res.data.sent, reason: res.data.reason });
      if (res.data.sent) toast.success('Test email sent');
      else toast.info('Email was not sent', res.data.reason ?? 'Email delivery is not configured.');
    } catch (err) {
      toast.error('Could not send the test email', errorMessage(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      {!settings.emailConfigured && (
        <Alert tone="warning" title="Email delivery is not configured">
          Invitations and password links still work: the system shows a one-time link that you can
          share manually. All other clinic operations are unaffected. Configure SMTP or Microsoft
          Graph credentials on the server to enable email.
        </Alert>
      )}
      {settings.emailWarning && (
        <Alert tone="warning">{settings.emailWarning}</Alert>
      )}

      <Card>
        <CardHeader
          title="Email delivery"
          description="Optional. Used for staff invitations, password links and the daily doctor digest."
          icon={Mail}
        />
        <form onSubmit={save} className="space-y-4 px-5 py-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="rounded-xl border border-line p-3">
            <Switch
              checked={form.emailEnabled}
              onCheckedChange={(checked) =>
                setForm((prev) => ({ ...prev, emailEnabled: checked }))
              }
              label="Enable email"
              description="When disabled, the clinic never attempts to send email."
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider">
              <Select
                value={form.emailProvider}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    emailProvider: event.target.value as Clinic['emailProvider'],
                  }))
                }
              >
                <option value="smtp">SMTP</option>
                <option value="graph">Microsoft Graph</option>
              </Select>
            </Field>
            <Field label="From address" hint="The verified sender used on outgoing messages.">
              <Input
                type="email"
                value={form.emailFromAddress ?? ''}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, emailFromAddress: event.target.value }))
                }
              />
            </Field>
          </div>
          <div className="grid gap-4 rounded-xl border border-line p-3 sm:grid-cols-[1fr_auto] sm:items-center">
            <Switch
              checked={form.dailyDoctorDigest}
              onCheckedChange={(checked) =>
                setForm((prev) => ({ ...prev, dailyDoctorDigest: checked }))
              }
              label="Daily doctor digest"
              description="Send each doctor a summary of their appointments for the day."
            />
            <Field label="Send hour" className="w-32">
              <Select
                value={form.digestSendHour}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, digestSendHour: Number(event.target.value) }))
                }
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {String(hour).padStart(2, '0')}:00
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end border-t border-line pt-4">
            <Button type="submit" loading={busy}>
              <Save className="h-4 w-4" aria-hidden />
              Save email settings
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="Send a test message"
          description="Confirms the server can reach the mail provider. It does not change any setting."
          icon={FlaskConical}
        />
        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Send to" className="min-w-[14rem] flex-1" hint="Leave blank to email yourself.">
              <Input
                type="email"
                value={testTo}
                onChange={(event) => setTestTo(event.target.value)}
                placeholder="you@clinic.example"
              />
            </Field>
            <Button variant="secondary" loading={testing} onClick={() => void test()}>
              <Mail className="h-4 w-4" aria-hidden />
              Send test email
            </Button>
          </div>
          {testResult && (
            <Alert tone={testResult.sent ? 'success' : 'warning'}>
              {testResult.sent
                ? 'The test message was accepted by the mail provider.'
                : testResult.reason ?? 'The message was not sent. Check the server email configuration.'}
            </Alert>
          )}
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* WhatsApp delivery (Evolution API)                                          */
/* -------------------------------------------------------------------------- */

function WhatsAppCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [qrData, setQrData] = useState<WhatsAppConnectResult | null>(null);

  const statusState = useAsyncData<WhatsAppSettingsStatus>(
    async () => (await api.get<WhatsAppSettingsStatus>('/settings/whatsapp')).data,
    [],
  );

  const status = statusState.data;

  async function handleConnect() {
    setBusy(true);
    try {
      const res = await api.post<WhatsAppConnectResult>('/settings/whatsapp/connect');
      setQrData(res.data);
      statusState.reload();
      if (res.data.base64) {
        toast.info('QR code generated', 'Scan the code with WhatsApp on your clinic phone.');
      } else if (res.data.state === 'open') {
        toast.success('WhatsApp connected', 'Session is already active.');
      }
    } catch (err) {
      toast.error('Failed to obtain QR code', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setBusy(true);
    try {
      const res = await api.post<{ success: boolean; state: string; configured: boolean }>(
        '/settings/whatsapp/test',
      );
      statusState.reload();
      if (res.data.success) {
        toast.success('Connection active', 'Evolution API WhatsApp instance is connected and ready.');
      } else {
        toast.info(
          'Not connected',
          `Current instance state is "${res.data.state}". Scan the QR code to connect.`,
        );
      }
    } catch (err) {
      toast.error('WhatsApp test failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    try {
      await api.post('/settings/whatsapp/disconnect');
      setQrData(null);
      statusState.reload();
      toast.success('Disconnected', 'WhatsApp session has been logged out.');
      setDisconnectOpen(false);
    } catch (err) {
      toast.error('Failed to disconnect', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isConnected = status?.state === 'open';
  const isConnecting = status?.state === 'connecting';
  const isConfigured = status?.configured ?? false;

  return (
    <div className="space-y-4">
      {!isConfigured && (
        <Alert tone="warning" title="WhatsApp (Evolution API) is not configured">
          To enable WhatsApp report delivery, configure <code>EVOLUTION_API_URL</code>,{' '}
          <code>EVOLUTION_API_KEY</code>, and <code>EVOLUTION_API_ENABLED=true</code> on the server.
          Credentials are kept secure on the server and are never exposed to the browser.
        </Alert>
      )}

      <Card>
        <CardHeader
          title="WhatsApp delivery (Evolution API)"
          description="Enables doctors to send finalized ultrasound reports directly to patients via WhatsApp (Baileys QR code pairing)."
          icon={MessageSquare}
        />
        <div className="space-y-4 px-5 py-4">
          {statusState.error && <Alert tone="danger">{statusState.error}</Alert>}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted/30 p-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Instance Status
              </p>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-semibold text-ink-900">
                  {status?.instanceName || 'ultrasound_clinic'}
                </span>
                <Badge
                  tone={
                    isConnected
                      ? 'success'
                      : isConnecting
                        ? 'warning'
                        : isConfigured
                          ? 'neutral'
                          : 'danger'
                  }
                >
                  {isConnected
                    ? 'Connected'
                    : isConnecting
                      ? 'Connecting (Scan QR)'
                      : isConfigured
                        ? 'Disconnected'
                        : 'Unconfigured'}
                </Badge>
              </div>
              <p className="mt-0.5 text-[11px] text-ink-500">
                {isConnected
                  ? 'Instance is paired with WhatsApp Web. Doctors can deliver reports.'
                  : isConnecting
                    ? 'Waiting for QR code scan from WhatsApp mobile app.'
                    : isConfigured
                      ? 'Instance is currently logged out or waiting to pair.'
                      : 'Server environment missing Evolution API configuration.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => statusState.reload()}
                loading={statusState.loading}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Check status
              </Button>
              {isConfigured && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleTest()}
                  loading={busy}
                >
                  Test connection
                </Button>
              )}
              {isConfigured && !isConnected && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleConnect()}
                  loading={busy}
                >
                  <QrCode className="h-3.5 w-3.5" aria-hidden />
                  {qrData ? 'Refresh QR Code' : 'Connect / QR Code'}
                </Button>
              )}
              {isConfigured && isConnected && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setDisconnectOpen(true)}
                  disabled={busy}
                >
                  <Unlink className="h-3.5 w-3.5" aria-hidden />
                  Disconnect
                </Button>
              )}
            </div>
          </div>

          {qrData?.base64 && !isConnected && (
            <div className="rounded-xl border border-line bg-white p-6 text-center animate-rise">
              <p className="text-sm font-semibold text-ink-900">Scan QR Code with WhatsApp</p>
              <p className="mx-auto mt-1 max-w-md text-[12px] text-ink-500">
                Open WhatsApp on your clinic mobile phone &gt; <strong>Linked devices</strong> &gt;{' '}
                <strong>Link a device</strong>, then point your phone camera at this screen.
              </p>
              <div className="mt-4 flex justify-center">
                <img
                  src={
                    qrData.base64.startsWith('data:')
                      ? qrData.base64
                      : `data:image/png;base64,${qrData.base64}`
                  }
                  alt="WhatsApp Pairing QR Code"
                  className="h-64 w-64 rounded-xl border border-line shadow-card"
                />
              </div>
              {qrData.pairingCode && (
                <p className="mt-3 text-[12px] text-ink-600">
                  Pairing code: <code className="font-mono font-bold">{qrData.pairingCode}</code>
                </p>
              )}
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleConnect()}
                  loading={busy}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  Refresh QR Code
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect WhatsApp?"
        description="This will log out the clinic WhatsApp session. Doctors will not be able to deliver reports until an administrator scans the QR code again."
        confirmLabel="Disconnect"
        tone="danger"
        busy={busy}
        onConfirm={() => void handleDisconnect()}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Getting started                                                            */
/* -------------------------------------------------------------------------- */

function GettingStartedCard({ onGoTo }: { onGoTo: (tab: string) => void }) {
  const state = useAsyncData<GettingStarted>(
    async () => (await api.get<GettingStarted>('/settings/getting-started')).data,
    [],
  );

  const data = state.data;
  const items = data?.items ?? [];

  return (
    <Card>
      <CardHeader
        title="Getting started"
        description="A quick checklist for a fully configured clinic. Optional items do not block readiness."
        icon={CheckCircle2}
      />
      {state.loading && !data ? (
        <LoadingBlock label="Checking setup…" />
      ) : state.error ? (
        <div className="px-5 py-4">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4">
          <Alert tone={data?.completed ? 'success' : 'info'}>
            {data?.completed
              ? 'All required setup steps are complete. The clinic is ready to use.'
              : 'Some required setup steps are still outstanding.'}
          </Alert>
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  {item.done ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
                  ) : (
                    <Circle className="h-4 w-4 text-ink-300" aria-hidden />
                  )}
                  <span className="text-[13px] text-ink-800">{item.label}</span>
                  {item.optional && <Badge tone="muted">Optional</Badge>}
                </div>
                {item.done ? (
                  <Badge tone="success">Done</Badge>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (item.key === 'workingHours') onGoTo('hours');
                      else if (item.key === 'services') onGoTo('services');
                      else if (item.key === 'email') onGoTo('email');
                      else if (item.key === 'clinic') onGoTo('clinic');
                      else window.location.assign('/users');
                    }}
                    className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                  >
                    Set up
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
