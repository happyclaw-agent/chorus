import type { RunMode } from '@/api/types';
import { cn } from '@/lib/utils';

import { MODE_META } from './modes';

/** Small pill for a lifecycle mode (dev/ci/prod), colored via chart tokens. */
export function ModeChip({ mode, className }: { mode: RunMode; className?: string }) {
  const meta = MODE_META[mode];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        meta.chip,
        className
      )}
    >
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  );
}

/** Neutral chip for a service name (component involved in the group). */
export function ServiceChip({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground',
        className
      )}
    >
      {name}
    </span>
  );
}
