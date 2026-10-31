import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  KeyRound,
  Mail,
  MailWarning,
  ShieldCheck,
  ShieldPlus,
  UserPlus,
  Users,
  UserX,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsyncData } from '../lib/hooks';
import { formatDateTime } from '../lib/format';
import {
  ALL_PERMISSIONS,
  CLINICAL_PERMISSIONS,
  PERMISSION_LABELS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_LABELS,
  type Permission,
  type Role,
  type UserAccount,
} from '../lib/types';
import { ConfirmDialog, OneTimeLink } from '../components/dialogs';
import { useToast } from '../components/toast';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
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
  Pagination,
  Select,
  Switch,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface UserList {
  users: UserAccount[];
  total: number;
  page: number;
  pageSize: number;
}

interface InviteOutcome {
  emailed: boolean;
  url?: string;
}

const ROLE_HINTS: Record<Role, string> = {
  ADMIN: 'Administration and finance by default. Clinical access must be granted explicitly.',
  RECEPTIONIST: 'Front desk only. Clinical permissions can never be granted to reception.',
  DOCTOR: 'Owns their clinical records. Always has clinical read, write and finalize; WhatsApp sending is enabled by default.',
};

const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  {
    label: 'Patients & scheduling',
    permissions: [
      'PATIENTS_READ',
      'PATIENTS_WRITE',
      'APPOINTMENTS_READ',
      'APPOINTMENTS_WRITE',
      'QUEUE_READ',
      'QUEUE_WRITE',
    ],
  },
  {
    label: 'Clinical',
    permissions: CLINICAL_PERMISSIONS,
  },
  {
    label: 'Finance',
    permissions: [
      'PAYMENTS_READ',
      'PAYMENTS_WRITE',
      'REFUNDS_WRITE',
      'EXPENSES_READ',
      'EXPENSES_WRITE',
      'FINANCE_READ',
      'FINANCE_EXPORT',
    ],
  },
  {
    label: 'Administration',
    permissions: ['USERS_MANAGE', 'SETTINGS_MANAGE', 'AUDIT_READ'],
  },
];

export function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();

  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserAccount | null>(null);
  const [resetTarget, setResetTarget] = useState<UserAccount | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<UserAccount | null>(null);
  const [inviteLink, setInviteLink] = useState<{ title: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const state = useAsyncData<UserList>(
    async () => (await api.get<UserList>('/users', { params: { page, pageSize: 25 } })).data,
    [page],
  );

  const users = state.data?.users ?? [];

  async function resetPassword() {
    if (!resetTarget) return;
    setBusy(true);
    try {
      const res = await api.post<{
        emailed: boolean;
        emailConfigured: boolean;
        url?: string;
      }>(`/users/${resetTarget.id}/password-reset`);
      if (res.data.url) {
        setInviteLink({
          title: `Password link for ${resetTarget.firstName} ${resetTarget.lastName}`,
          url: res.data.url,
        });
      } else {
        toast.success('Password link emailed', resetTarget.email);
      }
      setResetTarget(null);
    } catch (err) {
      toast.error('Could not create a password link', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!deactivateTarget) return;
    setBusy(true);
    try {
      if (deactivateTarget.isActive) {
        await api.delete(`/users/${deactivateTarget.id}`);
        toast.success(
          'Account removed',
          `${deactivateTarget.firstName} ${deactivateTarget.lastName} is archived and signed out. Their records are retained.`,
        );
      } else {
        await api.patch(`/users/${deactivateTarget.id}`, { isActive: true });
        toast.success(
          'Account restored',
          `${deactivateTarget.firstName} ${deactivateTarget.lastName}`,
        );
      }
      setDeactivateTarget(null);
      state.reload();
    } catch (err) {
      toast.error(
        deactivateTarget.isActive ? 'Could not remove the account' : 'Could not restore the account',
        errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Staff accounts"
        description="Roles set sensible defaults, but every action is checked against explicit permissions. Reception never has clinical access, and administrator clinical access is opt-in."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus className="h-4 w-4" aria-hidden />
            Invite staff member
          </Button>
        }
      />

      {inviteLink && (
        <div>
          <OneTimeLink
            title={inviteLink.title}
            url={inviteLink.url}
            onClose={() => setInviteLink(null)}
          />
          <Alert tone="warning" className="mt-2">
            Email delivery is not configured, so the link is shown once here. Send it to the staff
            member yourself. It expires in 72 hours and can be used only once.
          </Alert>
        </div>
      )}

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Card>
        {state.loading && !state.data ? (
          <LoadingBlock label="Loading staff accounts…" />
        ) : users.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No staff accounts"
            description="Invite a doctor or receptionist to get started."
            action={<Button onClick={() => setCreateOpen(true)}>Invite staff member</Button>}
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Role</TH>
                    <TH>Access</TH>
                    <TH>Status</TH>
                    <TH>Last sign-in</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {users.map((account) => {
                    const clinicalCount = account.permissions.filter((p) =>
                      (CLINICAL_PERMISSIONS as string[]).includes(p),
                    ).length;
                    const isSelf = account.id === me?.id;
                    return (
                      <TR key={account.id}>
                        <TD>
                          <div className="flex items-center gap-2.5">
                            <Avatar
                              firstName={account.firstName}
                              lastName={account.lastName}
                              size="sm"
                            />
                            <div className="min-w-0">
                              <p className="font-medium text-ink-900">
                                {account.firstName} {account.lastName}
                                {isSelf && (
                                  <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-400">
                                    you
                                  </span>
                                )}
                              </p>
                              <p className="truncate text-[11px] text-ink-400">{account.email}</p>
                            </div>
                          </div>
                        </TD>
                        <TD>
                          <Badge
                            tone={
                              account.role === 'ADMIN'
                                ? 'brand'
                                : account.role === 'DOCTOR'
                                  ? 'info'
                                  : 'neutral'
                            }
                          >
                            {ROLE_LABELS[account.role]}
                          </Badge>
                        </TD>
                        <TD>
                          <p className="text-[12px] text-ink-600">
                            {account.permissions.length} permission
                            {account.permissions.length === 1 ? '' : 's'}
                          </p>
                          {account.role === 'ADMIN' && (
                            <p className="mt-0.5 text-[10px] text-ink-400">
                              {clinicalCount > 0
                                ? `Clinical access granted (${clinicalCount})`
                                : 'No clinical access'}
                            </p>
                          )}
                          {account.role === 'RECEPTIONIST' && (
                            <p className="mt-0.5 text-[10px] text-ink-400">No clinical access</p>
                          )}
                          {account.mustChangePassword && (
                            <p className="mt-0.5 text-[10px] text-amber-ink">Invite pending</p>
                          )}
                        </TD>
                        <TD>
                          {account.isActive ? (
                            <Badge tone="success" dot>
                              Active
                            </Badge>
                          ) : (
                            <Badge tone="danger" dot>
                              Inactive
                            </Badge>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap text-ink-500">
                          {account.lastLoginAt
                            ? formatDateTime(account.lastLoginAt)
                            : 'Never'}
                        </TD>
                        <TD>
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setEditTarget(account)}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!account.isActive}
                              title={
                                account.isActive
                                  ? undefined
                                  : 'Restore this account before sending a password link.'
                              }
                              onClick={() => setResetTarget(account)}
                            >
                              <KeyRound className="h-3.5 w-3.5" aria-hidden />
                              Password link
                            </Button>
                            <Button
                              size="sm"
                              variant={account.isActive ? 'outlineDanger' : 'ghost'}
                              disabled={isSelf}
                              title={isSelf ? 'You cannot remove your own account.' : undefined}
                              onClick={() => setDeactivateTarget(account)}
                            >
                              {account.isActive ? (
                                <>
                                  <UserX className="h-3.5 w-3.5" aria-hidden />
                                  Remove
                                </>
                              ) : (
                                <>
                                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                                  Restore
                                </>
                              )}
                            </Button>
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
            <Pagination
              page={page}
              pageSize={state.data?.pageSize ?? 25}
              total={state.data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </Card>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(invite) => {
          setCreateOpen(false);
          state.reload();
          if (invite?.url) {
            setInviteLink({ title: 'Account invite created', url: invite.url });
          }
        }}
      />

      <EditUserDialog
        account={editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          state.reload();
        }}
      />

      <ConfirmDialog
        open={resetTarget !== null}
        onOpenChange={(next) => !next && setResetTarget(null)}
        title="Create a new password link?"
        description={
          resetTarget
            ? `${resetTarget.firstName} ${resetTarget.lastName} will receive a single-use link. Their current sessions are signed out and the link expires in 72 hours.`
            : undefined
        }
        confirmLabel="Create link"
        tone="warning"
        busy={busy}
        onConfirm={() => void resetPassword()}
      />

      <ConfirmDialog
        open={deactivateTarget !== null}
        onOpenChange={(next) => !next && setDeactivateTarget(null)}
        title={deactivateTarget?.isActive ? 'Remove this account?' : 'Restore this account?'}
        description={
          deactivateTarget
            ? deactivateTarget.isActive
              ? `${deactivateTarget.firstName} ${deactivateTarget.lastName} will be archived, signed out immediately and unable to sign in. Visits, reports, payments and the audit trail are kept. The account can be restored later.`
              : `${deactivateTarget.firstName} ${deactivateTarget.lastName} will be able to sign in again with their existing permissions.`
            : undefined
        }
        confirmLabel={deactivateTarget?.isActive ? 'Remove account' : 'Restore account'}
        tone={deactivateTarget?.isActive ? 'danger' : 'primary'}
        busy={busy}
        onConfirm={() => void toggleActive()}
      />
    </div>
  );
}

function PermissionPicker({
  role,
  value,
  onChange,
}: {
  role: Role;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const receptionist = role === 'RECEPTIONIST';
  const doctor = role === 'DOCTOR';

  function toggle(permission: Permission, checked: boolean) {
    if (doctor && (CLINICAL_PERMISSIONS as string[]).includes(permission)) return;
    const next = checked
      ? [...new Set([...value, permission])]
      : value.filter((item) => item !== permission);
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {PERMISSION_GROUPS.map((group) => {
        const clinicalGroup = group.label === 'Clinical';
        return (
          <div key={group.label} className="rounded-xl border border-line p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-500">
              {group.label}
            </p>
            {clinicalGroup && (
              <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                {receptionist
                  ? 'Reception can never access clinical records.'
                  : doctor
                    ? 'Doctors always have full clinical access to their own records.'
                    : 'Off by default. Administrators must deliberately grant clinical access.'}
              </p>
            )}
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {group.permissions.map((permission) => {
                const disabled =
                  (receptionist && clinicalGroup) ||
                  (doctor && (CLINICAL_PERMISSIONS as string[]).includes(permission));
                const checked =
                  doctor && (CLINICAL_PERMISSIONS as string[]).includes(permission)
                    ? true
                    : value.includes(permission);
                return (
                  <Checkbox
                    key={permission}
                    id={`perm-${permission}`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(next) => toggle(permission, next)}
                    label={PERMISSION_LABELS[permission]}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (invite: InviteOutcome | null) => void;
}) {
  const toast = useToast();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>('RECEPTIONIST');
  const [permissions, setPermissions] = useState<string[]>(ROLE_DEFAULT_PERMISSIONS.RECEPTIONIST);
  const [sendInvite, setSendInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFirstName('');
    setLastName('');
    setEmail('');
    setPhone('');
    setRole('RECEPTIONIST');
    setPermissions(ROLE_DEFAULT_PERMISSIONS.RECEPTIONIST);
    setSendInvite(true);
    setError(null);
  }, [open]);

  function changeRole(next: Role) {
    setRole(next);
    setPermissions(ROLE_DEFAULT_PERMISSIONS[next]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{
        user: UserAccount;
        invite: InviteOutcome | null;
        emailConfigured: boolean;
      }>('/users', {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        role,
        permissions,
        sendInvite,
      });
      toast.success('Account created', `${res.data.user.firstName} ${res.data.user.lastName}`);
      onCreated(res.data.invite);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader
          title="Invite a staff member"
          description="No password is set here. The staff member chooses their own password from a single-use link."
          icon={UserPlus}
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" required>
                <Input
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  required
                  maxLength={80}
                />
              </Field>
              <Field label="Last name" required>
                <Input
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  required
                  maxLength={80}
                />
              </Field>
              <Field label="Email" required>
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="off"
                />
              </Field>
              <Field label="Phone" hint="Optional.">
                <Input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  maxLength={30}
                />
              </Field>
              <Field label="Role" required className="sm:col-span-2" hint={ROLE_HINTS[role]}>
                <Select value={role} onChange={(event) => changeRole(event.target.value as Role)}>
                  <option value="RECEPTIONIST">Receptionist</option>
                  <option value="DOCTOR">Doctor</option>
                  <option value="ADMIN">Administrator</option>
                </Select>
              </Field>
            </div>

            <div>
              <p className="mb-2 text-[13px] font-medium text-ink-700">Permissions</p>
              <PermissionPicker role={role} value={permissions} onChange={setPermissions} />
            </div>

            <div className="rounded-xl border border-line p-3">
              <Switch
                checked={sendInvite}
                onCheckedChange={setSendInvite}
                label="Send the invite by email"
                description="If email is not configured, a one-time link is shown so you can share it manually."
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              <ShieldPlus className="h-4 w-4" aria-hidden />
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({
  account,
  onOpenChange,
  onSaved,
}: {
  account: UserAccount | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>('RECEPTIONIST');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    setFirstName(account.firstName);
    setLastName(account.lastName);
    setPhone(account.phone ?? '');
    setRole(account.role);
    setPermissions(account.permissions);
    setIsActive(account.isActive);
    setError(null);
  }, [account]);

  const changedRole = useMemo(
    () => Boolean(account) && role !== account?.role,
    [account, role],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account) return;
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/users/${account.id}`, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || null,
        role,
        permissions,
        isActive,
      });
      toast.success('Account updated');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(account)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader
          title="Edit staff account"
          description={account?.email}
          icon={ShieldCheck}
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" required>
                <Input
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  required
                />
              </Field>
              <Field label="Last name" required>
                <Input
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  required
                />
              </Field>
              <Field label="Phone">
                <Input value={phone} onChange={(event) => setPhone(event.target.value)} />
              </Field>
              <Field label="Role" hint={ROLE_HINTS[role]}>
                <Select
                  value={role}
                  onChange={(event) => {
                    const next = event.target.value as Role;
                    setRole(next);
                    setPermissions(ROLE_DEFAULT_PERMISSIONS[next]);
                  }}
                >
                  <option value="RECEPTIONIST">Receptionist</option>
                  <option value="DOCTOR">Doctor</option>
                  <option value="ADMIN">Administrator</option>
                </Select>
              </Field>
            </div>

            {changedRole && (
              <Alert tone="warning">
                Changing the role reset the permissions to the defaults for{' '}
                {ROLE_LABELS[role]}. Adjust them below before saving.
              </Alert>
            )}

            <PermissionPicker role={role} value={permissions} onChange={setPermissions} />

            <div className="rounded-xl border border-line p-3">
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                label="Account is active"
                description="Turning this off archives the account and signs the user out. Their records are retained."
              />
            </div>

            <Alert tone="info">
              Email addresses cannot be changed here. If the address is wrong, disable the account and
              create a new one.
            </Alert>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
