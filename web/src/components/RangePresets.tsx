import { cn } from '../lib/utils';

export interface RangePreset {
  label: string;
  active?: boolean;
  onClick: () => void;
}

/**
 * Compact date-range shortcuts used by the finance list pages. Rendered as
 * chips rather than bare text so the active range is obvious and each preset
 * has a comfortable pointer target.
 */
export function RangePresets({
  presets,
  className,
  label = 'Date range presets',
}: {
  presets: RangePreset[];
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} role="group" aria-label={label}>
      {presets.map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={preset.onClick}
          aria-pressed={preset.active === undefined ? undefined : preset.active}
          className={cn(
            'rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            preset.active
              ? 'border-brand-200 bg-brand-50 text-brand-800'
              : 'border-transparent text-brand-700 hover:border-brand-100 hover:bg-brand-50/60 hover:text-brand-800',
          )}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
