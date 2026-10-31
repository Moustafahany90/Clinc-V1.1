import { useEffect, useId, useState } from 'react';
import { Loader2, Phone, Search, UserRound, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { ageFromDob, formatDateOnly } from '../lib/format';
import type { Patient } from '../lib/types';
import { useDebounced } from '../lib/hooks';
import { cn, fullName } from '../lib/utils';
import { Avatar, Input } from './ui';

interface PatientSearchProps {
  value: Patient | null;
  onChange: (patient: Patient | null) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
  className?: string;
}

/** Searchable patient picker. Never shows clinical information. */
export function PatientSearch({
  value,
  onChange,
  placeholder = 'Search by name, number or phone…',
  disabled,
  autoFocus,
  id,
  className,
}: PatientSearchProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Patient[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebounced(query.trim(), 220);

  useEffect(() => {
    if (!debounced) {
      setResults([]);
      setError(null);
      return;
    }
    let active = true;
    setSearching(true);
    setError(null);
    api
      .get<{ patients: Patient[] }>('/patients', {
        params: { search: debounced, pageSize: 8 },
      })
      .then((res) => {
        if (active) setResults(res.data.patients);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setSearching(false);
      });
    return () => {
      active = false;
    };
  }, [debounced]);

  if (value) {
    return (
      <div
        className={cn(
          'flex items-center gap-3 rounded-xl border border-line bg-surface-muted/60 px-3 py-2.5',
          className,
        )}
      >
        <Avatar firstName={value.firstName} lastName={value.lastName} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-ink-900">{fullName(value)}</p>
          <p className="truncate text-[11px] text-ink-500">
            {value.patientNumber}
            {value.phone ? ` · ${value.phone}` : ''}
            {value.dateOfBirth ? ` · ${ageFromDob(value.dateOfBirth)}` : ''}
          </p>
        </div>
        {!disabled && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded-md p-1.5 text-ink-400 transition-colors hover:bg-white hover:text-ink-700"
            aria-label="Choose a different patient"
            title="Change patient"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn('relative', className)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Input
        id={inputId}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        icon={<Search className="h-4 w-4" aria-hidden />}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${inputId}-results`}
      />

      {open && (query.trim().length > 0 || results.length > 0) && (
        <div
          id={`${inputId}-results`}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+0.375rem)] z-30 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lift scrollbar-thin"
        >
          {searching && results.length === 0 && (
            <p className="flex items-center gap-2 px-3 py-3 text-[12px] text-ink-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Searching patients…
            </p>
          )}

          {error && <p className="px-3 py-3 text-[12px] text-clay-700">{error}</p>}

          {!searching && !error && results.length === 0 && query.trim().length > 0 && (
            <div className="px-3 py-3">
              <p className="text-[12px] font-medium text-ink-700">No matching patient</p>
              <p className="mt-0.5 text-[11px] text-ink-500">
                Create a new patient from the Patients page or the appointment dialog.
              </p>
            </div>
          )}

          {results.map((patient) => (
            <button
              key={patient.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                onChange(patient);
                setQuery('');
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-brand-50/70 focus:bg-brand-50/70 focus:outline-none"
            >
              <Avatar firstName={patient.firstName} lastName={patient.lastName} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink-900">
                  {fullName(patient)}
                </span>
                <span className="block truncate text-[11px] text-ink-500">
                  {patient.patientNumber}
                  {patient.phone ? ` · ${patient.phone}` : ''}
                  {patient.dateOfBirth ? ` · ${formatDateOnly(patient.dateOfBirth)}` : ''}
                </span>
              </span>
            </button>
          ))}

          {!searching && results.length > 0 && (
            <p className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-[10px] text-ink-400">
              <Phone className="h-3 w-3" aria-hidden />
              {results.length} matching patient{results.length === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}

      {!query && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-400">
          <UserRound className="h-3 w-3" aria-hidden />
          Start typing to search existing patients.
        </p>
      )}
    </div>
  );
}
