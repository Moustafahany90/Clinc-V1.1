import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, KeyRound, ShieldAlert } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { Alert, Button, Card, Field, Input } from '../components/ui';

export function SetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [valid, setValid] = useState(false);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setChecking(false);
      return;
    }
    let active = true;
    api
      .get<{ valid: boolean; email: string; firstName: string }>(`/auth/password-setup/${encodeURIComponent(token)}`)
      .then((res) => {
        if (!active) return;
        setValid(res.data.valid);
        setEmail(res.data.email);
        setFirstName(res.data.firstName);
      })
      .catch(() => active && setValid(false))
      .finally(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    if (password.length < 10) {
      setError('Password must be at least 10 characters long.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/password-setup', { token, password });
      setDone(true);
      window.setTimeout(() => {
        navigate('/login', {
          replace: true,
          state: { message: 'Password set. You can sign in now.' },
        });
      }, 1400);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md animate-rise">
        <div className="mb-6 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-ink-900">
            <KeyRound className="h-5 w-5 text-brand-300" aria-hidden />
          </span>
          <h1 className="mt-3 text-xl font-semibold tracking-[-0.02em] text-ink-950">
            Set your password
          </h1>
          <p className="mt-1 text-[13px] text-ink-500">
            This single-use link expires for security. Choose a strong password you have not used before.
          </p>
        </div>

        <Card className="p-6">
          {checking ? (
            <p className="py-8 text-center text-[13px] text-ink-500">Checking your link…</p>
          ) : done ? (
            <div className="py-6 text-center">
              <CheckCircle2 className="mx-auto h-9 w-9 text-brand-600" aria-hidden />
              <p className="mt-3 text-sm font-semibold text-ink-900">Password updated</p>
              <p className="mt-1 text-[12px] text-ink-500">Taking you to sign in…</p>
            </div>
          ) : !valid ? (
            <div className="py-4 text-center">
              <ShieldAlert className="mx-auto h-9 w-9 text-clay-500" aria-hidden />
              <p className="mt-3 text-sm font-semibold text-ink-900">This link is invalid or expired</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
                Ask an administrator to issue a new setup link from Staff accounts.
              </p>
              <Button asChild variant="secondary" className="mt-4">
                <Link to="/login">Back to sign in</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <Alert tone="info">
                Setting the password for <span className="font-semibold">{email}</span>
                {firstName ? ` (${firstName})` : ''}.
              </Alert>

              {error && (
                <Alert tone="danger" title="Could not set password">
                  {error}
                </Alert>
              )}

              <Field label="New password" htmlFor="new-password" required>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  required
                />
              </Field>
              <Field label="Confirm password" htmlFor="confirm-password" required>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  invalid={Boolean(confirm) && confirm !== password}
                />
              </Field>
              <p className="text-[11px] text-ink-500">
                At least 10 characters using three of: lowercase, uppercase, numbers, symbols.
              </p>
              <Button type="submit" className="w-full" size="lg" loading={busy}>
                Save password
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
