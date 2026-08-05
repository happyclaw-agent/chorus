import type { LogRecord } from '@/api/types';
import { formatNsClock, formatNsOffset } from '@/lib/format';
import type { ServiceColor } from '@/lib/serviceColors';
import { cn } from '@/lib/utils';

function severityClass(severity: string): string {
  const level = severity.toUpperCase();
  if (level === 'ERROR' || level === 'FATAL' || level === 'CRITICAL') return 'text-destructive';
  if (level === 'WARN' || level === 'WARNING') return 'text-warning';
  return 'text-muted-foreground';
}

function severityDotClass(severity: string): string {
  const level = severity.toUpperCase();
  if (level === 'ERROR' || level === 'FATAL' || level === 'CRITICAL') return 'bg-destructive';
  if (level === 'WARN' || level === 'WARNING') return 'bg-warning';
  return 'bg-muted-foreground';
}

/**
 * Time-ordered log records for a trace, severity-colored and correlated with
 * the span waterfall by relative time. Pass `serviceColors` to tint each log's
 * service tag consistently with the waterfall, and `traceStartNs` to show each
 * record's offset from the start of the trace.
 */
export function LogPanel({
  logs,
  serviceColors,
  traceStartNs,
}: {
  logs: LogRecord[];
  serviceColors?: Map<string, ServiceColor>;
  traceStartNs?: number;
}) {
  if (logs.length === 0) {
    return (
      <div className="px-4 py-4 text-xs text-muted-foreground">
        No logs recorded for this trace.
      </div>
    );
  }

  const ordered = [...logs].sort((a, b) => a.ts_ns - b.ts_ns);
  const start = traceStartNs ?? ordered[0]?.ts_ns;

  return (
    <ul className="divide-y divide-border">
      {ordered.map((log, index) => {
        const color = serviceColors?.get(log.service);
        return (
          <li
            key={`${log.ts_ns}-${log.span_id ?? index}`}
            className="grid grid-cols-[auto_1fr] gap-x-3 px-4 py-2 text-xs"
          >
            <div className="flex items-center gap-2 pt-0.5">
              <span
                className={cn('size-1.5 shrink-0 rounded-full', severityDotClass(log.severity))}
                aria-hidden
              />
              <span
                className={cn(
                  'w-12 shrink-0 font-mono text-[10px] font-semibold uppercase',
                  severityClass(log.severity)
                )}
              >
                {log.severity}
              </span>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span
                  className={cn(
                    'font-mono text-[10px]',
                    color ? color.text : 'text-secondary-foreground'
                  )}
                >
                  {log.service}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {formatNsClock(log.ts_ns)}
                  {start != null ? (
                    <span className="ml-1 text-muted-foreground/70">
                      ({formatNsOffset(log.ts_ns, start)})
                    </span>
                  ) : null}
                </span>
              </div>
              <div className={cn('mt-0.5 break-words', severityClass(log.severity))}>
                {log.body}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
