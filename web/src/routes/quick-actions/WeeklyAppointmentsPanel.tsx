import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { useQuickAction } from '../../lib/useQuickAction';
import {
  fetchWeeklyAppointmentsSummary,
} from '../../lib/quickActions';
import { CalendarRange, TrendingUp } from 'lucide-react';
import {
  Alert,
  Badge,
  SectionCard,
  Stat,
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
                value={`${data.weekStart} → ${data.weekEnd}`}
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
                label="By status"
                value={Object.values(data.byStatus).reduce((a, b) => a + b, 0)}
                hint={`Breakdown of ${data.total} appointments`}
                icon={TrendingUp}
                tone="muted"
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
                        <TD>{status}</TD>
                        <TD className="tabular">{count}</TD>
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
