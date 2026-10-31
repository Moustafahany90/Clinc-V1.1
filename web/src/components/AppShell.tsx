import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu,
  Receipt,
  ScrollText,
  Settings as SettingsIcon,
  ShieldAlert,
  Stethoscope,
  UserCog,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { cn, fullName } from '../lib/utils';
import { formatTime, todayInZone } from '../lib/format';
import { ROLE_LABELS } from '../lib/types';
import {
  Avatar,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission?: string;
  anyOf?: string[];
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/agenda', label: 'Agenda', icon: CalendarDays, permission: 'APPOINTMENTS_READ' },
      { to: '/queue', label: 'Waiting queue', icon: ListOrdered, permission: 'QUEUE_READ' },
      { to: '/patients', label: 'Patients', icon: Users, permission: 'PATIENTS_READ' },
    ],
  },
  {
    label: 'Clinical',
    items: [
      { to: '/visits', label: 'Visits', icon: Stethoscope, permission: 'CLINICAL_READ' },
      { to: '/reports', label: 'Reports', icon: FileText, permission: 'CLINICAL_READ' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/payments', label: 'Payments & charges', icon: Wallet, permission: 'PAYMENTS_READ' },
      { to: '/expenses', label: 'Expenses', icon: Receipt, anyOf: ['EXPENSES_READ', 'FINANCE_READ'] },
      { to: '/finance', label: 'Financial reports', icon: BarChart3, permission: 'FINANCE_READ' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/users', label: 'Staff accounts', icon: UserCog, permission: 'USERS_MANAGE' },
      { to: '/settings', label: 'Clinic settings', icon: SettingsIcon, permission: 'SETTINGS_MANAGE' },
      { to: '/audit', label: 'Audit log', icon: ScrollText, permission: 'AUDIT_READ' },
    ],
  },
];

const SIDEBAR_PREFERENCE_KEY = 'clinic.desktopSidebarCollapsed';

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/agenda': 'Agenda',
  '/queue': 'Waiting queue',
  '/patients': 'Patients',
  '/visits': 'Visits',
  '/reports': 'Reports',
  '/payments': 'Payments & charges',
  '/expenses': 'Expenses',
  '/finance': 'Financial reports',
  '/users': 'Staff accounts',
  '/settings': 'Clinic settings',
  '/audit': 'Audit log',
  '/account': 'My account',
};

function pageTitle(pathname: string): string {
  if (TITLES[pathname]) return TITLES[pathname];
  const root = `/${pathname.split('/')[1] ?? ''}`;
  return TITLES[root] ?? 'Clinic workspace';
}

function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400/90 via-brand-600 to-brand-800 shadow-[0_8px_20px_-10px_rgba(29,143,134,0.9)]">
        <Activity className="h-4 w-4 text-white" strokeWidth={2.4} aria-hidden />
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-900 bg-clay-400" />
      </span>
      {!compact && (
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-tight text-white">
            Ultrasound Clinic
          </p>
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-brand-300/80">
            Clinical workspace
          </p>
        </div>
      )}
    </div>
  );
}

function SidebarContent({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const { user, hasPermission, logout } = useAuth();
  const { clinicName, timezone } = useClinic();
  const navigate = useNavigate();

  const groups = useMemo(
    () =>
      NAV.map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          if (item.permission) return hasPermission(item.permission);
          if (item.anyOf) return item.anyOf.some((p) => hasPermission(p));
          return true;
        }),
      })).filter((group) => group.items.length > 0),
    [hasPermission],
  );

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex h-full flex-col bg-ink-900 text-ink-200">
      <div
        className={cn(
          'flex h-16 items-center px-4',
          collapsed ? 'justify-center px-2' : 'justify-between',
        )}
      >
        <Link
          to="/"
          onClick={onNavigate}
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
          aria-label="Ultrasound Clinic dashboard"
        >
          <BrandMark compact={collapsed} />
        </Link>
        <button
          type="button"
          onClick={onNavigate}
          className="rounded-lg p-1.5 text-ink-400 hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 lg:hidden"
          aria-label="Close navigation"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {!collapsed && (
        <div className="mx-3 mb-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
          <p className="truncate text-[11px] font-medium text-brand-200/90">{clinicName}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-400">
            <span className="inline-block h-1 w-1 rounded-full bg-brand-400" />
            {timezone}
          </p>
        </div>
      )}

      <nav
        className={cn(
          'min-h-0 flex-1 overflow-y-auto pb-4 scrollbar-thin',
          collapsed ? 'px-1.5' : 'px-2',
        )}
        aria-label="Main navigation"
      >
        {groups.map((group) => (
          <div key={group.label} className="mb-3">
            {!collapsed && (
              <p className="px-2.5 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
                {group.label}
              </p>
            )}
            {collapsed && <div className="mx-2 mb-1 border-t border-white/8" aria-hidden />}
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'group flex items-center gap-2.5 rounded-lg text-[13px] font-medium transition-colors',
                        collapsed ? 'justify-center px-0 py-2.5' : 'px-2.5 py-2',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400',
                        isActive
                          ? 'bg-brand-500/15 text-white shadow-[inset_0_0_0_1px_rgba(93,211,200,0.14)]'
                          : 'text-ink-300 hover:bg-white/[0.045] hover:text-white',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon
                          className={cn(
                            'h-4 w-4 shrink-0 transition-colors',
                            isActive ? 'text-brand-300' : 'text-ink-500 group-hover:text-ink-300',
                          )}
                          aria-hidden
                        />
                        <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
                        {isActive && !collapsed && (
                          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand-300" aria-hidden />
                        )}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/8 p-3">
        <div
          className={cn(
            'flex items-center gap-2.5 rounded-xl px-1 py-1',
            collapsed && 'flex-col gap-1 px-0',
          )}
        >
          <Avatar firstName={user?.firstName} lastName={user?.lastName} size="sm" />
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium text-white">{fullName(user)}</p>
              <p className="truncate text-[10px] text-ink-400">
                {user ? ROLE_LABELS[user.role] : ''}
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const { timezone, clinicName } = useClinic();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [clock, setClock] = useState(() => formatTime(new Date()));

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, String(desktopCollapsed));
    } catch {
      // The preference is cosmetic; private browsing may block storage.
    }
  }, [desktopCollapsed]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(formatTime(new Date())), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    document.title = `${pageTitle(location.pathname)} · ${clinicName}`;
  }, [location.pathname, clinicName]);

  const title = pageTitle(location.pathname);

  async function handleSignOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-dvh bg-canvas">
      <aside
        id="desktop-sidebar"
        aria-label="Clinic navigation"
        className={cn(
          'fixed inset-y-0 left-0 z-30 hidden overflow-hidden transition-[width] duration-200 lg:block',
          desktopCollapsed ? 'w-[76px]' : 'w-[248px]',
        )}
      >
        <SidebarContent collapsed={desktopCollapsed} />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-ink-950/55 backdrop-blur-[2px] animate-fade"
            onClick={() => setMobileOpen(false)}
            aria-label="Dismiss navigation"
          />
          <div className="absolute inset-y-0 left-0 w-[270px] shadow-lift animate-rise">
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div
        className={cn(
          'transition-[padding] duration-200',
          desktopCollapsed ? 'lg:pl-[76px]' : 'lg:pl-[248px]',
        )}
      >
        <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-md">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="rounded-lg border border-line bg-white p-2 text-ink-600 shadow-sm transition-colors hover:text-ink-900 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" aria-hidden />
            </button>

            <button
              type="button"
              onClick={() => setDesktopCollapsed((value) => !value)}
              className="hidden rounded-lg border border-line bg-white p-2 text-ink-600 shadow-sm transition-colors hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 lg:inline-flex"
              aria-label={desktopCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              aria-expanded={!desktopCollapsed}
              aria-controls="desktop-sidebar"
              title={desktopCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            >
              {desktopCollapsed ? (
                <ChevronsRight className="h-4 w-4" aria-hidden />
              ) : (
                <ChevronsLeft className="h-4 w-4" aria-hidden />
              )}
            </button>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] text-ink-400">
                <span className="hidden sm:inline">Clinic</span>
                <span className="hidden sm:inline text-ink-300">/</span>
                <span className="truncate font-medium text-ink-600">{title}</span>
              </div>
            </div>

            <div className="hidden items-center gap-2 text-[11px] text-ink-500 sm:flex">
              <span className="tabular rounded-md border border-line bg-white px-2 py-1 font-medium text-ink-700">
                {clock}
              </span>
              <span className="hidden text-ink-400 md:inline">{timezone}</span>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-full border border-line bg-white py-1 pl-1 pr-2 shadow-sm transition-colors hover:border-ink-300"
                  aria-label="Account menu"
                >
                  <Avatar firstName={user?.firstName} lastName={user?.lastName} size="sm" />
                  <span className="hidden max-w-[8rem] truncate text-[12px] font-medium text-ink-800 sm:block">
                    {user?.firstName}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-ink-400" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-60">
                <DropdownMenuLabel>
                  <span className="block text-ink-700">{fullName(user)}</span>
                  <span className="mt-0.5 block font-normal normal-case tracking-normal text-ink-400">
                    {user?.email}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => navigate('/account')}>
                  <UserCog className="h-4 w-4" aria-hidden />
                  My account
                </DropdownMenuItem>
                {user && user.role !== 'RECEPTIONIST' && (
                  <DropdownMenuItem disabled>
                    <ShieldAlert className="h-4 w-4" aria-hidden />
                    {ROLE_LABELS[user.role]}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => void handleSignOut()}>
                  <LogOut className="h-4 w-4" aria-hidden />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {user?.mustChangePassword && location.pathname !== '/account' && (
            <div className="border-t border-amber-200 bg-amber-soft px-4 py-2 sm:px-6">
              <p className="flex flex-wrap items-center gap-2 text-[12px] text-amber-ink">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                You are using a temporary password.
                <Link to="/account" className="font-semibold underline underline-offset-2">
                  Set a new password
                </Link>
              </p>
            </div>
          )}

        </header>

        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:py-8">
          <Outlet />
        </main>

        <footer className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-2 px-4 pb-6 text-[11px] text-ink-400 sm:px-6">
          <span>
            Today is {todayInZone(timezone)} · times shown in {timezone}
          </span>
          <span>Ultrasound Clinic · EGP · English</span>
        </footer>
      </div>
    </div>
  );
}

export function PageActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function BackLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-500 transition-colors hover:text-brand-700"
    >
      <ChevronDown className="h-3.5 w-3.5 rotate-90" aria-hidden />
      {children}
    </Link>
  );
}

export function RoleBadge({ role }: { role: string }) {
  return <Badge tone={role === 'ADMIN' ? 'brand' : role === 'DOCTOR' ? 'info' : 'neutral'}>{ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role}</Badge>;
}
