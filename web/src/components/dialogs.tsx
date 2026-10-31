import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Textarea,
} from './ui';

type Tone = 'danger' | 'primary' | 'warning';

const toneIcon: Record<Tone, LucideIcon> = {
  danger: ShieldAlert,
  primary: HelpCircle,
  warning: AlertTriangle,
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: Tone;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const Icon = toneIcon[tone];
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm">
        <DialogHeader title={title} description={description} icon={Icon} />
        {children && <DialogBody>{children}</DialogBody>}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label = 'Reason',
  placeholder = 'Explain what is changing and why.',
  confirmLabel = 'Confirm',
  tone = 'danger',
  minLength = 3,
  busy = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  label?: string;
  placeholder?: string;
  confirmLabel?: string;
  tone?: Tone;
  minLength?: number;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const Icon = toneIcon[tone];

  useEffect(() => {
    if (!open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  function submit() {
    const clean = reason.trim();
    if (clean.length < minLength) {
      setError(`Enter at least ${minLength} characters so the change is explainable.`);
      return;
    }
    setError(null);
    onConfirm(clean);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm">
        <DialogHeader title={title} description={description} icon={Icon} />
        <DialogBody className="space-y-3">
          {children}
          <div>
            <label htmlFor="reason-dialog-field" className="mb-1.5 block text-[13px] font-medium text-ink-700">
              {label} <span className="text-clay-500">*</span>
            </label>
            <Textarea
              id="reason-dialog-field"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={placeholder}
              invalid={Boolean(error)}
              autoFocus
              maxLength={500}
            />
            {error ? (
              <p className="mt-1 text-xs text-clay-700">{error}</p>
            ) : (
              <p className="mt-1 text-[11px] text-ink-400">
                This reason is stored in the audit trail and cannot be edited later.
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={submit}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reusable success panel for one-time secrets such as invite links. */
export function OneTimeLink({
  title = 'Setup link created',
  url,
  note,
  onClose,
}: {
  title?: string;
  url: string;
  note?: string;
  onClose?: () => void;
}) {
  return (
    <Alert tone="warning" title={title} className="mt-3">
      <p>
        {note ??
          'Share this single-use link with the staff member. It expires in 72 hours and cannot be shown again.'}
      </p>
      <div className="mt-2 flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg border border-amber-200 bg-white/70 px-2.5 py-2 text-[11px] text-ink-800">
          {url}
        </code>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void navigator.clipboard.writeText(url)}
        >
          Copy link
        </Button>
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose}>
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Done
          </Button>
        )}
      </div>
    </Alert>
  );
}
