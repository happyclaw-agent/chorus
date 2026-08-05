import { useEffect } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useTrace } from '@/api/hooks';
import type { GateVerdict, GridCell, GridRow, Verdict } from '@/api/types';
import { SpanWaterfall } from '@/components/traces/SpanWaterfall';
import { StatusPill } from '@/components/traces/StatusPill';
import { Button } from '@/components/ui/button';
import { traceDetailPath } from '@/constants/path';
import { formatCost, formatDuration, shortTraceId } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatScore, parseScore } from '@/lib/verdicts';

const VERDICT_TEXT: Record<Verdict, string> = {
  pass: 'text-success',
  fail: 'text-destructive',
  warn: 'text-warning',
  na: 'text-muted-foreground',
};

function ArmMeta({
  label,
  version,
  cell,
  highlight,
}: {
  label: string;
  version: string | null;
  cell: GridCell | null;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-border bg-background px-3 py-2.5',
        highlight && 'border-destructive/50'
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          {label}
        </span>
        <span className="rounded bg-muted/60 px-1.5 font-mono text-[10px] text-secondary-foreground">
          {version ?? '—'}
        </span>
      </div>
      {cell ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <StatusPill status={cell.status} />
          <span className="font-mono">{formatDuration(cell.latency_ms)}</span>
          <span className="font-mono">{formatCost(cell.cost_usd)}</span>
          <Link
            to={traceDetailPath(cell.trace_id)}
            className="inline-flex items-center gap-0.5 font-mono text-[11px] text-link hover:underline"
          >
            {shortTraceId(cell.trace_id)}
            <ArrowUpRight className="size-3" />
          </Link>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No run for this arm.</div>
      )}
    </div>
  );
}

function ArmWaterfall({ title, traceId }: { title: string; traceId: string | undefined }) {
  const traceQuery = useTrace(traceId);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <div className="border-b border-border px-3 py-2 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </div>
      <div className="p-2">
        {!traceId ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">No run for this arm.</div>
        ) : traceQuery.isLoading ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">Loading spans…</div>
        ) : traceQuery.data?.spans ? (
          <SpanWaterfall root={traceQuery.data.spans} />
        ) : (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No spans captured for this trace.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Side-by-side baseline vs candidate comparison for one Look: run meta, score
 * diff (gate-failing evaluators highlighted), and both span waterfalls. The
 * verdicts/regression flags come from the backend promotion gate.
 */
export function ComparisonDrawer({
  row,
  evaluators,
  verdicts,
  failingEvaluators,
  blocked,
  baselineVersion,
  candidateVersion,
  exampleInput,
  onClose,
}: {
  row: GridRow;
  evaluators: string[];
  /** Per-evaluator gate verdicts for this Look (from the gate response). */
  verdicts?: Record<string, GateVerdict>;
  /** Evaluators the gate marked `fail` on this Look. */
  failingEvaluators: string[];
  /** True when the gate counted this Look as a regression. */
  blocked: boolean;
  baselineVersion: string | null;
  candidateVersion: string | null;
  exampleInput: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const regressed = new Set(failingEvaluators);
  const errorTransition = row.candidate?.status === 'error' && row.baseline?.status !== 'error';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-background/70" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-label={`Comparison for ${row.example_id}`}
        className="fixed top-0 right-0 bottom-0 z-50 flex w-[min(780px,94vw)] flex-col border-l border-border bg-card shadow-2xl"
      >
        <div className="border-b border-border px-5 py-4">
          <div
            className={cn(
              'text-[10px] font-semibold tracking-wider uppercase',
              blocked ? 'text-destructive' : 'text-success'
            )}
          >
            {blocked
              ? `Regression · ${[...(errorTransition ? ['run error'] : []), ...regressed].join(
                  ' + '
                )}`
              : 'No regression'}
          </div>
          <h2 className="mt-1 pr-8 text-sm font-semibold">{exampleInput ?? row.example_id}</h2>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            <span className="font-mono">{row.example_id}</span> · {baselineVersion ?? 'baseline'}{' '}
            (baseline) vs {candidateVersion ?? 'candidate'} (candidate)
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-3 right-3 text-muted-foreground"
            onClick={onClose}
            aria-label="Close comparison"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <ArmMeta label="Baseline" version={baselineVersion} cell={row.baseline} />
            <ArmMeta
              label="Candidate"
              version={candidateVersion}
              cell={row.candidate}
              highlight={blocked}
            />
          </div>

          <div className="overflow-hidden rounded-md border border-border bg-background">
            <div className="border-b border-border px-3 py-2 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              Scores
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  <th className="px-3 py-1.5 font-semibold">Evaluator</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Baseline</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Candidate</th>
                </tr>
              </thead>
              <tbody>
                {evaluators.map(evaluator => {
                  const gv = verdicts?.[evaluator];
                  const verdict: Verdict = gv?.verdict ?? 'na';
                  const baselineRaw = gv?.baseline ?? row.baseline?.scores[evaluator];
                  const candidateRaw = gv?.candidate ?? row.candidate?.scores[evaluator];
                  return (
                    <tr
                      key={evaluator}
                      className={cn(
                        'border-t border-border',
                        regressed.has(evaluator) && 'bg-destructive/10'
                      )}
                    >
                      <td className="px-3 py-1.5 font-medium">
                        {evaluator}
                        {gv?.reason ? (
                          <div className="text-[10px] font-normal text-muted-foreground">
                            {gv.reason}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {formatScore(parseScore(baselineRaw))}
                      </td>
                      <td className={cn('px-3 py-1.5 text-right font-mono', VERDICT_TEXT[verdict])}>
                        {formatScore(parseScore(candidateRaw))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ArmWaterfall
            title={`Baseline waterfall · ${baselineVersion ?? '—'}`}
            traceId={row.baseline?.trace_id}
          />
          <ArmWaterfall
            title={`Candidate waterfall · ${candidateVersion ?? '—'}`}
            traceId={row.candidate?.trace_id}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          {row.baseline ? (
            <Button variant="secondary" size="sm" asChild>
              <Link to={traceDetailPath(row.baseline.trace_id)}>Open baseline trace</Link>
            </Button>
          ) : null}
          {row.candidate ? (
            <Button variant="secondary" size="sm" asChild>
              <Link to={traceDetailPath(row.candidate.trace_id)}>Open candidate trace</Link>
            </Button>
          ) : null}
          <div className="ml-auto">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
