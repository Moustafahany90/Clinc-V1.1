import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Activity, ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { Alert, Button, Field, Input } from '../components/ui';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as { from?: string; message?: string };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await login(email, password);
      const destination = user.mustChangePassword ? '/account' : state.from ?? '/';
      navigate(destination, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden overflow-hidden bg-ink-900 lg:flex lg:flex-col">
        <div className="absolute inset-0 surface-grid opacity-30" aria-hidden />
        <div
          className="absolute -left-32 top-1/4 h-[34rem] w-[34rem] rounded-full opacity-60 blur-3xl"
          style={{
            background:
              'radial-gradient(circle at 40% 40%, rgba(29,143,134,0.55), rgba(29,143,134,0.08) 55%, transparent 70%)',
          }}
          aria-hidden
        />
        <div
          className="absolute -bottom-40 right-0 h-[28rem] w-[28rem] rounded-full opacity-40 blur-3xl"
          style={{
            background:
              'radial-gradient(circle at 50% 50%, rgba(221,132,104,0.5), transparent 65%)',
          }}
          aria-hidden
        />

        <div className="relative z-10 flex h-full flex-col p-10 xl:p-14">
          <div className="flex items-center gap-3">
            <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400/90 via-brand-600 to-brand-800 shadow-[0_10px_30px_-10px_rgba(29,143,134,0.9)]">
              <Activity className="h-5 w-5 text-white" strokeWidth={2.2} aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold tracking-tight text-white">Ultrasound Clinic</p>
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-brand-300/80">
                Clinical workspace
              </p>
            </div>
          </div>

          <div className="mt-auto max-w-lg">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-brand-200">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
              Built for a focused ultrasound practice
            </p>
            <h1 className="font-serif text-[2.6rem] leading-[1.08] tracking-[-0.02em] text-white xl:text-[3rem]">
              Every patient, every scan,
              <span className="block text-brand-200/90">in one calm place.</span>
            </h1>
            <p className="mt-5 max-w-md text-[14px] leading-relaxed text-ink-300">
              Reception books and queues. Doctors document and finalize. Finance stays exact —
              without clinical notes ever leaving the doctor&apos;s scope.
            </p>

            <div className="mt-9 grid max-w-md grid-cols-3 gap-3">
              {[
                ['Role-scoped', 'Clinical privacy by design'],
                ['Conflict-safe', 'No double bookings'],
                ['Audit-ready', 'Every change recorded'],
              ].map(([title, copy]) => (
                <div key={title} className="rounded-xl border border-white/8 bg-white/[0.035] p-3">
                  <p className="text-[12px] font-semibold text-white">{title}</p>
                  <p className="mt-1 text-[11px] leading-snug text-ink-400">{copy}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-auto flex items-center gap-2 pt-10 text-[11px] text-ink-500">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Authorized clinic staff only · Africa/Cairo · EGP
          </div>
        </div>
      </section>

      <section className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[380px] animate-rise">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink-900">
              <Activity className="h-4 w-4 text-brand-300" strokeWidth={2.4} aria-hidden />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-ink-950">Ultrasound Clinic</p>
              <p className="text-[10px] uppercase tracking-[0.16em] text-ink-400">Clinical workspace</p>
            </div>
          </div>

          <div className="mb-6">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink-950">Sign in</h2>
            <p className="mt-1.5 text-[13px] text-ink-500">
              Use the clinic account created for you by an administrator.
            </p>
          </div>

          {state.message && (
            <Alert tone="success" className="mb-4">
              {state.message}
            </Alert>
          )}

          {error && (
            <Alert tone="danger" className="mb-4" title="Could not sign in">
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Field label="Email address" htmlFor="email" required>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                placeholder="you@clinic.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </Field>

            <Field label="Password" htmlFor="password" required>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-400 hover:text-ink-700"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                </button>
              </div>
            </Field>

            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              {!busy && <ArrowRight className="h-4 w-4" aria-hidden />}
            </Button>
          </form>

          <div className="mt-5 flex items-start gap-2 rounded-xl border border-line bg-white px-3.5 py-3 text-[12px] text-ink-500">
            <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" aria-hidden />
            <p>
              Forgot your password? Ask an administrator to issue a new single-use setup link. Passwords
              are never sent by email.
            </p>
          </div>

          <p className="mt-6 text-center text-[11px] text-ink-400">
            First installation?{' '}
            <Link to="/setup" className="font-medium text-brand-700 hover:underline">
              Run clinic setup
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
