import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FilePlus2, FileText, Printer, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAsyncData } from '../lib/hooks';
import { dateOnlyInZone, formatDateTime } from '../lib/format';
import type { Patient, ReportSummary } from '../lib/types';
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

interface ReportList {
  reports: ReportSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export function ReportsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [patient, setPatient] = useState<Patient | null>(null);
  const [page, setPage] = useState(1);

  const state = useAsyncData<ReportList>(
    async () => {
      const res = await api.get<ReportList>('/reports', {
        params: {
          page,
          pageSize: 25,
          ...(status ? { status } : {}),
          ...(patient ? { patientId: patient.id } : {}),
        },
      });
      return res.data;
    },
    [page, status, patient?.id],
  );

  const data = state.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Clinical"
        title="Reports"
        description="Draft and finalized ultrasound reports. Finalized reports are immutable; corrections create a new version."
        actions={
          <Button asChild>
            <Link to="/reports/new">
              <FilePlus2 className="h-4 w-4" aria-hidden />
              New report
            </Link>
          </Button>
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
              <option value="FINALIZED">Finalized</option>
              <option value="AMENDED">Amended</option>
            </Select>
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
          <div className="flex items-end">
            <p className="text-[12px] text-ink-500">
              <Search className="mr-1 inline h-3.5 w-3.5" aria-hidden />
              {data ? `${data.total} report${data.total === 1 ? '' : 's'}` : 'Loading…'}
            </p>
          </div>
        </div>
      </Card>

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Card>
        {state.loading && !data ? (
          <LoadingBlock label="Loading reports…" />
        ) : !data || data.reports.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No reports found"
            description="Create a draft from a clinical visit, or adjust the filters."
            action={
              <Button variant="secondary" asChild>
                <Link to="/reports/new">New report</Link>
              </Button>
            }
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Patient</TH>
                    <TH>Visit date</TH>
                    <TH>Version</TH>
                    <TH>Status</TH>
                    <TH>Finalized</TH>
                    <TH>Last change</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.reports.map((report) => (
                    <TR
                      key={report.id}
                      interactive
                      onClick={() => navigate(`/reports/${report.id}`)}
                    >
                      <TD>
                        {report.visit?.patient ? (
                          <>
                            <Link
                              to={`/patients/${report.visit.patient.id}`}
                              onClick={(event) => event.stopPropagation()}
                              className="font-medium text-ink-900 hover:text-brand-700"
                            >
                              {report.visit.patient.firstName} {report.visit.patient.lastName}
                            </Link>
                            <p className="mt-0.5 font-mono text-[11px] text-ink-400">
                              {report.visit.patient.patientNumber}
                            </p>
                          </>
                        ) : (
                          'Patient'
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-ink-600">
                        {report.visit ? dateOnlyInZone(report.visit.visitDate) : '—'}
                      </TD>
                      <TD>
                        <Badge tone={report.versionNumber > 1 ? 'brand' : 'muted'}>
                          v{report.versionNumber}
                        </Badge>
                      </TD>
                      <TD>
                        <StatusBadge status={report.status} />
                      </TD>
                      <TD className="whitespace-nowrap text-ink-500">
                        {formatDateTime(report.finalizedAt)}
                      </TD>
                      <TD className="whitespace-nowrap text-ink-500">
                        {formatDateTime(report.updatedAt)}
                      </TD>
                      <TD>
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              navigate(`/reports/${report.id}`);
                            }}
                          >
                            Open
                          </Button>
                          <Button
                            size="iconSm"
                            variant="ghost"
                            aria-label="Print report"
                            onClick={(event) => {
                              event.stopPropagation();
                              window.open(`/reports/${report.id}/print`, '_blank');
                            }}
                          >
                            <Printer className="h-4 w-4" aria-hidden />
                          </Button>
                        </div>
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
    </div>
  );
}
