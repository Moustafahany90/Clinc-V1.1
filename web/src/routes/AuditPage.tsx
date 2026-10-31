import { useState } from 'react';
import { ScrollText, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useAsyncData } from '../lib/hooks';
import { formatDateTime, todayInZone, addDays } from '../lib/format';
import type { AuditEntry } from '../lib/types';
import { fullName } from '../lib/utils';
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
  SearchInput,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface AuditList {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState(addDays(todayInZone(), -30));
  const [to, setTo] = useState(todayInZone());
  const [page, setPage] = useState(1);

  const state = useAsyncData<AuditList>(
    async () => {
      const res = await api.get<AuditList>('/audit', {
        params: {
          page,
          pageSize: 25,
          ...(entityType.trim() ? { entityType: entityType.trim() } : {}),
          ...(action.trim() ? { action: action.trim() } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      });
      return res.data;
    },
    [page, entityType, action, from, to],
  );

  const data = state.data;
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 25;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Audit log"
        description="Chronological record of security-relevant and clinical actions. Entries are append-only."
      />

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Entity type" htmlFor="audit-entity">
            <Input
              id="audit-entity"
              placeholder="e.g. Report, Payment"
              value={entityType}
              onChange={(event) => {
                setEntityType(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="Action contains" htmlFor="audit-action">
            <SearchInput
              id="audit-action"
              placeholder="e.g. report.amended"
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="From" htmlFor="audit-from">
            <Input
              id="audit-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="To" htmlFor="audit-to">
            <Input
              id="audit-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </Field>
        </div>
      </Card>

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Card>
        {state.loading ? (
          <LoadingBlock label="Loading audit entries…" />
        ) : !data || data.entries.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No audit entries match"
            description="Broaden the date range or clear the filters."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setEntityType('');
                  setAction('');
                  setFrom(addDays(todayInZone(), -30));
                  setTo(todayInZone());
                  setPage(1);
                }}
              >
                Reset filters
              </Button>
            }
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>Action</TH>
                    <TH>Entity</TH>
                    <TH>Actor</TH>
                    <TH>IP</TH>
                    <TH>Details</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.entries.map((entry) => (
                    <TR key={entry.id}>
                      <TD className="whitespace-nowrap text-ink-600">
                        {formatDateTime(entry.createdAt)}
                      </TD>
                      <TD>
                        <Badge tone="brand">{entry.action}</Badge>
                      </TD>
                      <TD className="whitespace-nowrap">
                        {entry.entityType}
                        {entry.entityId && (
                          <span className="ml-1 font-mono text-[11px] text-ink-400">
                            {entry.entityId.slice(0, 8)}
                          </span>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap">
                        {entry.actor ? fullName(entry.actor) : 'System'}
                        {entry.actor && (
                          <span className="ml-1 text-[11px] text-ink-400">{entry.actor.role}</span>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap font-mono text-[11px] text-ink-500">
                        {entry.ip ?? '—'}
                      </TD>
                      <TD className="max-w-[22rem]">
                        {entry.metadata && Object.keys(entry.metadata).length > 0 ? (
                          <details className="text-[11px] text-ink-500">
                            <summary className="cursor-pointer text-ink-600">View</summary>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-muted p-2 font-mono text-[10px] leading-relaxed">
                              {JSON.stringify(entry.metadata, null, 2)}
                            </pre>
                          </details>
                        ) : (
                          '—'
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
