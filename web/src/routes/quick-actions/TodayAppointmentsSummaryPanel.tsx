import { useAuth } from '../../lib/auth';
import { useClinic } from '../../lib/clinic';
import { useQuickAction } from '../../lib/useQuickAction';
import {
  fetchTodayAppointmentsSummary,
} from '../../lib/quickActions';
import { CalendarDays, TrendingUp, ListChecks } from 'lucide-react';
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
 * Action 10 — today's appointments summary (total + byStatus).
 * Permission: APPOINTMENTS_READ
 */
export function TodayAppointmentsSummaryPanel() {
  const { user } = useAuth();
  const { timezone } = useClinic();

  const state = useQuickAction((signal) => fetchTodayAppointmentsSummary(signal), {});

  return (
    <SectionCard
      title="Appointment summary"
      description={`Today's total appointments in ${timezone}, broken down by status.`}
      icon={CalendarDays}
      action={<RefreshButton state={state} />}
      bodyClassName="space-y-4"
    >
      <QuickActionResult state={state} loadingLabel="Loading today's appointments summary…">
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Total"
                value={data.total}
                hint={`${timezone}`}
                icon={CalendarDays}
                tone="brand"
              />
              <Stat
                label="Completed"
                value={data.byStatus.DONE}
                hint="Visits marked done today"
                icon={TrendingUp}
                tone="success"
              />
              <Stat
                label="Waiting"
                value={data.byStatus.WAITING}
                hint="Patients waiting for an appointment"
                icon={ListChecks}
                tone="info"
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
              <Alert tone="info">No appointments scheduled for today yet.</Alert>
            )}
          </>
        )}
      </QuickActionResult>
    </SectionCard>
  );
}
