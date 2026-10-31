import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarDays, Plus, UserPlus, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDebounced, useAsyncData } from '../lib/hooks';
import { ageFromDob, formatDateOnly } from '../lib/format';
import type { Patient } from '../lib/types';
import { fullName } from '../lib/utils';
import { PatientDialog } from '../components/PatientDialog';
import {
  Alert,
  Avatar,
  Button,
  EmptyState,
  Input,
  LoadingBlock,
  PageHeader,
  Pagination,
  SearchInput,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface PatientList {
  patients: Patient[];
  total: number;
  page: number;
  pageSize: number;
}

export function PatientsPage() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const debounced = useDebounced(search, 300);
  const pageSize = 25;

  useEffect(() => {
    setPage(1);
  }, [debounced]);

  const state = useAsyncData<PatientList>(
    async () => {
      const res = await api.get<PatientList>('/patients', {
        params: { page, pageSize, ...(debounced ? { search: debounced } : {}) },
      });
      return res.data;
    },
    [page, debounced],
  );

  const canWrite = hasPermission('PATIENTS_WRITE');
  const patients = state.data?.patients ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Patient records"
        title="Patients"
        description="Demographics only. Clinical notes belong to the treating doctor and are never shown here."
        actions={
          canWrite ? (
            <Button onClick={() => setCreateOpen(true)}>
              <UserPlus className="h-4 w-4" aria-hidden />
              New patient
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full sm:max-w-sm">
          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, patient number or phone…"
            aria-label="Search patients"
          />
        </div>
        <p className="text-[12px] text-ink-500">
          {state.data ? `${state.data.total} active patient${state.data.total === 1 ? '' : 's'}` : ' '}
        </p>
      </div>

      {state.error && (
        <Alert tone="danger" title="Could not load patients">
          {state.error}
        </Alert>
      )}

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        {state.loading && !state.data ? (
          <LoadingBlock />
        ) : patients.length === 0 ? (
          <EmptyState
            icon={Users}
            title={debounced ? 'No patients match that search' : 'No patients yet'}
            description={
              debounced
                ? 'Try a different name, patient number or phone number.'
                : 'Register the first patient, or create one inline while booking an appointment.'
            }
            action={
              canWrite ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <UserPlus className="h-3.5 w-3.5" aria-hidden />
                  New patient
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
                    <TH>Patient</TH>
                    <TH>Number</TH>
                    <TH>Phone</TH>
                    <TH>Date of birth</TH>
                    <TH>Appointments</TH>
                    <TH>Registered</TH>
                    <TH className="text-right">Open</TH>
                  </TR>
                </THead>
                <TBody>
                  {patients.map((patient) => (
                    <TR key={patient.id} interactive onClick={() => navigate(`/patients/${patient.id}`)}>
                      <TD>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Avatar firstName={patient.firstName} lastName={patient.lastName} size="sm" />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-ink-900">{fullName(patient)}</p>
                            <p className="truncate text-[11px] text-ink-500">
                              {patient.gender
                                ? patient.gender.charAt(0) + patient.gender.slice(1).toLowerCase()
                                : 'Gender not recorded'}
                            </p>
                          </div>
                        </div>
                      </TD>
                      <TD className="tabular whitespace-nowrap font-medium">{patient.patientNumber}</TD>
                      <TD className="whitespace-nowrap">{patient.phone ?? '—'}</TD>
                      <TD className="whitespace-nowrap">
                        {patient.dateOfBirth ? (
                          <span>
                            {formatDateOnly(patient.dateOfBirth)}
                            <span className="ml-1 text-[11px] text-ink-400">
                              {ageFromDob(patient.dateOfBirth)}
                            </span>
                          </span>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD>
                        <span className="inline-flex items-center gap-1.5 text-ink-600">
                          <CalendarDays className="h-3.5 w-3.5 text-ink-400" aria-hidden />
                          {patient._count?.appointments ?? 0}
                        </span>
                      </TD>
                      <TD className="whitespace-nowrap text-ink-500">{formatDateOnly(patient.createdAt)}</TD>
                      <TD className="text-right">
                        <Button asChild size="sm" variant="ghost">
                          <Link to={`/patients/${patient.id}`}>View</Link>
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
            <Pagination
              page={state.data?.page ?? page}
              pageSize={state.data?.pageSize ?? pageSize}
              total={state.data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </div>

      <PatientDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(patient) => {
          state.reload();
          navigate(`/patients/${patient.id}`);
        }}
      />
    </div>
  );
}
