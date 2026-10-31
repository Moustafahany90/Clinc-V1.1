import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, UserPlus, UserRoundPen } from 'lucide-react';
import { api, errorMessage, toApiFailure } from '../lib/api';
import { useToast } from './toast';
import type { Patient } from '../lib/types';
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Select,
  Textarea,
} from './ui';

interface DuplicateMatch {
  id: string;
  patientNumber: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  dateOfBirth: string | null;
}

const emptyForm = {
  firstName: '',
  lastName: '',
  phone: '',
  referringDoctor: '',
  dateOfBirth: '',
  gender: '',
  nationalId: '',
  address: '',
  notes: '',
};

type PatientForm = typeof emptyForm;

function formFromPatient(patient: Patient | null): PatientForm {
  if (!patient) return emptyForm;
  return {
    firstName: patient.firstName,
    lastName: patient.lastName,
    phone: patient.phone ?? '',
    referringDoctor: patient.referringDoctor ?? '',
    dateOfBirth: patient.dateOfBirth ? patient.dateOfBirth.slice(0, 10) : '',
    gender: patient.gender ?? '',
    nationalId: patient.nationalId ?? '',
    address: patient.address ?? '',
    notes: patient.notes ?? '',
  };
}

export function PatientDialog({
  open,
  onOpenChange,
  patient,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patient?: Patient | null;
  onSaved?: (patient: Patient) => void;
}) {
  const editing = Boolean(patient);
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState<PatientForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);

  useEffect(() => {
    if (open) {
      setForm(formFromPatient(patient ?? null));
      setError(null);
      setDuplicates([]);
      setBusy(false);
    }
  }, [open, patient]);

  function update<K extends keyof PatientForm>(key: K, value: PatientForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(acknowledgeDuplicates = false) {
    setError(null);
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError('First and last name are required.');
      return;
    }
    if (!form.phone.trim()) {
      setError('Phone number is required.');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim(),
        referringDoctor: form.referringDoctor.trim(),
        dateOfBirth: form.dateOfBirth,
        ...(form.gender ? { gender: form.gender } : {}),
        nationalId: form.nationalId.trim(),
        address: form.address.trim(),
        notes: form.notes.trim(),
        ...(acknowledgeDuplicates ? { acknowledgeDuplicates: true } : {}),
      };

      const res = editing
        ? await api.patch<{ patient: Patient }>(`/patients/${patient!.id}`, payload)
        : await api.post<{ patient: Patient }>('/patients', payload);

      toast.success(editing ? 'Patient updated' : 'Patient created', `${res.data.patient.firstName} ${res.data.patient.lastName}`);
      onSaved?.(res.data.patient);
      onOpenChange(false);
    } catch (err) {
      const failure = toApiFailure(err);
      const matches = (failure.details as { matches?: DuplicateMatch[] } | undefined)?.matches;
      if (failure.status === 409 && matches?.length) {
        setDuplicates(matches);
        setError(
          'Similar patient records already exist. Open the existing record, or confirm that this is a different person.',
        );
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="lg">
        <DialogHeader
          title={editing ? 'Edit patient' : 'New patient'}
          description={
            editing
              ? `Update the demographic record for ${patient?.patientNumber ?? 'this patient'}.`
              : 'Only demographics are recorded here. Clinical notes belong to the treating doctor.'
          }
          icon={editing ? UserRoundPen : UserPlus}
        />

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && (
              <Alert tone={duplicates.length ? 'warning' : 'danger'} title={duplicates.length ? 'Possible duplicate' : 'Could not save patient'}>
                {error}
              </Alert>
            )}

            {duplicates.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-white">
                <p className="flex items-center gap-2 border-b border-amber-200 bg-amber-soft px-3 py-2 text-[12px] font-semibold text-amber-ink">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  Existing records are never merged automatically
                </p>
                <ul className="divide-y divide-line">
                  {duplicates.map((match) => (
                    <li key={match.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-ink-900">
                          {match.firstName} {match.lastName}
                        </p>
                        <p className="text-[11px] text-ink-500">
                          {match.patientNumber}
                          {match.phone ? ` · ${match.phone}` : ''}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          onOpenChange(false);
                          navigate(`/patients/${match.id}`);
                        }}
                      >
                        Open record
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-line px-3 py-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outlineDanger"
                    loading={busy}
                    onClick={() => void submit(true)}
                  >
                    Create a separate patient record
                  </Button>
                </div>
              </div>
            )}

            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="First name" htmlFor="patient-first" required>
                <Input
                  id="patient-first"
                  value={form.firstName}
                  onChange={(event) => update('firstName', event.target.value)}
                  autoFocus
                  required
                />
              </Field>
              <Field label="Last name" htmlFor="patient-last" required>
                <Input
                  id="patient-last"
                  value={form.lastName}
                  onChange={(event) => update('lastName', event.target.value)}
                  required
                />
              </Field>
              <Field
                label="Phone"
                htmlFor="patient-phone"
                hint="Used to find duplicate records."
                required
              >
                <Input
                  id="patient-phone"
                  type="tel"
                  value={form.phone}
                  onChange={(event) => update('phone', event.target.value)}
                  autoComplete="tel"
                  required
                />
              </Field>
              <Field label="Referring doctor" htmlFor="patient-referring" hint="Optional.">
                <Input
                  id="patient-referring"
                  value={form.referringDoctor}
                  maxLength={120}
                  onChange={(event) => update('referringDoctor', event.target.value)}
                />
              </Field>
              <Field label="Date of birth" htmlFor="patient-dob">
                <Input
                  id="patient-dob"
                  type="date"
                  value={form.dateOfBirth}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(event) => update('dateOfBirth', event.target.value)}
                />
              </Field>
              <Field label="Gender" htmlFor="patient-gender">
                <Select
                  id="patient-gender"
                  value={form.gender}
                  onChange={(event) => update('gender', event.target.value)}
                >
                  <option value="">Not recorded</option>
                  <option value="FEMALE">Female</option>
                  <option value="MALE">Male</option>
                  <option value="OTHER">Other</option>
                  <option value="UNSPECIFIED">Unspecified</option>
                </Select>
              </Field>
              <Field label="National ID" htmlFor="patient-national" hint="Optional.">
                <Input
                  id="patient-national"
                  value={form.nationalId}
                  onChange={(event) => update('nationalId', event.target.value)}
                />
              </Field>
              <Field label="Address" htmlFor="patient-address" hint="Optional.">
                <Textarea
                  id="patient-address"
                  value={form.address}
                  onChange={(event) => update('address', event.target.value)}
                  rows={2}
                />
              </Field>
              <Field
                label="Reception notes"
                htmlFor="patient-notes"
                hint="Administrative only. Do not record clinical findings here."
                className="sm:col-span-2"
              >
                <Textarea
                  id="patient-notes"
                  value={form.notes}
                  onChange={(event) => update('notes', event.target.value)}
                  rows={2}
                />
              </Field>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            {duplicates.length > 0 ? (
              <Button
                type="button"
                variant="danger"
                loading={busy}
                onClick={() => void submit(true)}
              >
                Create separate record
              </Button>
            ) : (
              <Button type="submit" loading={busy}>
                {editing ? 'Save changes' : 'Create patient'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
