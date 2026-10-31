import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileText, Plus, Stethoscope, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import { dateOnlyInZone, formatDateOnly, formatTime } from '../lib/format';
import type { Patient, Visit } from '../lib/types';
import { NewVisitDialog } from '../components/NewVisitDialog';
import { PatientSearch } from '../components/PatientSearch';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface VisitList {
  visits: Visit[];
  total: number;
  page: number;
  pageSize: number;
}

export function VisitsPage() {
  const { hasPermission } = useAuth();
  const { timezone } = useClinic();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [date, setDate] = useState('');
  const [patient, setPatient] = useState<Patient | null>(null);
  const [page, setPage] = useState(1);
  const [newOpen, setNewOpen] = useState(false);

  const state = useAsyncData<VisitList>(
    async () => {
      const res = await api.get<VisitList>('/visits', {
        params: {
          page,
          pageSize: 25,
          ...(status ? { status } : {}),
          ...(date ? { date } : {}),
          ...(patient ? { patientId: patient.id } : {}),
        },
      });
      return res.data;
    },
    [page, status, date, patient?.id],
  );

  const data = state.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Clinical"
        title="Visits"
        description="Clinical encounters owned by the responsible doctor. Reception has no access."
        actions={
          hasPermission('CLINICAL_WRITE') && (
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Start visit
            </Button>
          )
        }
      />

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Status">
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="IN_REVIEW">In review</option>
              <option value="COMPLETED">Completed</option>
            </Select>
          </Field>
          <Field label="Visit date">
            <Input
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="Patient" className="sm:col-span-2">
            {patient ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-line-strong bg-white px-3 py-2">
                <span className="min-w-0 truncate text-[13px] text-ink-800">
                  {patient.firstName} {patient.lastName}
                  <span className="ml-2 font-mono text-[11px] text-ink-400">
                    {patient.patientNumber}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPatient(null);
                    setPage(1);
                  }}
                  className="rounded p-0.5 text-ink-400 hover:text-ink-700"
                  aria-label="Clear patient filter"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : (
              <PatientSearch
                value={patient}
                onChange={(next) => {
                  setPatient(next);
                  setPage(1);
                }}
                placeholder="Filter by patient…"
              />
            )}
          </Field>
        </div>
      </Card>

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Card>
        {state.loading && !data ? (
          <LoadingBlock label="Loading visits…" />
        ) : !data || data.visits.length === 0 ? (
          <EmptyState
            icon={Stethoscope}
            title="No visits found"
            description="Start a visit from the queue, an appointment, or with the button above."
            action={
              hasPermission('CLINICAL_WRITE') ? (
                <Button variant="secondary" onClick={() => setNewOpen(true)}>
                  Start visit
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Patient</TH>
                    <TH>Doctor</TH>
                    <TH>Examination</TH>
                    <TH>Status</TH>
                    <TH>Reports</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.visits.map((visit) => (
                    <TR
                      key={visit.id}
                      interactive
                      onClick={() => navigate(`/visits/${visit.id}`)}
                    >
                      <TD className="whitespace-nowrap text-ink-600">
                        {formatDateOnly(dateOnlyInZone(visit.visitDate, timezone))}
                        <span className="ml-1 text-[11px] text-ink-400">
                          {formatTime(visit.visitDate, timezone)}
                        </span>
                      </TD>
                      <TD>
                        <Link
                          to={`/patients/${visit.patientId}`}
                          onClick={(event) => event.stopPropagation()}
                          className="font-medium text-ink-900 hover:text-brand-700"
                        >
                          {visit.patient
                            ? `${visit.patient.firstName} ${visit.patient.lastName}`
                            : 'Patient'}
                        </Link>
                        <p className="mt-0.5 font-mono text-[11px] text-ink-400">
                          {visit.patient?.patientNumber ?? ''}
                        </p>
                      </TD>
                      <TD className="whitespace-nowrap">
                        {visit.doctor ? `Dr ${visit.doctor.firstName} ${visit.doctor.lastName}` : '—'}
                      </TD>
                      <TD className="max-w-[16rem] truncate">
                        {visit.examinationType ?? visit.chiefComplaint ?? '—'}
                      </TD>
                      <TD>
                        <StatusBadge status={visit.status} />
                      </TD>
                      <TD>
                        {visit.reports && visit.reports.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {visit.reports.map((report) => (
                              <Badge
                                key={report.id}
                                tone={
                                  report.status === 'DRAFT'
                                    ? 'warning'
                                    : report.status === 'AMENDED'
                                      ? 'brand'
                                      : 'success'
                                }
                              >
                                <FileText className="h-3 w-3" aria-hidden />v{report.versionNumber}{' '}
                                {report.status.toLowerCase()}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[12px] text-ink-400">No report</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
            <Pagination
              page={page}
              pageSize={data.pageSize}
              total={data.total}
              onPageChange={setPage}
            />
          </>
        )}
      </Card>

      <NewVisitDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(visit) => {
          state.reload();
          navigate(`/visits/${visit.id}`);
        }}
      />
    </div>
  );
}
