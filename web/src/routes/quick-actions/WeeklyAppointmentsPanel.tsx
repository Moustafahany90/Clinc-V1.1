import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { useQuickAction } from '../../lib/useQuickAction';
import {
  fetchWeeklyAppointmentsSummary,
} from '../../lib/quickActions';
import { CalendarRange, TrendingUp } from 'lucide-react';
import { formatDateOnly } from '../../lib/format';
import {
  Alert,
  Badge,
  SectionCard,
  Stat,
  StatusBadge,
  Table,
  TableWrap,
  TH,
  THead,
  TR,
  TBody,
  TD,
} from '../../components/ui';
import { QuickActionResult, RefreshButton } from './shared';

/**
 * Action 13 — weekly appointments summary (total + byStatus).
 * Permission: APPOINTMENTS_READ
 */
export function WeeklyAppointmentsPanel() {
  const { user } = useAuth();
  const { timezone } = useClinic();

  const state = useQuickAction((signal) => fetchWeeklyAppointmentsSummary(signal), {});

  return (
    <SectionCard
      title="Weekly appointments"
      description={`Total appointments for the clinic week, Saturday → Friday (${timezone}).`}
      icon={CalendarRange}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <QuickActionResult state={state} loadingLabel="Loading weekly appointments…">
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Week"
                value={`${formatDateOnly(data.weekStart)} → ${formatDateOnly(data.weekEnd)}`}
                hint={`${timezone}`}
                icon={CalendarRange}
                tone="brand"
              />
              <Stat
                label="Total"
                value={data.total}
                hint="All appointments in the week"
                icon={TrendingUp}
                tone="brand"
              />
              <Stat
                label="Completed"
                value={data.byStatus.DONE}
                hint={`Visits marked done out of ${data.total}`}
                icon={TrendingUp}
                tone="success"
              />
            </div>

            {Object.entries(data.byStatus).length > 0 && (
              <TableWrap>
                <Table>
                  <THead>
                    <TR>
                      <TH>Status</TH>
                      <TH className="text-right">Count</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {Object.entries(data.byStatus).map(([status, count]) => (
                      <TR key={status}>
                        <TD>
                          <StatusBadge status={status} />
                        </TD>
                        <TD className="tabular text-right">{count}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
            )}

            {data.total === 0 && (
              <Alert tone="info">No appointments this week yet.</Alert>
            )}
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
