import { cn } from '@/lib/utils';

/** ok/error status indicator (dot + label) using --success / --destructive tokens. */
export function StatusPill({ status }: { status: string }) {
  const isOk = status === 'ok';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap',
        isOk ? 'text-success' : 'text-destructive'
      )}
    >
      <span className={cn('size-1.5 rounded-full', isOk ? 'bg-success' : 'bg-destructive')} />
      {isOk ? 'OK' : 'Error'}
    </span>
  );
}
