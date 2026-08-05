import { useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import {
  BookPlus,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  FlaskConical,
  Plus,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { useAllRuns, useDatasets, useEvaluationOverview, useEvalRuns } from '@/api/hooks';
import type {
  Dataset,
  DatasetExample,
  EvalDefinition,
  EvalMetric,
  EvalRun,
  Run,
} from '@/api/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { AddLookDialog } from '@/components/lookbooks/AddLookDialog';
import { EditExpectedField } from '@/components/lookbooks/EditExpectedField';
import { RemoveLookButton } from '@/components/lookbooks/RemoveLookButton';
import { RenameDatasetButton } from '@/components/lookbooks/RenameDatasetButton';
import { RunExperimentDialog } from '@/components/runway/RunExperimentDialog';
import { StatusPill } from '@/components/traces/StatusPill';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { PATHS, traceDetailPath } from '@/constants/path';
import { shortTraceId, truncate } from '@/lib/format';
import { cn } from '@/lib/utils';

function caseKey(dataset: string, exampleId: string): string {
  return `${dataset}\u0000${exampleId}`;
}

/** Latest traced execution per suite-local case identity. Quality verdicts live in eval runs. */
function latestRunsByExample(runs: Run[], datasets: Dataset[]): Map<string, Run> {
  const map = new Map<string, Run>();
  const datasetsByExample = new Map<string, string[]>();
  for (const dataset of datasets) {
    for (const example of dataset.examples) {
      const names = datasetsByExample.get(example.example_id) ?? [];
      names.push(dataset.name);
      datasetsByExample.set(example.example_id, names);
    }
  }
  for (const run of runs) {
    if (!run.example_id) continue;
    const dataset = run.eval_dataset ?? datasetsByExample.get(run.example_id)?.[0];
    const candidateDatasets = datasetsByExample.get(run.example_id) ?? [];
    if (!dataset || (!run.eval_dataset && candidateDatasets.length !== 1)) continue;
    const key = caseKey(dataset, run.example_id);
    const existing = map.get(key);
    if (!existing || (run.started_at ?? '') > (existing.started_at ?? '')) {
      map.set(key, run);
    }
  }
  return map;
}

function metadataString(example: DatasetExample, key: string): string | null {
  const value = example.metadata?.[key];
  return typeof value === 'string' ? value : null;
}

function metadataGraders(example: DatasetExample): string[] {
  const value = example.metadata?.['graders'];
  return Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string') : [];
}

/** Which subset of a Lookbook's Looks the table below the cards is showing. */
type StatusFilter = 'all' | 'ok' | 'error';

/**
 * A summary stat (case count, successful executions, errored executions) that filters the
 * Lookbook's own Look table in place — same accessible-button shape as
 * `DrilldownStat` (real `<button>`, `aria-label`, keyboard-operable,
 * `stopPropagation` so it doesn't also trigger the outer card's onClick), but
 * calling back into local state instead of navigating to Traces.
 */
function StatButton({
  label,
  testId,
  active,
  onClick,
  children,
}: {
  label: string;
  testId?: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const go = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
    onClick();
  };

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={go}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          go(event);
        }
      }}
      className={cn(
        'cursor-pointer rounded-sm text-left transition-colors',
        'hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
        active && 'text-primary underline decoration-2 underline-offset-4'
      )}
    >
      {children}
    </button>
  );
}

function DatasetCard({
  dataset,
  active,
  statusFilter,
  verdicts,
  onSelectStatus,
}: {
  dataset: Dataset;
  active: boolean;
  statusFilter: StatusFilter;
  verdicts: Map<string, Run>;
  onSelectStatus: (status: StatusFilter) => void;
}) {
  const withRuns = dataset.examples.filter(e => verdicts.has(caseKey(dataset.name, e.example_id)));
  const errored = withRuns.filter(
    e => verdicts.get(caseKey(dataset.name, e.example_id))!.status === 'error'
  ).length;
  const successful = withRuns.length - errored;

  return (
    // A div (not a <button>) so the stat counts below can be their own real,
    // keyboard-accessible <button>s — a <button> may not contain interactive
    // descendants.
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelectStatus('all')}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelectStatus('all');
        }
      }}
      className={cn(
        'cursor-pointer rounded-lg border bg-card px-4 py-3.5 text-left transition-colors hover:border-muted-foreground/50',
        active ? 'border-primary/50' : 'border-border'
      )}
    >
      <h3 className="text-sm font-semibold">{dataset.name}</h3>
      <div
        className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
        title={dataset.corpus}
      >
        {dataset.corpus}
      </div>
      <div className="mt-2.5 flex gap-5 text-[11px] text-muted-foreground">
        <StatButton
          label={`Show all ${dataset.example_count} eval cases in ${dataset.name}`}
          testId={`lookbook-total-count-${dataset.name}`}
          active={active && statusFilter === 'all'}
          onClick={() => onSelectStatus('all')}
        >
          <b className="block font-mono text-base font-semibold text-foreground">
            {dataset.example_count}
          </b>
          cases
        </StatButton>
        <StatButton
          label={`${successful} cases with successful source executions in ${dataset.name} — filter this suite`}
          testId={`lookbook-pass-count-${dataset.name}`}
          active={active && statusFilter === 'ok'}
          onClick={() => onSelectStatus('ok')}
        >
          <b className="block font-mono text-base font-semibold text-success">{successful}</b>
          source OK
        </StatButton>
        <StatButton
          label={`${errored} cases with errored source executions in ${dataset.name} — filter this suite`}
          testId={`lookbook-fail-count-${dataset.name}`}
          active={active && statusFilter === 'error'}
          onClick={() => onSelectStatus('error')}
        >
          <b
            className={cn(
              'block font-mono text-base font-semibold',
              errored > 0 ? 'text-destructive' : 'text-foreground'
            )}
          >
            {errored}
          </b>
          source errors
        </StatButton>
      </div>
    </div>
  );
}

function ExampleRow({
  example,
  lastRun,
  datasetName,
}: {
  example: DatasetExample;
  lastRun: Run | undefined;
  datasetName: string;
}) {
  const [open, setOpen] = useState(false);
  const sourceTrace = metadataString(example, 'source_trace');
  const sourceRootSpan = metadataString(example, 'source_root_span');
  const promotedBy = metadataString(example, 'promoted_by');
  const graders = metadataGraders(example);
  const assertions = example.metadata?.['assertions'];

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
        onClick={() => setOpen(previous => !previous)}
      >
        <td className="px-3 py-2">
          <span className="flex items-center gap-1.5">
            {open ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span>
              <span className="block">{truncate(example.input, 80)}</span>
              <span className="block font-mono text-[10px] text-muted-foreground">
                {example.example_id}
              </span>
            </span>
          </span>
        </td>
        <td className="px-3 py-2 text-[11px] text-muted-foreground">
          {sourceTrace ? (
            <span>
              trace{' '}
              <Link
                to={traceDetailPath(sourceTrace, sourceRootSpan)}
                className="font-mono text-link hover:underline"
                onClick={event => event.stopPropagation()}
              >
                {shortTraceId(sourceTrace)}
              </Link>
              {promotedBy ? ` · promoted by ${promotedBy}` : null}
            </span>
          ) : (
            '—'
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono text-[11px]">
          {typeof assertions === 'number' ? assertions : '—'}
        </td>
        <td className="px-3 py-2">
          {graders.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {graders.map(grader => (
                <span
                  key={grader}
                  className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground"
                >
                  {grader}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2">
          {lastRun ? (
            <Link
              to={traceDetailPath(lastRun.trace_id, lastRun.root_span_id)}
              onClick={event => event.stopPropagation()}
              className="inline-flex"
              title={`Latest run ${shortTraceId(lastRun.trace_id)} (${lastRun.agent_version ?? '—'})`}
            >
              <StatusPill status={lastRun.status} />
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-right">
          <RemoveLookButton dataset={datasetName} exampleId={example.example_id} />
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-border last:border-b-0">
          <td colSpan={6} className="bg-background/60 px-3 py-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Input
                </div>
                <pre className="rounded-md border border-border bg-card p-2.5 font-mono text-[11px] whitespace-pre-wrap text-secondary-foreground">
                  {example.input ?? '—'}
                </pre>
              </div>
              <EditExpectedField
                dataset={datasetName}
                exampleId={example.example_id}
                expected={example.expected}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function evalPassed(metric: EvalMetric): boolean {
  if (typeof metric.success === 'boolean') return metric.success;
  const total = Number(metric.total ?? 0);
  return total > 0 && Number(metric.passed ?? 0) === total;
}

function evalScore(metric: EvalMetric): string {
  const score = Number(metric.score);
  if (!Number.isFinite(score)) return '—';
  return score >= 0 && score <= 1 ? `${(score * 100).toFixed(1)}%` : score.toFixed(3);
}

function EvalCatalog({
  definitions,
  latestRun,
}: {
  definitions: EvalDefinition[];
  latestRun: EvalRun | undefined;
}) {
  const [selectedDefinition, setSelectedDefinition] = useState<EvalDefinition | null>(null);
  const rows = [...definitions].sort(
    (left, right) =>
      (left.group ?? '').localeCompare(right.group ?? '') || left.name.localeCompare(right.name)
  );
  const latestMetrics = latestRun?.metrics ?? {};
  const exercised = rows.filter(definition => latestMetrics[definition.name]).length;
  const attention = rows.filter(definition => {
    const metric = latestMetrics[definition.name];
    return metric ? !evalPassed(metric) : false;
  }).length;

  return (
    <>
      <Dialog
        open={selectedDefinition !== null}
        onOpenChange={open => !open && setSelectedDefinition(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          {selectedDefinition ? (
            <>
              <DialogHeader>
                <DialogTitle>{selectedDefinition.name}</DialogTitle>
                <DialogDescription>
                  Evaluator setup and the resources it is attached to.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  ['Group', selectedDefinition.group ?? '—'],
                  ['Type', String(selectedDefinition.type ?? 'custom')],
                  ['Runner', selectedDefinition.runner ?? '—'],
                  ['Source', selectedDefinition.source ?? '—'],
                  ['Dataset', String(selectedDefinition.dataset ?? latestRun?.dataset ?? '—')],
                  ['Threshold', String(selectedDefinition.threshold ?? '—')],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md border border-border bg-card px-3 py-2.5">
                    <div className="text-[9px] font-semibold tracking-wider text-muted-foreground uppercase">
                      {label}
                    </div>
                    <div className="mt-1 font-mono text-xs">{value}</div>
                  </div>
                ))}
              </div>
              {selectedDefinition.description ? (
                <div>
                  <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Description
                  </div>
                  <p className="rounded-md border border-border bg-card p-3 text-sm">
                    {String(selectedDefinition.description)}
                  </p>
                </div>
              ) : null}
              <div>
                <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Complete configuration
                </div>
                <pre className="max-h-80 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-[11px] whitespace-pre-wrap">
                  {JSON.stringify(selectedDefinition, null, 2)}
                </pre>
              </div>
              {latestRun ? (
                <Button size="sm" variant="secondary" asChild>
                  <Link to={PATHS.RUNS}>Open latest experiment</Link>
                </Button>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <div className="mb-5 overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Registered evals</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {rows.length} evaluator definitions
              {latestRun ? ` · ${exercised} exercised by the latest run` : ''}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {latestRun ? (
              <>
                <span className="font-mono text-success">{exercised - attention} passing</span>
                <span
                  className={cn(
                    'font-mono',
                    attention ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {attention} need attention
                </span>
                <Button size="sm" variant="secondary" asChild>
                  <Link to={PATHS.RUNS}>View latest run</Link>
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No evaluator definitions are registered with this Chorus server.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-xs">
              <thead>
                <tr className="text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  <th className="border-b border-border px-4 py-2.5">Eval</th>
                  <th className="border-b border-border px-3 py-2.5">Group</th>
                  <th className="border-b border-border px-3 py-2.5 text-right">Examples</th>
                  <th className="border-b border-border px-3 py-2.5 text-right">Score</th>
                  <th className="border-b border-border px-3 py-2.5">Latest result</th>
                  <th className="border-b border-border px-4 py-2.5">Runner</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(definition => {
                  const metric = latestMetrics[definition.name];
                  const passed = metric ? evalPassed(metric) : false;
                  return (
                    <tr
                      key={definition.name}
                      className="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
                      onClick={() => setSelectedDefinition(definition)}
                    >
                      <td className="px-4 py-2.5 font-medium">{definition.name}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {(definition.group ?? '—').split('_').join(' ')}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono">
                        {metric
                          ? `${Number(metric.passed ?? 0)}/${Number(metric.total ?? 0)}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono">
                        {metric ? evalScore(metric) : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        {metric ? (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1.5 font-medium',
                              passed ? 'text-success' : 'text-destructive'
                            )}
                          >
                            {passed ? (
                              <CircleCheck className="size-3.5" />
                            ) : (
                              <CircleX className="size-3.5" />
                            )}
                            {passed ? 'Passed' : 'Failed'}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Not in latest run</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
                        {definition.runner ?? definition.source ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export function EvalsPage() {
  const evaluationQuery = useEvaluationOverview();
  const evalRunsQuery = useEvalRuns();
  const datasetsQuery = useDatasets();
  const runsQuery = useAllRuns();
  const [selectedName, setSelectedName] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [addLookOpen, setAddLookOpen] = useState(false);
  const [runExperimentOpen, setRunExperimentOpen] = useState(false);

  const datasets = datasetsQuery.data ?? [];
  const definitions = evaluationQuery.data?.catalog ?? [];
  const latestEvalRun = evalRunsQuery.data?.[0];
  const selected = datasets.find(dataset => dataset.name === selectedName) ?? datasets[0] ?? null;

  const verdicts = useMemo(
    () => latestRunsByExample(runsQuery.data ?? [], datasets),
    [runsQuery.data, datasets]
  );

  // Clicking a dataset's source-execution status filters this suite's own
  // Look table in place (rather than navigating to Traces, which has no
  // trace_ids/example_id filter primitive — see the comment on DatasetCard's
  // predecessor in git history). Clicking the already-active filter again, or
  // the total "Looks" count, clears back to 'all'. Switching to a different
  // dataset (via its body or any of its stats) always resolves to a
  // deliberate filter value here, so a previous dataset's filter never leaks
  // onto a newly selected one.
  function selectStatus(datasetName: string, status: StatusFilter) {
    if (status !== 'all' && selectedName === datasetName && statusFilter === status) {
      setStatusFilter('all');
    } else {
      setSelectedName(datasetName);
      setStatusFilter(status);
    }
  }

  const displayedExamples = useMemo(() => {
    if (!selected) return [];
    if (statusFilter === 'all') return selected.examples;
    return selected.examples.filter(
      example => verdicts.get(caseKey(selected.name, example.example_id))?.status === statusFilter
    );
  }, [selected, statusFilter, verdicts]);

  return (
    <section>
      <PageHeader
        eyebrow="Eval Suites"
        title="Evals"
        description="Registered evaluator definitions, their latest results, and reusable case suites with lineage back to the traces that created them."
        actions={
          // Eval suites are built from Traces (select/filter runs, then "Add to
          // eval") — that's the primary entry point, so this deep-links
          // there instead of duplicating the flow on an empty page.
          <Button size="sm" asChild data-testid="lookbooks-new-button">
            <Link to={PATHS.TRACES}>
              <BookPlus className="size-3.5" />
              New eval suite
            </Link>
          </Button>
        }
      />

      {evaluationQuery.isLoading || evalRunsQuery.isLoading ? (
        <Skeleton className="mb-5 h-64 w-full" />
      ) : evaluationQuery.isError ? (
        <div className="mb-5 rounded-lg border border-border bg-card p-6 text-sm text-destructive">
          Failed to load registered evals: {(evaluationQuery.error as Error).message}
        </div>
      ) : (
        <EvalCatalog definitions={definitions} latestRun={latestEvalRun} />
      )}

      <div className="mb-3">
        <h2 className="text-sm font-semibold">Reusable case suites</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Golden or production-derived inputs and expected outputs used for repeatable evaluations.
        </p>
      </div>

      {datasetsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-28 w-full max-w-sm" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : datasetsQuery.isError ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-destructive">
          Failed to load datasets: {(datasetsQuery.error as Error).message}
        </div>
      ) : datasets.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No reusable case suites have been imported yet. The registered evals above can still run;
          promote a trace or export golden cases to enable case-level drilldown.
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {datasets.map(dataset => (
              <DatasetCard
                key={`${dataset.corpus}:${dataset.name}`}
                dataset={dataset}
                active={selected === dataset}
                statusFilter={statusFilter}
                verdicts={verdicts}
                onSelectStatus={status => selectStatus(dataset.name, status)}
              />
            ))}
          </div>

          {selected ? (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  {selected.name} — {selected.example_count}{' '}
                  {selected.example_count === 1 ? 'eval case' : 'eval cases'}
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="lookbooks-add-look-button"
                    onClick={() => setAddLookOpen(true)}
                  >
                    <Plus className="size-3.5" />
                    Add case…
                  </Button>
                  <RenameDatasetButton datasetName={selected.name} onRenamed={setSelectedName} />
                </div>
              </div>
              {displayedExamples.length === 0 && statusFilter !== 'all' ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  No cases with a {statusFilter === 'ok' ? 'successful' : 'failed'} source execution
                  in this eval suite.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-xs">
                    <thead>
                      <tr className="text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                        <th className="border-b border-border px-3 py-2 font-semibold">
                          Eval case
                        </th>
                        <th className="border-b border-border px-3 py-2 font-semibold">
                          Source lineage
                        </th>
                        <th className="border-b border-border px-3 py-2 text-right font-semibold">
                          Assertions
                        </th>
                        <th className="border-b border-border px-3 py-2 font-semibold">Graders</th>
                        <th className="border-b border-border px-3 py-2 font-semibold">
                          Source execution
                        </th>
                        <th className="border-b border-border px-3 py-2 text-right font-semibold">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedExamples.map(example => (
                        <ExampleRow
                          key={example.example_id}
                          example={example}
                          lastRun={verdicts.get(caseKey(selected.name, example.example_id))}
                          datasetName={selected.name}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {selected ? (
            <>
              <div className="mt-4 flex items-center justify-end">
                <Button size="sm" variant="secondary" onClick={() => setRunExperimentOpen(true)}>
                  <FlaskConical className="size-3.5" />
                  Run eval…
                </Button>
              </div>
              <RunExperimentDialog
                open={runExperimentOpen}
                onOpenChange={setRunExperimentOpen}
                lookbook={selected.name}
              />
              <AddLookDialog
                datasetName={selected.name}
                open={addLookOpen}
                onOpenChange={setAddLookOpen}
              />
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
