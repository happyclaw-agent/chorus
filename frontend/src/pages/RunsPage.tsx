import { useMemo, useState } from 'react';
import { CircleCheck, CircleX, ExternalLink, FlaskConical } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useEvalResults, useEvalRuns } from '@/api/hooks';
import type { EvalFeedback, EvalMetric, EvalResult } from '@/api/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { RunExperimentDialog } from '@/components/runway/RunExperimentDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { traceDetailPath } from '@/constants/path';
import { formatTimestamp, truncate } from '@/lib/format';
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

function feedbackLabel(feedback: EvalFeedback | undefined): string {
  if (!feedback) return '—';
  if (typeof feedback.score === 'number') {
    return feedback.score >= 0 && feedback.score <= 1
      ? `${(feedback.score * 100).toFixed(1)}%`
      : feedback.score.toFixed(3);
  }
  if (feedback.value !== undefined) return String(feedback.value);
  return '—';
}

function jsonValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function primaryValue(value: Record<string, unknown> | null): string {
  if (!value) return '—';
  const entries = Object.entries(value);
  if (entries.length === 1) return jsonValue(entries[0][1]);
  return jsonValue(value);
}

function totalTokens(result: EvalResult): number | null {
  const input = result.execution?.input_tokens;
  const output = result.execution?.output_tokens;
  return input == null || output == null ? null : input + output;
}

function ResultDetail({
  result,
  onOpenChange,
}: {
  result: EvalResult | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={result !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>{result.example_id}</DialogTitle>
              <DialogDescription>
                Dataset example, application output, evaluator feedback, and execution telemetry.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ['Status', result.status],
                ['Tokens', totalTokens(result)?.toLocaleString() ?? '—'],
                [
                  'Cost',
                  result.execution?.cost_usd == null
                    ? '—'
                    : `$${result.execution.cost_usd.toFixed(6)}`,
                ],
                [
                  'Latency',
                  result.execution?.latency_ms == null
                    ? '—'
                    : `${Math.round(result.execution.latency_ms)} ms`,
                ],
                ['Model', result.execution?.models.join(', ') || '—'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border border-border bg-card px-3 py-2">
                  <div className="text-[9px] font-semibold tracking-wider text-muted-foreground uppercase">
                    {label}
                  </div>
                  <div className="mt-1 break-words font-mono text-[11px]">{value}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              {[
                ['Input', result.inputs],
                ['Reference output', result.reference_outputs],
                ['Actual output', result.outputs],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    {label as string}
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-[11px] whitespace-pre-wrap">
                    {jsonValue(value)}
                  </pre>
                </div>
              ))}
            </div>

            <div>
              <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                Evaluator feedback
              </div>
              <div className="overflow-hidden rounded-md border border-border">
                {result.feedback.map(feedback => (
                  <div
                    key={feedback.key}
                    className="grid gap-1 border-b border-border px-3 py-2.5 last:border-b-0 sm:grid-cols-[180px_90px_1fr]"
                  >
                    <span className="font-medium">{feedback.key}</span>
                    <span className="font-mono">{feedbackLabel(feedback)}</span>
                    <span className="text-muted-foreground">
                      {feedback.comment || feedback.error || '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {result.error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {result.error}
              </div>
            ) : null}

            {result.trace ? (
              <Button size="sm" variant="secondary" asChild>
                <Link
                  to={traceDetailPath(
                    result.trace.trace_id,
                    result.execution
                      ? result.execution.root_span_id
                      : (result.trace.root_span_id ?? undefined)
                  )}
                >
                  Open execution trace
                  <ExternalLink className="size-3.5" />
                </Link>
              </Button>
            ) : (
              <div className="text-xs text-muted-foreground">
                This example has no linked execution trace.
              </div>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function RunsPage() {
  const runsQuery = useEvalRuns();
  const [selectedId, setSelectedId] = useState('');
  const [selectedResult, setSelectedResult] = useState<EvalResult | null>(null);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [runEvalOpen, setRunEvalOpen] = useState(false);
  const runs = runsQuery.data ?? [];
  const runId = selectedId || runs[0]?.experiment_id || '';
  const run = runs.find(item => item.experiment_id === runId);
  const resultsQuery = useEvalResults(runId || undefined);
  const results = resultsQuery.data?.results ?? [];
  const feedbackKeys = useMemo(
    () =>
      Array.from(new Set(results.flatMap(result => result.feedback.map(feedback => feedback.key)))),
    [results]
  );
  const displayedResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...results]
      .filter(result => !failuresOnly || result.status !== 'passed')
      .filter(result => {
        if (!query) return true;
        return [result.example_id, primaryValue(result.inputs), primaryValue(result.outputs)]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
      .sort(
        (left, right) =>
          Number(left.status === 'passed') - Number(right.status === 'passed') ||
          left.example_id.localeCompare(right.example_id)
      );
  }, [failuresOnly, results, search]);
  const metrics = Object.entries(run?.metrics ?? {}).sort((left, right) => {
    const passOrder = Number(metricPassed(left[1])) - Number(metricPassed(right[1]));
    return passOrder || left[0].localeCompare(right[0]);
  });
  const passRate = run?.total ? run.passed / run.total : 0;

  return (
    <section>
      <PageHeader
        eyebrow="Evaluation"
        title="Runs"
        description="Experiments over datasets. Each row below is one evaluated example and opens into its data, feedback, telemetry, and trace."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setRunEvalOpen(true)}>
            <FlaskConical className="size-3.5" />
            Run eval…
          </Button>
        }
      />

      <RunExperimentDialog open={runEvalOpen} onOpenChange={setRunEvalOpen} />
      <ResultDetail
        result={selectedResult}
        onOpenChange={open => !open && setSelectedResult(null)}
      />

      {runsQuery.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-80 w-full" />
        </div>
      ) : runsQuery.isError ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-destructive">
          Failed to load eval runs: {(runsQuery.error as Error).message}
        </div>
      ) : !run ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No evaluation experiments have been imported yet.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Select
              label="Eval run"
              allLabel="Latest"
              options={runs.map(item => ({
                value: item.experiment_id,
                label: `${item.dataset || item.source} · ${formatTimestamp(item.created_at)}`,
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
            <SummaryCard label="Passed examples" value={String(run.passed)} tone="success" />
            <SummaryCard
              label="Failed examples"
              value={String(run.failed)}
              tone={run.failed ? 'danger' : 'neutral'}
            />
            <SummaryCard
              label="Examples"
              value={String(run.result_count || run.total)}
              detail={run.dataset || 'Dataset not recorded'}
            />
            <SummaryCard label="Pass rate" value={`${(passRate * 100).toFixed(1)}%`} />
          </div>

          {resultsQuery.isLoading ? (
            <Skeleton className="h-80 w-full" />
          ) : resultsQuery.isError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-5 text-sm text-destructive">
              Failed to load example results: {(resultsQuery.error as Error).message}
            </div>
          ) : results.length === 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-5 text-sm">
              <div className="font-semibold">
                This historical run only contains aggregate totals.
              </div>
              <p className="mt-1 text-muted-foreground">
                Re-run the evaluation harness after per-example export is enabled to populate the
                dataset rows, actual outputs, feedback, tokens, cost, latency, and trace drilldown.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold">Example results</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {displayedResults.length} of {results.length} examples · failed examples first
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    aria-label="Search examples"
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    placeholder="Search examples…"
                    className="h-8 w-48 rounded-md border border-input bg-background px-2.5 text-xs"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={failuresOnly}
                      onChange={event => setFailuresOnly(event.target.checked)}
                    />
                    Failures only
                  </label>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1100px] border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                      <th className="border-b border-border px-4 py-2.5">Example</th>
                      <th className="border-b border-border px-3 py-2.5">Input</th>
                      <th className="border-b border-border px-3 py-2.5">Output</th>
                      <th className="border-b border-border px-3 py-2.5">Reference</th>
                      {feedbackKeys.map(key => (
                        <th key={key} className="border-b border-border px-3 py-2.5 text-right">
                          {key}
                        </th>
                      ))}
                      <th className="border-b border-border px-3 py-2.5 text-right">Tokens</th>
                      <th className="border-b border-border px-3 py-2.5 text-right">Cost</th>
                      <th className="border-b border-border px-3 py-2.5 text-right">Latency</th>
                      <th className="border-b border-border px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedResults.map(result => {
                      const feedbackByKey = new Map(
                        result.feedback.map(feedback => [feedback.key, feedback])
                      );
                      return (
                        <tr
                          key={result.result_id}
                          className="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
                          onClick={() => setSelectedResult(result)}
                        >
                          <td className="px-4 py-2.5 font-mono text-[11px]">{result.example_id}</td>
                          <td className="max-w-72 px-3 py-2.5">
                            {truncate(primaryValue(result.inputs), 100)}
                          </td>
                          <td className="max-w-72 px-3 py-2.5">
                            {truncate(primaryValue(result.outputs), 100)}
                          </td>
                          <td className="max-w-72 px-3 py-2.5 text-muted-foreground">
                            {truncate(primaryValue(result.reference_outputs), 100)}
                          </td>
                          {feedbackKeys.map(key => (
                            <td key={key} className="px-3 py-2.5 text-right font-mono">
                              {feedbackLabel(feedbackByKey.get(key))}
                            </td>
                          ))}
                          <td className="px-3 py-2.5 text-right font-mono">
                            {totalTokens(result)?.toLocaleString() ?? '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono">
                            {result.execution?.cost_usd == null
                              ? '—'
                              : `$${result.execution.cost_usd.toFixed(5)}`}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono">
                            {result.execution?.latency_ms == null
                              ? '—'
                              : `${Math.round(result.execution.latency_ms)} ms`}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1.5 font-medium',
                                result.status === 'passed' ? 'text-success' : 'text-destructive'
                              )}
                            >
                              {result.status === 'passed' ? (
                                <CircleCheck className="size-3.5" />
                              ) : (
                                <CircleX className="size-3.5" />
                              )}
                              {result.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <details className="mt-3 rounded-lg border border-border bg-card">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
              Evaluator summary ({metrics.length})
            </summary>
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-[620px] text-xs">
                <thead>
                  <tr className="text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    <th className="px-4 py-2.5">Evaluator</th>
                    <th className="px-3 py-2.5 text-right">Passed</th>
                    <th className="px-3 py-2.5 text-right">Examples</th>
                    <th className="px-4 py-2.5 text-right">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map(([name, metric]) => (
                    <tr key={name} className="border-t border-border">
                      <td className="px-4 py-2.5">{name}</td>
                      <td className="px-3 py-2.5 text-right font-mono">
                        {Number(metric.passed ?? 0)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono">
                        {Number(metric.total ?? 0)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">{scoreLabel(metric)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
