import { useEffect, useState, type FormEvent } from 'react';
import { Ban, Plus, Receipt, Wallet } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import { addDays, endOfMonth, formatDateOnly, startOfMonth, todayInZone } from '../lib/format';
import { formatMoney, parseMoneyToMinor } from '../lib/money';
import type { Expense, ExpenseCategory } from '../lib/types';
import { ReasonDialog } from '../components/dialogs';
import { useToast } from '../components/toast';
import {
  Alert,
  Badge,
  Button,
  Card,
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
  StatusBadge,
  Switch,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface ExpenseList {
  expenses: Expense[];
  total: number;
  page: number;
  pageSize: number;
  totalAmountMinor: number;
}

export function ExpensesPage() {
  const { hasPermission } = useAuth();
  const { currency, paymentMethods, timezone } = useClinic();
  const toast = useToast();

  const today = todayInZone(timezone);
  const [from, setFrom] = useState(startOfMonth(today));
  const [to, setTo] = useState(endOfMonth(today));
  const [categoryId, setCategoryId] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<Expense | null>(null);
  const [busy, setBusy] = useState(false);

  const canWrite = hasPermission('EXPENSES_WRITE');

  const categoriesState = useAsyncData<{ expenseCategories: ExpenseCategory[] }>(
    async () => (await api.get<{ expenseCategories: ExpenseCategory[] }>('/settings/expense-categories')).data,
    [],
    canWrite || hasPermission('EXPENSES_READ'),
  );

  const state = useAsyncData<ExpenseList>(
    async () => {
      const res = await api.get<ExpenseList>('/expenses', {
        params: {
          page,
          pageSize: 25,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(categoryId ? { categoryId } : {}),
          ...(includeVoid ? { includeVoid: true } : {}),
        },
      });
      return res.data;
    },
    [page, from, to, categoryId, includeVoid],
  );

  const categories = (categoriesState.data?.expenseCategories ?? []).filter((c) => c.isActive);
  const data = state.data;
  const expenses = data?.expenses ?? [];

  async function voidExpense(reason: string) {
    if (!voidTarget) return;
    setBusy(true);
    try {
      await api.post(`/expenses/${voidTarget.id}/void`, { reason });
      toast.success('Expense voided');
      setVoidTarget(null);
      state.reload();
    } catch (err) {
      toast.error('Could not void the expense', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Expenses"
        description="Clinic running costs, recorded separately from patient charges and payments. Voiding keeps the original entry in the ledger history."
        actions={
          canWrite ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Record expense
            </Button>
          ) : undefined
        }
      />

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="From">
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="Category">
            <Select
              value={categoryId}
              onChange={(event) => {
                setCategoryId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end pb-2">
            <Switch
              checked={includeVoid}
              onCheckedChange={(next) => {
                setIncludeVoid(next);
                setPage(1);
              }}
              label="Show voided"
              description="Include reversed entries"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
          <button
            type="button"
            className="font-medium text-brand-700 hover:text-brand-800"
            onClick={() => {
              setFrom(startOfMonth(today));
              setTo(endOfMonth(today));
              setPage(1);
            }}
          >
            This month
          </button>
          <span>·</span>
          <button
            type="button"
            className="font-medium text-brand-700 hover:text-brand-800"
            onClick={() => {
              setFrom(addDays(today, -30));
              setTo(today);
              setPage(1);
            }}
          >
            Last 30 days
          </button>
          <span>·</span>
          <button
            type="button"
            className="font-medium text-brand-700 hover:text-brand-800"
            onClick={() => {
              setFrom('');
              setTo('');
              setPage(1);
            }}
          >
            All time
          </button>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="flex items-center gap-3 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-clay-50 text-clay-700">
            <Receipt className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-500">
              Total in view
            </p>
            <p className="tabular mt-1 text-xl font-semibold text-ink-950">
              {formatMoney(data?.totalAmountMinor ?? 0, currency)}
            </p>
          </div>
        </Card>
        <Card className="flex items-center gap-3 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink-100 text-ink-600">
            <Wallet className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-500">
              Entries
            </p>
            <p className="tabular mt-1 text-xl font-semibold text-ink-950">{data?.total ?? 0}</p>
          </div>
        </Card>
      </div>

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Card>
        {state.loading && !data ? (
          <LoadingBlock label="Loading expenses…" />
        ) : expenses.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No expenses in this period"
            description="Record a cost such as consumables, rent or utilities to keep the clinic books complete."
            action={
              canWrite ? (
                <Button variant="secondary" onClick={() => setCreateOpen(true)}>
                  Record expense
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
                    <TH>Category</TH>
                    <TH>Description</TH>
                    <TH>Method</TH>
                    <TH>Recorded by</TH>
                    <TH className="text-right">Amount</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {expenses.map((expense) => (
                    <TR key={expense.id}>
                      <TD className="whitespace-nowrap text-ink-600">
                        {formatDateOnly(expense.expenseDate)}
                      </TD>
                      <TD className="whitespace-nowrap">{expense.category?.name ?? '—'}</TD>
                      <TD>
                        <p className="text-ink-800">{expense.description}</p>
                        {expense.reference && (
                          <p className="mt-0.5 text-[11px] text-ink-400">
                            Ref {expense.reference}
                          </p>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-ink-600">
                        {expense.method?.label ?? expense.methodKey ?? '—'}
                      </TD>
                      <TD className="whitespace-nowrap text-ink-600">
                        {expense.recordedBy
                          ? `${expense.recordedBy.firstName} ${expense.recordedBy.lastName}`
                          : '—'}
                      </TD>
                      <TD className="tabular whitespace-nowrap text-right font-medium">
                        {formatMoney(expense.amountMinor, currency)}
                      </TD>
                      <TD>
                        <StatusBadge status={expense.status} />
                        {expense.status === 'VOID' && expense.voidReason && (
                          <p className="mt-0.5 max-w-[14rem] text-[10px] text-ink-400">
                            {expense.voidReason}
                          </p>
                        )}
                      </TD>
                      <TD className="text-right">
                        {canWrite && expense.status === 'RECORDED' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setVoidTarget(expense)}
                          >
                            <Ban className="h-3.5 w-3.5" aria-hidden />
                            Void
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
            <Pagination
              page={page}
              pageSize={data?.pageSize ?? 25}
              total={data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </Card>

      <RecordExpenseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        categories={categories}
        onSaved={() => {
          setCreateOpen(false);
          state.reload();
        }}
      />

      <ReasonDialog
        open={voidTarget !== null}
        onOpenChange={(next) => !next && setVoidTarget(null)}
        title="Void this expense?"
        description={
          voidTarget
            ? `${voidTarget.category?.name ?? 'Expense'} · ${formatMoney(voidTarget.amountMinor, currency)} · ${formatDateOnly(voidTarget.expenseDate)}`
            : undefined
        }
        label="Void reason"
        confirmLabel="Void expense"
        busy={busy}
        onConfirm={(reason) => void voidExpense(reason)}
      />
    </div>
  );
}

function RecordExpenseDialog({
  open,
  onOpenChange,
  categories,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: ExpenseCategory[];
  onSaved: () => void;
}) {
  const { paymentMethods } = useClinic();
  const toast = useToast();

  const [date, setDate] = useState(todayInZone());
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [methodKey, setMethodKey] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDate(todayInZone());
    setCategoryId(categories[0]?.id ?? '');
    setAmount('');
    setDescription('');
    setMethodKey('');
    setReference('');
    setError(null);
  }, [open, categories]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const amountMinor = parseMoneyToMinor(amount);
    if (!amountMinor || amountMinor <= 0) {
      setError('Enter a valid amount greater than zero.');
      return;
    }
    if (!categoryId) {
      setError('Select an expense category.');
      return;
    }
    if (description.trim().length < 2) {
      setError('Describe the expense.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/expenses', {
        expenseDate: date,
        amountMinor,
        categoryId,
        description: description.trim(),
        ...(methodKey ? { methodKey } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        idempotencyKey: `expense-${date}-${amountMinor}-${Date.now()}`,
      });
      toast.success('Expense recorded', `${formatMoney(amountMinor)} · ${description.trim()}`);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader
          title="Record an expense"
          description="Expenses are clinic costs. They are not linked to a patient and never reduce a patient balance."
          icon={Receipt}
        />
        <form onSubmit={submit}>
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date" required>
                <Input
                  type="date"
                  value={date}
                  max={todayInZone()}
                  onChange={(event) => setDate(event.target.value)}
                  required
                />
              </Field>
              <Field label="Amount (EGP)" required>
                <Input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                  required
                />
              </Field>
            </div>
            <Field label="Category" required>
              <Select
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                required
              >
                <option value="">Select a category…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description" required>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="e.g. Ultrasound gel and probe covers"
                maxLength={300}
                required
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Paid with"
                hint="Optional. Link the cost to a payment method for cash reconciliation."
              >
                <Select value={methodKey} onChange={(event) => setMethodKey(event.target.value)}>
                  <option value="">Not specified</option>
                  {paymentMethods
                    .filter((method) => method.isActive)
                    .map((method) => (
                      <option key={method.key} value={method.key}>
                        {method.label}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Reference" hint="Invoice or receipt number.">
                <Input
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  maxLength={120}
                />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Record expense
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
