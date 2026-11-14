import { useState } from 'react';
import {
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  ListChecks,
  Zap,
  DollarSign,
  PieChart,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { EmptyState, PageHeader } from '../../components/ui';
import { cn } from '../../lib/utils';
import { AvailabilityTodayPanel } from './AvailabilityTodayPanel';
import { TodayAppointmentsPanel } from './TodayAppointmentsPanel';
import { WeeklyAvailabilityPanel } from './WeeklyAvailabilityPanel';
import { DoctorSchedulePanel } from './DoctorSchedulePanel';
import { NextAvailablePanel } from './NextAvailablePanel';
import { TodayRevenuePanel } from './TodayRevenuePanel';
import { WeeklyRevenuePanel } from './WeeklyRevenuePanel';
import { TodayExpensesPanel } from './TodayExpensesPanel';
import { FinancialSummaryPanel } from './FinancialSummaryPanel';

type QuickActionId =
  | 'availability-today'
  | 'appointments-today'
  | 'availability-week'
  | 'doctor-schedule'
  | 'next-available'
  | 'revenue-today'
  | 'revenue-weekly'
  | 'expenses-today'
  | 'financial-summary';

interface QuickActionDefinition {
  id: QuickActionId;
  label: string;
  description: string;
  icon: LucideIcon;
  permission: string;
}

const ACTIONS: QuickActionDefinition[] = [
  {
    id: 'availability-today',
    label: 'Available today',
    description: 'Open slots by doctor',
    icon: CalendarCheck,
    permission: 'APPOINTMENTS_READ',
  },
  {
    id: 'appointments-today',
    label: "Today's appointments",
    description: 'Full day list and statuses',
    icon: ListChecks,
    permission: 'APPOINTMENTS_READ',
  },
  {
    id: 'availability-week',
    label: 'Weekly availability',
    description: 'Saturday → Friday openings',
    icon: CalendarRange,
    permission: 'APPOINTMENTS_READ',
  },
  {
    id: 'doctor-schedule',
    label: 'Doctor schedule',
    description: 'One doctor, day or range',
    icon: CalendarClock,
    permission: 'APPOINTMENTS_READ',
  },
  {
    id: 'next-available',
    label: 'Next available',
    description: 'Earliest slot in 60 days',
    icon: Zap,
    permission: 'APPOINTMENTS_READ',
  },
  {
    id: 'revenue-today',
    label: "Today's revenue",
    description: 'Net revenue and payments by method',
    icon: TrendingUp,
    permission: 'FINANCE_READ',
  },
  {
    id: 'revenue-weekly',
    label: 'Weekly revenue',
    description: 'Saturday → Friday, clinic week',
    icon: CalendarRange,
    permission: 'FINANCE_READ',
  },
  {
    id: 'expenses-today',
    label: "Today's expenses",
    description: 'Spending grouped by category',
    icon: PieChart,
    permission: 'FINANCE_READ',
  },
  {
    id: 'financial-summary',
    label: 'Financial summary',
    description: "Today's revenue, expenses and net",
    icon: DollarSign,
    permission: 'FINANCE_READ',
  },
];

/**
 * Clinic Quick Actions — predefined, permission-aware answers to the questions
 * staff ask most. Phase 1 covers appointment actions 1–5; results render inline
 * so nobody is bounced through several pages (or modals) to read one answer.
 */
export function QuickActionsPage() {
  const { hasPermission } = useAuth();
  const [selected, setSelected] = useState<QuickActionId>('availability-today');

  const visible = ACTIONS.filter((action) => hasPermission(action.permission));
  const current = visible.find((action) => action.id === selected) ?? visible[0] ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        title="Quick actions"
        description="Predefined answers built from live clinic data. Every action respects your account's permissions, and availability comes from the same schedule the booking screen uses."
      />

      {visible.length === 0 || !current ? (
        <EmptyState
          icon={Zap}
          title="No quick actions available"
          description="Your account does not include the permissions these actions need. Ask an administrator if you expected access."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {visible.map((action) => {
              const active = action.id === current.id;
              return (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => setSelected(action.id)}
                  aria-pressed={active}
                  className={cn(
                    'flex items-start gap-3 rounded-2xl border p-3.5 text-left transition-[border-color,background,box-shadow]',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                    active
                      ? 'border-brand-400 bg-brand-50 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_10px_24px_-18px_rgba(13,93,88,0.8)]'
                      : 'border-line bg-surface shadow-card hover:border-brand-200 hover:bg-brand-50/40',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                      active ? 'bg-brand-600 text-white' : 'bg-surface-muted text-ink-500',
                    )}
                  >
                    <action.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span
                      className={cn(
                        'block truncate text-[13px] font-semibold',
                        active ? 'text-brand-900' : 'text-ink-800',
                      )}
                    >
                      {action.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-500">
                      {action.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div>
            {current.id === 'availability-today' && <AvailabilityTodayPanel />}
            {current.id === 'appointments-today' && <TodayAppointmentsPanel />}
            {current.id === 'availability-week' && <WeeklyAvailabilityPanel />}
            {current.id === 'doctor-schedule' && <DoctorSchedulePanel />}
            {current.id === 'next-available' && <NextAvailablePanel />}
            {current.id === 'revenue-today' && <TodayRevenuePanel />}
            {current.id === 'revenue-weekly' && <WeeklyRevenuePanel />}
            {current.id === 'expenses-today' && <TodayExpensesPanel />}
            {current.id === 'financial-summary' && <FinancialSummaryPanel />}
          </div>
        </>
      )}
    </div>
  );
}
