import { useState } from 'react';
import { CircleCheck, CircleX, FlaskConical } from 'lucide-react';

import { useEvalRuns } from '@/api/hooks';
import type { EvalMetric } from '@/api/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { RunExperimentDialog } from '@/components/runway/RunExperimentDialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

function SummaryCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'success' | 'danger';
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-2xl font-semibold',
          tone === 'success' && 'text-success',
          tone === 'danger' && 'text-destructive'
        )}
      >
        {value}
      </div>
      {detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function metricPassed(metric: EvalMetric): boolean {
  if (typeof metric.success === 'boolean') return metric.success;
  const total = Number(metric.total ?? 0);
  return total > 0 && Number(metric.passed ?? 0) === total;
}

function scoreLabel(metric: EvalMetric): string {
  const score = Number(metric.score);
  if (!Number.isFinite(score)) return '—';
  return score >= 0 && score <= 1 ? `${(score * 100).toFixed(1)}%` : score.toFixed(3);
}

export function RunsPage() {
  const runsQuery = useEvalRuns();
  const [selectedId, setSelectedId] = useState('');
  const [runEvalOpen, setRunEvalOpen] = useState(false);
  const runs = runsQuery.data ?? [];
  const runId = selectedId || runs[0]?.experiment_id || '';
  const run = runs.find(item => item.experiment_id === runId);
  const metrics = Object.entries(run?.metrics ?? {}).sort((left, right) => {
    const passOrder = Number(metricPassed(left[1])) - Number(metricPassed(right[1]));
    return passOrder || left[0].localeCompare(right[0]);
  });
  const passRate = run?.total ? run.passed / run.total : 0;
  const models = run?.evaluated_models.length ? run.evaluated_models : run ? [run.model] : [];

  return (
    <section>
      <PageHeader
        eyebrow="Evaluation"
        title="Runs"
        description="Completed eval executions with their real aggregate results. Comparison matrices appear only when multiple models or configurations were actually run against the same cases."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setRunEvalOpen(true)}>
            <FlaskConical className="size-3.5" />
            Run eval…
          </Button>
        }
      />

      <RunExperimentDialog open={runEvalOpen} onOpenChange={setRunEvalOpen} />

      {runsQuery.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-72" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      ) : runsQuery.isError ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-destructive">
          Failed to load eval runs: {(runsQuery.error as Error).message}
        </div>
      ) : !run ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No eval runs have been imported yet. Run a supported evaluation harness and export its
          summary to Chorus.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Select
              label="Eval run"
              allLabel="Latest"
              options={runs.map(item => ({
                value: item.experiment_id,
                label: `${item.source} · ${formatTimestamp(item.created_at)}`,
              }))}
              value={selectedId}
              onChange={event => setSelectedId(event.target.value)}
            />
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold',
                run.failed === 0
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-destructive/40 bg-destructive/10 text-destructive'
              )}
              data-testid="eval-run-status"
            >
              {run.failed === 0 ? (
                <CircleCheck className="size-3.5" />
              ) : (
                <CircleX className="size-3.5" />
              )}
              {run.failed === 0 ? 'Passed' : 'Needs attention'}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">{run.experiment_id}</span>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryCard label="Passed" value={String(run.passed)} tone="success" />
            <SummaryCard
              label="Failed"
              value={String(run.failed)}
              tone={run.failed ? 'danger' : 'neutral'}
            />
            <SummaryCard label="Total checks" value={String(run.total)} />
            <SummaryCard label="Pass rate" value={`${(passRate * 100).toFixed(1)}%`} />
          </div>

          <div className="mb-3 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Source', run.source],
              ['Evaluator', run.evaluator],
              ['Models observed', models.join(', ') || '—'],
              ['Completed', formatTimestamp(run.created_at)],
            ].map(([label, value]) => (
              <div key={label} className="bg-card px-4 py-3">
                <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  {label}
                </div>
                <div className="mt-1 break-words font-mono text-xs text-secondary-foreground">
                  {value}
                </div>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Metric results</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {metrics.length} metrics reported by {run.source}. Failed metrics are listed first.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-xs">
                <thead>
                  <tr className="text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    <th className="border-b border-border px-4 py-2.5">Metric</th>
                    <th className="border-b border-border px-3 py-2.5">Group</th>
                    <th className="border-b border-border px-3 py-2.5 text-right">Passed</th>
                    <th className="border-b border-border px-3 py-2.5 text-right">Failed</th>
                    <th className="border-b border-border px-3 py-2.5 text-right">Score</th>
                    <th className="border-b border-border px-4 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map(([name, metric]) => {
                    const passed = Number(metric.passed ?? 0);
                    const total = Number(metric.total ?? 0);
                    const failed = Math.max(0, total - passed);
                    const passedMetric = metricPassed(metric);
                    return (
                      <tr
                        key={name}
                        className="border-b border-border last:border-b-0 hover:bg-muted/30"
                      >
                        <td className="px-4 py-2.5 font-medium">{name}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">{metric.group ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-success">{passed}</td>
                        <td
                          className={cn(
                            'px-3 py-2.5 text-right font-mono',
                            failed ? 'text-destructive' : 'text-muted-foreground'
                          )}
                        >
                          {failed}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono">{scoreLabel(metric)}</td>
                        <td className="px-4 py-2.5">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1.5 font-medium',
                              passedMetric ? 'text-success' : 'text-destructive'
                            )}
                          >
                            {passedMetric ? (
                              <CircleCheck className="size-3.5" />
                            ) : (
                              <CircleX className="size-3.5" />
                            )}
                            {passedMetric ? 'Passed' : 'Failed'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
