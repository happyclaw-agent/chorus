import { useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { BookPlus, ChevronDown, ChevronRight, FlaskConical, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useDatasets, useRuns } from '@/api/hooks';
import type { Dataset, DatasetExample, Run } from '@/api/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { AddLookDialog } from '@/components/lookbooks/AddLookDialog';
import { EditExpectedField } from '@/components/lookbooks/EditExpectedField';
import { RemoveLookButton } from '@/components/lookbooks/RemoveLookButton';
import { RenameDatasetButton } from '@/components/lookbooks/RenameDatasetButton';
import { RunsAndGatesPanel } from '@/components/lookbooks/RunsAndGatesPanel';
import { RunExperimentDialog } from '@/components/runway/RunExperimentDialog';
import { StatusPill } from '@/components/traces/StatusPill';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PATHS, traceDetailPath } from '@/constants/path';
import { shortTraceId, truncate } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Latest run per example_id — drives the "Last verdict" column. */
function latestRunsByExample(runs: Run[]): Map<string, Run> {
  const map = new Map<string, Run>();
  for (const run of runs) {
    if (!run.example_id) continue;
    const existing = map.get(run.example_id);
    if (!existing || (run.started_at ?? '') > (existing.started_at ?? '')) {
      map.set(run.example_id, run);
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
 * A summary stat (Look count, passing count, failing count) that filters the
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
  const withRuns = dataset.examples.filter(e => verdicts.has(e.example_id));
  const failing = withRuns.filter(e => verdicts.get(e.example_id)!.status === 'error').length;
  const passing = withRuns.length - failing;

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
          label={`Show all ${dataset.example_count} Looks in ${dataset.name}`}
          testId={`lookbook-total-count-${dataset.name}`}
          active={active && statusFilter === 'all'}
          onClick={() => onSelectStatus('all')}
        >
          <b className="block font-mono text-base font-semibold text-foreground">
            {dataset.example_count}
          </b>
          Looks
        </StatButton>
        <StatButton
          label={`${passing} passing Looks in ${dataset.name} — filter this Lookbook`}
          testId={`lookbook-pass-count-${dataset.name}`}
          active={active && statusFilter === 'ok'}
          onClick={() => onSelectStatus('ok')}
        >
          <b className="block font-mono text-base font-semibold text-success">{passing}</b>
          passing
        </StatButton>
        <StatButton
          label={`${failing} failing Looks in ${dataset.name} — filter this Lookbook`}
          testId={`lookbook-fail-count-${dataset.name}`}
          active={active && statusFilter === 'error'}
          onClick={() => onSelectStatus('error')}
        >
          <b
            className={cn(
              'block font-mono text-base font-semibold',
              failing > 0 ? 'text-destructive' : 'text-foreground'
            )}
          >
            {failing}
          </b>
          failing
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
                to={traceDetailPath(sourceTrace)}
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
              to={traceDetailPath(lastRun.trace_id)}
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

export function LookbooksPage() {
  const datasetsQuery = useDatasets();
  const runsQuery = useRuns({ limit: 500 });
  const [selectedName, setSelectedName] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [addLookOpen, setAddLookOpen] = useState(false);
  const [runExperimentOpen, setRunExperimentOpen] = useState(false);

  const datasets = datasetsQuery.data ?? [];
  const selected = datasets.find(dataset => dataset.name === selectedName) ?? datasets[0] ?? null;

  const verdicts = useMemo(() => latestRunsByExample(runsQuery.data ?? []), [runsQuery.data]);

  // Clicking a dataset's "passing"/"failing" stat filters this Lookbook's own
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
      example => verdicts.get(example.example_id)?.status === statusFilter
    );
  }, [selected, statusFilter, verdicts]);

  return (
    <section>
      <PageHeader
        eyebrow="Eval Suites"
        title="Lookbooks"
        description="Versioned eval suites, stored as datasets in the corpus. Every Look traces its lineage back to the run that created it."
        actions={
          // Lookbooks are built from Traces (select/filter runs, then "Add to
          // Lookbook") — that's the primary entry point, so this deep-links
          // there instead of duplicating the flow on an empty page.
          <Button size="sm" asChild data-testid="lookbooks-new-button">
            <Link to={PATHS.TRACES}>
              <BookPlus className="size-3.5" />
              New Lookbook
            </Link>
          </Button>
        }
      />

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
          No Lookbooks yet. Promote a trace to create the first reusable evaluation case.
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
                  {selected.example_count === 1 ? 'Look' : 'Looks'}
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="lookbooks-add-look-button"
                    onClick={() => setAddLookOpen(true)}
                  >
                    <Plus className="size-3.5" />
                    Add Look…
                  </Button>
                  <RenameDatasetButton datasetName={selected.name} onRenamed={setSelectedName} />
                </div>
              </div>
              {displayedExamples.length === 0 && statusFilter !== 'all' ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  No {statusFilter === 'ok' ? 'passing' : 'failing'} Looks in this Lookbook.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-xs">
                    <thead>
                      <tr className="text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                        <th className="border-b border-border px-3 py-2 font-semibold">Look</th>
                        <th className="border-b border-border px-3 py-2 font-semibold">
                          Source lineage
                        </th>
                        <th className="border-b border-border px-3 py-2 text-right font-semibold">
                          Assertions
                        </th>
                        <th className="border-b border-border px-3 py-2 font-semibold">Graders</th>
                        <th className="border-b border-border px-3 py-2 font-semibold">
                          Last verdict
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
                          lastRun={verdicts.get(example.example_id)}
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
                  Run experiment...
                </Button>
              </div>
              <RunsAndGatesPanel datasetName={selected.name} />
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
