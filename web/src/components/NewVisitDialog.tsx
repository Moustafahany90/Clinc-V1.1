import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stethoscope } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import type { Patient, Visit } from '../lib/types';
import { PatientSearch } from './PatientSearch';
import { useToast } from './toast';
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

export function NewVisitDialog({
  open,
  onOpenChange,
  initialPatient = null,
  appointmentId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPatient?: Patient | null;
  appointmentId?: string;
  onCreated?: (visit: Visit) => void;
}) {
  const { user } = useAuth();
  const { doctors } = useClinic();
  const navigate = useNavigate();
  const toast = useToast();
  const [patient, setPatient] = useState<Patient | null>(initialPatient);
  const [doctorId, setDoctorId] = useState('');
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [examinationType, setExaminationType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPatient(initialPatient);
    setDoctorId(user?.role === 'DOCTOR' ? user.id : doctors[0]?.id ?? '');
    setChiefComplaint('');
    setExaminationType('');
    setBusy(false);
    setError(null);
  }, [open, initialPatient, user, doctors]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!patient) {
      setError('Select the patient for this visit.');
      return;
    }
    if (!doctorId) {
      setError('Select the doctor responsible for this visit.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ visit: Visit }>('/visits', {
        patientId: patient.id,
        doctorId,
        ...(appointmentId ? { appointmentId } : {}),
        ...(chiefComplaint.trim() ? { chiefComplaint: chiefComplaint.trim() } : {}),
        ...(examinationType.trim() ? { examinationType: examinationType.trim() } : {}),
      });
      toast.success('Visit started', `${patient.firstName} ${patient.lastName}`);
      onCreated?.(res.data.visit);
      onOpenChange(false);
      if (!onCreated) navigate(`/visits/${res.data.visit.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="md">
        <DialogHeader
          title="Start a visit"
          description="Clinical records are owned by the responsible doctor."
          icon={Stethoscope}
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            {!initialPatient && (
              <Field label="Patient" required>
                <PatientSearch value={patient} onChange={setPatient} autoFocus />
              </Field>
            )}
            {initialPatient && (
              <div className="rounded-xl border border-line bg-surface-muted px-3.5 py-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-400">
                  Patient
                </p>
                <p className="mt-0.5 text-sm font-medium text-ink-900">
                  {initialPatient.firstName} {initialPatient.lastName}
                  <span className="ml-2 font-mono text-[11px] text-ink-500">
                    {initialPatient.patientNumber}
                  </span>
                </p>
              </div>
            )}
            <Field label="Responsible doctor" required>
              <Select
                value={doctorId}
                onChange={(event) => setDoctorId(event.target.value)}
                disabled={user?.role === 'DOCTOR'}
              >
                <option value="">Select a doctor…</option>
                {doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    Dr {doctor.firstName} {doctor.lastName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Examination type" htmlFor="visit-exam-type" hint="e.g. Abdominal ultrasound">
              <Input
                id="visit-exam-type"
                value={examinationType}
                onChange={(event) => setExaminationType(event.target.value)}
                maxLength={200}
                placeholder="Abdominal ultrasound"
              />
            </Field>
            <Field label="Chief complaint / indication" htmlFor="visit-complaint">
              <Textarea
                id="visit-complaint"
                value={chiefComplaint}
                onChange={(event) => setChiefComplaint(event.target.value)}
                maxLength={2000}
                placeholder="Why is the patient being examined today?"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Start visit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
