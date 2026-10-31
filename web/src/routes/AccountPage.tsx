import { useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck, UserRound } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { formatDateOnly } from '../lib/format';
import { PERMISSION_LABELS, ROLE_LABELS } from '../lib/types';
import { fullName } from '../lib/utils';
import { useToast } from '../components/toast';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  KeyValue,
  PageHeader,
  SectionCard,
} from '../components/ui';

export function AccountPage() {
  const { user, changePassword } = useAuth();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    if (newPassword.length < 10) {
      setError('Use at least 10 characters for the new password.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password changed', 'Your other sessions have been signed out.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const permissions = user.permissions ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Account"
        title="My account"
        description="Your profile, role and security settings."
      />

      {user.mustChangePassword && (
        <Alert tone="warning" title="Set a new password to continue">
          You are signed in with a temporary password. Choose a personal password below before using
          the rest of the workspace.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SectionCard title="Profile" icon={UserRound}>
          <div className="flex items-center gap-4">
            <Avatar firstName={user.firstName} lastName={user.lastName} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-ink-950">{fullName(user)}</p>
              <p className="truncate text-[13px] text-ink-500">{user.email}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge tone="brand">{ROLE_LABELS[user.role]}</Badge>
                {user.phone && <Badge tone="muted">{user.phone}</Badge>}
              </div>
            </div>
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4">
            <KeyValue label="Account created">
              {user.createdAt ? formatDateOnly(user.createdAt.slice(0, 10)) : '—'}
            </KeyValue>
            <KeyValue label="Sign-in email">{user.email}</KeyValue>
          </dl>
        </SectionCard>

        <SectionCard title="Change password" icon={KeyRound}>
          <form onSubmit={submit} className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Current password" htmlFor="current-password" required>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </Field>
            <Field
              label="New password"
              htmlFor="new-password"
              hint="At least 10 characters. Avoid names, dates and common words."
              required
            >
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </Field>
            <Field label="Confirm new password" htmlFor="confirm-password" required>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={busy}>
                Update password
              </Button>
            </div>
          </form>
        </SectionCard>
      </div>

      <Card>
        <CardHeader
          title="Effective permissions"
          description="Access is enforced by the server on every request."
          icon={ShieldCheck}
        />
        <div className="px-5 py-4">
          {permissions.length === 0 ? (
            <p className="text-[13px] text-ink-500">No permissions are assigned to this account.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {permissions.map((permission) => (
                <Badge key={permission} tone="muted">
                  {PERMISSION_LABELS[permission as keyof typeof PERMISSION_LABELS] ?? permission}
                </Badge>
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] text-ink-400">
            Clinical permissions are granted explicitly and are never implied by the administrator
            role.
          </p>
        </div>
      </Card>
    </div>
  );
}
