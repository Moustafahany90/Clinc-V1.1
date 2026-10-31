import { Link, Navigate, useLocation } from 'react-router-dom';
import { LockKeyhole } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button, Card, LoadingBlock } from './ui';

export function AuthLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-ink-900 shadow-card">
          <span className="h-4 w-4 animate-pulse rounded-full bg-brand-400" />
        </div>
        <p className="text-[13px] text-ink-500">Opening the clinic workspace…</p>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <AuthLoading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && location.pathname !== '/account') {
    return <Navigate to="/account" replace state={{ passwordRequired: true }} />;
  }
  return <>{children}</>;
}

export function RequirePermission({
  permission,
  anyOf,
  children,
}: {
  permission?: string;
  anyOf?: string[];
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const allowed = permission
    ? Boolean(user?.permissions.includes(permission))
    : anyOf?.some((p) => Boolean(user?.permissions.includes(p))) ?? false;

  if (!allowed) {
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-amber-soft text-amber-ink">
          <LockKeyhole className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-ink-950">Additional permission required</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          Your account does not include access to this area. An administrator can grant the
          required permission from Staff accounts.
        </p>
        <Button asChild className="mt-5" variant="secondary">
          <Link to="/">Back to dashboard</Link>
        </Button>
      </Card>
    );
  }
  return <>{children}</>;
}

export function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <AuthLoading />;
  if (user) return <Navigate to={user.mustChangePassword ? '/account' : '/'} replace />;
  return <>{children}</>;
}

export function PageLoading() {
  return <LoadingBlock />;
}
