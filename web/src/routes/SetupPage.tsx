import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarClock,
  Check,
  CheckCircle2,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api, errorMessage } from '../lib/api';
import { getAccessToken } from '../lib/api';
import { minutesToLabel, labelToMinutes } from '../lib/format';
import type { AuthUser, WorkingHours } from '../lib/types';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
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

const DEFAULT_HOURS: WorkingHours[] = DAYS.map(({ n }) => {
  const weekendLike = n === 6 || n === 7;
  const closed = n === 4 || n === 5;
  return {
    dayOfWeek: n,
    isOpen: !closed,
    openMinute: weekendLike ? 13 * 60 : 14 * 60 + 30,
    closeMinute: 21 * 60,
    breakStartMinute: null,
    breakEndMinute: null,
  };
});

const TIMEZONES = [
  'Africa/Cairo',
  'Africa/Alexandria',
  'Asia/Riyadh',
  'Asia/Dubai',
  'Europe/London',
  'UTC',
];

function passwordScore(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 10) score += 1;
  if (password.length >= 14) score += 1;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes >= 3) score += 1;
  if (classes === 4) score += 1;
  return score;
}

export function SetupPage({ onComplete }: { onComplete: () => void }) {
  const { completeSetup } = useAuth();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [alreadySetup, setAlreadySetup] = useState(false);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [admin, setAdmin] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    password: '',
    confirm: '',
  });
  const [clinic, setClinic] = useState({
    name: 'Ultrasound Clinic',
    phone: '',
    email: '',
    address: '',
    timezone: 'Africa/Cairo',
    currency: 'EGP',
    defaultAppointmentMinutes: 15,
  });
  const [hours, setHours] = useState<WorkingHours[]>(DEFAULT_HOURS);
  const [firstPatient, setFirstPatient] = useState({ firstName: '', lastName: '', phone: '' });

  useEffect(() => {
    let active = true;
    api
      .get<{ setupRequired: boolean }>('/setup/status')
      .then((res) => {
        if (!active) return;
        setAlreadySetup(!res.data.setupRequired);
      })
      .catch(() => undefined)
      .finally(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, []);

  const score = passwordScore(admin.password);

  const stepValid = useMemo(() => {
    if (step === 0) {
      return (
        admin.firstName.trim() &&
        admin.lastName.trim() &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin.email) &&
        admin.password.length >= 10 &&
        score >= 2 &&
        admin.password === admin.confirm
      );
    }
    if (step === 1) {
      return Boolean(clinic.name.trim() && clinic.timezone);
    }
    return true;
  }, [step, admin, clinic, score]);

  function next() {
    setError(null);
    if (step === 0) {
      if (admin.password !== admin.confirm) {
        setError('The two passwords do not match.');
        return;
      }
      if (admin.password.length < 10) {
        setError('Password must be at least 10 characters long.');
        return;
      }
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) =>
        r.test(admin.password),
      ).length;
      if (classes < 3) {
        setError('Use at least three of: lowercase, uppercase, numbers, symbols.');
        return;
      }
    }
    if (step === 1) {
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: clinic.timezone });
      } catch {
        setError('That timezone is not recognised.');
        return;
      }
    }
    setStep((s) => Math.min(2, s + 1));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step < 2) {
      next();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{
        accessToken: string;
        user: AuthUser;
      }>('/setup', {
        admin: {
          firstName: admin.firstName.trim(),
          lastName: admin.lastName.trim(),
          email: admin.email.trim(),
          phone: admin.phone.trim(),
          password: admin.password,
        },
        clinic: {
          name: clinic.name.trim(),
          phone: clinic.phone.trim(),
          email: clinic.email.trim(),
          address: clinic.address.trim(),
          timezone: clinic.timezone,
          currency: clinic.currency.toUpperCase(),
          defaultAppointmentMinutes: clinic.defaultAppointmentMinutes,
        },
        workingHours: hours,
        ...(firstPatient.firstName.trim() && firstPatient.lastName.trim()
          ? {
              firstPatient: {
                firstName: firstPatient.firstName.trim(),
                lastName: firstPatient.lastName.trim(),
                phone: firstPatient.phone.trim(),
              },
            }
          : {}),
      });
      completeSetup(getAccessToken() ?? res.data.accessToken, res.data.user);
      onComplete();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <p className="text-[13px] text-ink-500">Checking installation…</p>
      </div>
    );
  }

  if (alreadySetup) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
        <Card className="w-full max-w-md p-8 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-brand-600" aria-hidden />
          <h1 className="mt-3 text-xl font-semibold text-ink-950">This clinic is already set up</h1>
          <p className="mt-2 text-[13px] text-ink-500">
            Installation can only run once. Sign in with an administrator account to continue.
          </p>
          <Button asChild className="mt-5">
            <Link to="/login">Go to sign in</Link>
          </Button>
        </Card>
      </div>
    );
  }

  const steps = [
    { label: 'Administrator', icon: UserRound },
    { label: 'Clinic profile', icon: Building2 },
    { label: 'Schedule', icon: CalendarClock },
  ];

  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[0.85fr_1.15fr]">
      <aside className="relative hidden overflow-hidden bg-ink-900 p-10 lg:flex lg:flex-col xl:p-12">
        <div className="absolute inset-0 surface-grid opacity-25" aria-hidden />
        <div
          className="absolute -right-20 top-10 h-[26rem] w-[26rem] rounded-full opacity-50 blur-3xl"
          style={{
            background:
              'radial-gradient(circle, rgba(29,143,134,0.5), rgba(29,143,134,0.05) 60%, transparent 72%)',
          }}
          aria-hidden
        />
        <div className="relative z-10 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400/90 via-brand-600 to-brand-800">
            <Activity className="h-5 w-5 text-white" strokeWidth={2.2} aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold text-white">Ultrasound Clinic</p>
            <p className="text-[10px] uppercase tracking-[0.18em] text-brand-300/80">Installation</p>
          </div>
        </div>

        <div className="relative z-10 mt-14">
          <h1 className="font-serif text-[2.3rem] leading-[1.1] tracking-[-0.02em] text-white">
            A clean start for
            <span className="block text-brand-200/90">your clinic records.</span>
          </h1>
          <p className="mt-4 max-w-sm text-[13px] leading-relaxed text-ink-300">
            This one-time wizard creates the first administrator and the clinic profile. No demo
            patients, reports, payments or staff accounts are ever seeded.
          </p>

          <ul className="mt-8 space-y-4">
            {[
              ['Private by default', 'Clinical notes stay with the responsible doctor.'],
              ['Exact money', 'Charges, payments and refunds are separate records.'],
              ['Full audit trail', 'Every status change and correction is recorded.'],
            ].map(([title, copy]) => (
              <li key={title} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500/15">
                  <Check className="h-3 w-3 text-brand-300" strokeWidth={3} aria-hidden />
                </span>
                <div>
                  <p className="text-[12px] font-semibold text-white">{title}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-400">{copy}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 mt-auto flex items-center gap-2 text-[11px] text-ink-500">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Installation is locked after the first administrator is created.
        </p>
      </aside>

      <section className="flex min-h-dvh flex-col px-5 py-8 sm:px-8 lg:justify-center">
        <div className="mx-auto w-full max-w-[560px]">
          <div className="mb-7 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink-900">
              <Activity className="h-4 w-4 text-brand-300" strokeWidth={2.4} aria-hidden />
            </span>
            <p className="text-[13px] font-semibold text-ink-950">Ultrasound Clinic setup</p>
          </div>

          <ol className="mb-7 flex items-center gap-2" aria-label="Setup progress">
            {steps.map((s, index) => (
              <li key={s.label} className="flex flex-1 items-center gap-2">
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold transition-colors',
                    index < step && 'border-brand-600 bg-brand-600 text-white',
                    index === step && 'border-brand-600 bg-brand-50 text-brand-700',
                    index > step && 'border-line-strong bg-white text-ink-400',
                  )}
                >
                  {index < step ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden /> : <s.icon className="h-4 w-4" aria-hidden />}
                </span>
                <span
                  className={cn(
                    'hidden text-[12px] font-medium sm:block',
                    index <= step ? 'text-ink-800' : 'text-ink-400',
                  )}
                >
                  {s.label}
                </span>
                {index < steps.length - 1 && <span className="h-px flex-1 bg-line" aria-hidden />}
              </li>
            ))}
          </ol>

          <form onSubmit={submit} className="animate-rise">
            {error && (
              <Alert tone="danger" className="mb-5" title="Check these details">
                {error}
              </Alert>
            )}

            {step === 0 && (
              <div>
                <header className="mb-5">
                  <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink-950">
                    Create the administrator
                  </h2>
                  <p className="mt-1 text-[13px] text-ink-500">
                    This account manages staff, clinic settings and finance. Clinical access is a
                    separate, explicit permission.
                  </p>
                </header>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="First name" htmlFor="admin-first" required>
                    <Input
                      id="admin-first"
                      value={admin.firstName}
                      onChange={(e) => setAdmin({ ...admin, firstName: e.target.value })}
                      autoComplete="given-name"
                      autoFocus
                      required
                    />
                  </Field>
                  <Field label="Last name" htmlFor="admin-last" required>
                    <Input
                      id="admin-last"
                      value={admin.lastName}
                      onChange={(e) => setAdmin({ ...admin, lastName: e.target.value })}
                      autoComplete="family-name"
                      required
                    />
                  </Field>
                  <Field label="Email address" htmlFor="admin-email" required className="sm:col-span-2">
                    <Input
                      id="admin-email"
                      type="email"
                      value={admin.email}
                      onChange={(e) => setAdmin({ ...admin, email: e.target.value })}
                      autoComplete="email"
                      required
                    />
                  </Field>
                  <Field label="Phone" htmlFor="admin-phone" hint="Optional." className="sm:col-span-2">
                    <Input
                      id="admin-phone"
                      type="tel"
                      value={admin.phone}
                      onChange={(e) => setAdmin({ ...admin, phone: e.target.value })}
                      autoComplete="tel"
                    />
                  </Field>
                  <Field label="Password" htmlFor="admin-password" required>
                    <Input
                      id="admin-password"
                      type="password"
                      value={admin.password}
                      onChange={(e) => setAdmin({ ...admin, password: e.target.value })}
                      autoComplete="new-password"
                      required
                    />
                  </Field>
                  <Field label="Confirm password" htmlFor="admin-confirm" required>
                    <Input
                      id="admin-confirm"
                      type="password"
                      value={admin.confirm}
                      onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })}
                      autoComplete="new-password"
                      required
                      invalid={Boolean(admin.confirm) && admin.confirm !== admin.password}
                    />
                  </Field>
                </div>

                <div className="mt-3">
                  <div className="flex gap-1" aria-hidden>
                    {[0, 1, 2, 3].map((i) => (
                      <span
                        key={i}
                        className={cn(
                          'h-1 flex-1 rounded-full transition-colors',
                          i < score
                            ? score >= 3
                              ? 'bg-brand-500'
                              : 'bg-amber-400'
                            : 'bg-line',
                        )}
                      />
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-ink-500">
                    At least 10 characters, using three of: lowercase, uppercase, numbers, symbols.
                  </p>
                </div>
              </div>
            )}

            {step === 1 && (
              <div>
                <header className="mb-5">
                  <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink-950">
                    Clinic profile
                  </h2>
                  <p className="mt-1 text-[13px] text-ink-500">
                    These details appear on printed reports and receipts. There are no tax or VAT
                    fields anywhere in this system.
                  </p>
                </header>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Clinic name" htmlFor="clinic-name" required className="sm:col-span-2">
                    <Input
                      id="clinic-name"
                      value={clinic.name}
                      onChange={(e) => setClinic({ ...clinic, name: e.target.value })}
                      required
                      autoFocus
                    />
                  </Field>
                  <Field label="Phone" htmlFor="clinic-phone">
                    <Input
                      id="clinic-phone"
                      type="tel"
                      value={clinic.phone}
                      onChange={(e) => setClinic({ ...clinic, phone: e.target.value })}
                    />
                  </Field>
                  <Field label="Public email" htmlFor="clinic-email">
                    <Input
                      id="clinic-email"
                      type="email"
                      value={clinic.email}
                      onChange={(e) => setClinic({ ...clinic, email: e.target.value })}
                    />
                  </Field>
                  <Field label="Address" htmlFor="clinic-address" className="sm:col-span-2">
                    <Textarea
                      id="clinic-address"
                      value={clinic.address}
                      onChange={(e) => setClinic({ ...clinic, address: e.target.value })}
                      rows={2}
                    />
                  </Field>
                  <Field label="Timezone" htmlFor="clinic-tz" hint="Clinic-local dates and times.">
                    <Select
                      id="clinic-tz"
                      value={clinic.timezone}
                      onChange={(e) => setClinic({ ...clinic, timezone: e.target.value })}
                    >
                      {TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Currency" htmlFor="clinic-currency" hint="Three-letter ISO code.">
                    <Input
                      id="clinic-currency"
                      value={clinic.currency}
                      maxLength={3}
                      onChange={(e) => setClinic({ ...clinic, currency: e.target.value.toUpperCase() })}
                    />
                  </Field>
                  <Field
                    label="Default appointment length"
                    htmlFor="clinic-duration"
                    hint="Minutes. Services can override this."
                  >
                    <Input
                      id="clinic-duration"
                      type="number"
                      min={5}
                      max={120}
                      step={5}
                      value={clinic.defaultAppointmentMinutes}
                      onChange={(e) =>
                        setClinic({ ...clinic, defaultAppointmentMinutes: Number(e.target.value) || 15 })
                      }
                    />
                  </Field>
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <header className="mb-5">
                  <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink-950">
                    Working hours
                  </h2>
                  <p className="mt-1 text-[13px] text-ink-500">
                    These are editable defaults. Thursday and Friday start closed until you decide
                    otherwise. Breaks can be added later in settings.
                  </p>
                </header>

                <div className="overflow-hidden rounded-xl border border-line">
                  <div className="grid grid-cols-[1fr_auto] gap-2 bg-surface-muted px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">
                    <span>Day</span>
                    <span>Hours</span>
                  </div>
                  <div className="divide-y divide-line">
                    {hours.map((day, index) => (
                      <div key={day.dayOfWeek} className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2.5">
                        <label className="flex items-center gap-2 text-[13px] text-ink-800">
                          <input
                            type="checkbox"
                            checked={day.isOpen}
                            onChange={(e) => {
                              const next = [...hours];
                              next[index] = { ...day, isOpen: e.target.checked };
                              setHours(next);
                            }}
                            className="h-4 w-4 rounded border-line-strong text-brand-600 accent-brand-600"
                          />
                          {DAYS[index].label}
                        </label>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="time"
                            disabled={!day.isOpen}
                            value={minutesToLabel(day.openMinute)}
                            onChange={(e) => {
                              const v = labelToMinutes(e.target.value);
                              if (v == null) return;
                              const next = [...hours];
                              next[index] = { ...day, openMinute: v };
                              setHours(next);
                            }}
                            className="h-8 rounded-md border border-line-strong bg-white px-2 text-[12px] text-ink-800 disabled:bg-surface-muted disabled:text-ink-400"
                          />
                          <span className="text-[11px] text-ink-400">to</span>
                          <input
                            type="time"
                            disabled={!day.isOpen}
                            value={minutesToLabel(day.closeMinute)}
                            onChange={(e) => {
                              const v = labelToMinutes(e.target.value);
                              if (v == null) return;
                              const next = [...hours];
                              next[index] = { ...day, closeMinute: v };
                              setHours(next);
                            }}
                            className="h-8 rounded-md border border-line-strong bg-white px-2 text-[12px] text-ink-800 disabled:bg-surface-muted disabled:text-ink-400"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-6 rounded-xl border border-line bg-white p-4">
                  <h3 className="text-[13px] font-semibold text-ink-900">First patient (optional)</h3>
                  <p className="mt-0.5 text-[11px] text-ink-500">
                    You can also add patients later from reception.
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="First name" htmlFor="p-first">
                      <Input
                        id="p-first"
                        value={firstPatient.firstName}
                        onChange={(e) => setFirstPatient({ ...firstPatient, firstName: e.target.value })}
                      />
                    </Field>
                    <Field label="Last name" htmlFor="p-last">
                      <Input
                        id="p-last"
                        value={firstPatient.lastName}
                        onChange={(e) => setFirstPatient({ ...firstPatient, lastName: e.target.value })}
                      />
                    </Field>
                    <Field label="Phone" htmlFor="p-phone" className="sm:col-span-2">
                      <Input
                        id="p-phone"
                        type="tel"
                        value={firstPatient.phone}
                        onChange={(e) => setFirstPatient({ ...firstPatient, phone: e.target.value })}
                      />
                    </Field>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-7 flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => (step === 0 ? navigate('/login') : setStep((s) => s - 1))}
                disabled={busy}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden />
                {step === 0 ? 'Back to sign in' : 'Back'}
              </Button>

              {step < 2 ? (
                <Button type="button" onClick={next} disabled={!stepValid} size="lg">
                  Continue
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              ) : (
                <Button type="submit" size="lg" loading={busy}>
                  {busy ? 'Creating clinic…' : 'Create clinic and sign in'}
                </Button>
              )}
            </div>
          </form>

          <p className="mt-6 text-center text-[11px] text-ink-400">
            Only non-sensitive defaults (services, payment methods, categories) are created.
          </p>
        </div>
      </section>
    </div>
  );
}
