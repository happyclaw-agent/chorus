import { useEffect, useMemo, useState } from 'react';
import {
  CircleCheck,
  CircleX,
  FlaskConical,
  Grid3x3,
  Minus,
  PlaneTakeoff,
  Plus,
  TriangleAlert,
} from 'lucide-react';

import {
  useDatasets,
  useExperimentGrid,
  useExperimentMatrix,
  useExperiments,
  useGate,
} from '@/api/hooks';
import type { GateResult, GridRow, MatrixParams, Verdict } from '@/api/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { ComparisonDrawer } from '@/components/runway/ComparisonDrawer';
import { MatrixGrid } from '@/components/runway/MatrixGrid';
import { RunExperimentDialog } from '@/components/runway/RunExperimentDialog';
import { ComingSoonButton } from '@/components/stub/ComingSoonButton';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { axisLabel, formatCost, formatDuration, truncate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatScore, parseScore } from '@/lib/verdicts';

const VERDICT_CELL: Record<Verdict, string> = {
  pass: 'bg-success/10 text-success',
  fail: 'bg-destructive/15 text-destructive ring-1 ring-destructive/40',
  warn: 'bg-warning/10 text-warning',
  na: 'bg-muted/50 text-muted-foreground',
};

/** Backend gate policy defaults (GET /api/experiments/{id}/gate). */
const DEFAULT_MAX_REGRESSIONS = 0;
const DEFAULT_MAX_DROP = 0.1;
const MAX_DROP_OPTIONS = ['0', '0.05', '0.1', '0.2'];

function VsCard({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string;
  detail?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs',
        accent && 'border-primary/40'
      )}
    >
      <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      <b className="font-semibold">{value}</b>
      {detail ? (
        <span className="font-mono text-[10px] text-muted-foreground">{detail}</span>
      ) : null}
    </div>
  );
}

/** CI-style pass/blocked pill for the configured evaluation gate. */
function GatePill({ passed }: { passed: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] font-semibold',
        passed ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
      )}
      data-testid="gate-pill"
    >
      {passed ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />}
      evaluation gate · {passed ? 'passed' : 'blocked'}
      <span className="opacity-70">exit {passed ? 0 : 1}</span>
    </span>
  );
}

function GateBanner({ gate }: { gate: GateResult }) {
  const { status, summary, baseline, candidate } = gate;
  const tone =
    status === 'blocked'
      ? {
          border:
            'border-destructive/40 bg-destructive/10 dark:shadow-[0_0_28px_-14px_var(--destructive)]',
          icon: 'text-destructive',
        }
      : status === 'warn'
        ? {
            border: 'border-warning/40 bg-warning/10 dark:shadow-[0_0_28px_-14px_var(--warning)]',
            icon: 'text-warning',
          }
        : {
            border: 'border-success/40 bg-success/10 dark:shadow-[0_0_28px_-14px_var(--success)]',
            icon: 'text-success',
          };

  const headline =
    status === 'blocked'
      ? `Runway blocked — ${summary.regressions} ${
          summary.regressions === 1 ? 'regression' : 'regressions'
        } vs ${baseline ?? 'baseline'}`
      : status === 'warn'
        ? `Cleared with ${summary.warnings} ${summary.warnings === 1 ? 'warning' : 'warnings'}`
        : `Cleared for takeoff — candidate ${candidate ?? 'candidate'} ready to promote`;

  const Icon = status === 'blocked' ? CircleX : status === 'warn' ? TriangleAlert : CircleCheck;

  return (
    <div
      className={cn('mb-4 flex items-center gap-3.5 rounded-lg border px-4 py-3', tone.border)}
      data-testid="gate-banner"
    >
      <Icon className={cn('size-7 shrink-0', tone.icon)} aria-hidden />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-sm font-semibold">{headline}</h2>
          <GatePill passed={gate.passed} />
        </div>
        <p className="mt-0.5 text-xs text-secondary-foreground">
          {summary.examples - summary.regressions} of {summary.examples} Looks passed ·{' '}
          {summary.regressions} {summary.regressions === 1 ? 'regression' : 'regressions'} ·{' '}
          {summary.warnings} {summary.warnings === 1 ? 'warning' : 'warnings'} · click a cell for
          the step-level diff
        </p>
      </div>
    </div>
  );
}

/** Compact tolerance controls that re-verdict the gate live. */
function ToleranceControls({
  maxRegressions,
  onMaxRegressions,
  maxDrop,
  onMaxDrop,
  policy,
}: {
  maxRegressions: number;
  onMaxRegressions: (value: number) => void;
  maxDrop: number;
  onMaxDrop: (value: number) => void;
  policy: GateResult['policy'];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="tolerance-controls">
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-secondary-foreground">
        <span className="text-muted-foreground">Max regressions:</span>
        <button
          type="button"
          aria-label="Decrease max regressions"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
          disabled={maxRegressions <= 0}
          onClick={() => onMaxRegressions(Math.max(0, maxRegressions - 1))}
        >
          <Minus className="size-3.5" />
        </button>
        <input
          type="number"
          min={0}
          aria-label="Max regressions"
          value={maxRegressions}
          onChange={event => onMaxRegressions(Math.max(0, Number(event.target.value) || 0))}
          className="w-9 bg-transparent text-center font-medium text-foreground outline-none"
        />
        <button
          type="button"
          aria-label="Increase max regressions"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          onClick={() => onMaxRegressions(maxRegressions + 1)}
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      <Select
        label="Max drop"
        includeAll={false}
        options={MAX_DROP_OPTIONS.map(value => ({ value, label: value }))}
        value={String(maxDrop)}
        onChange={event => onMaxDrop(Number(event.target.value))}
      />

      <span className="font-mono text-[11px] text-muted-foreground" data-testid="active-policy">
        policy: ≤{policy.max_regressions} regressions · drop ≤{policy.numeric_max_drop} · fail &lt;
        {policy.numeric_fail_below}
      </span>
    </div>
  );
}

export function RunwayPage() {
  const experimentsQuery = useExperiments();
  const datasetsQuery = useDatasets();
  const [selectedId, setSelectedId] = useState<string>('');
  const [openExampleId, setOpenExampleId] = useState<string | null>(null);
  const [matrixParams, setMatrixParams] = useState<MatrixParams>({});
  const [maxRegressions, setMaxRegressions] = useState(DEFAULT_MAX_REGRESSIONS);
  const [maxDrop, setMaxDrop] = useState(DEFAULT_MAX_DROP);
  const [runExperimentOpen, setRunExperimentOpen] = useState(false);

  const experiments = experimentsQuery.data ?? [];
  // Default to the first experiment that has both arms defined (an A/B gate).
  const experimentId =
    selectedId ||
    (experiments.find(e => e.baseline && e.candidate) ?? experiments[0])?.experiment_id ||
    '';
  const selectedExperiment = experiments.find(e => e.experiment_id === experimentId);
  // A matrix experiment has neither arm set (baseline/candidate both null).
  const isMatrix =
    Boolean(selectedExperiment) && !selectedExperiment!.baseline && !selectedExperiment!.candidate;

  // Reset axis/score overrides and tolerance whenever the experiment changes.
  useEffect(() => {
    setMatrixParams({});
    setMaxRegressions(DEFAULT_MAX_REGRESSIONS);
    setMaxDrop(DEFAULT_MAX_DROP);
    setOpenExampleId(null);
  }, [experimentId]);

  const abId = isMatrix ? undefined : experimentId || undefined;
  const gridQuery = useExperimentGrid(abId);
  const gateQuery = useGate(abId, { max_regressions: maxRegressions, numeric_max_drop: maxDrop });
  const matrixQuery = useExperimentMatrix(
    isMatrix ? experimentId || undefined : undefined,
    matrixParams
  );
  const grid = gridQuery.data;
  const gate = gateQuery.data;
  const matrix = matrixQuery.data;

  const gridByExample = useMemo(() => {
    const map = new Map<string, GridRow>();
    for (const row of grid?.rows ?? []) map.set(row.example_id, row);
    return map;
  }, [grid]);

  const exampleInputs = useMemo(() => {
    const map = new Map<string, string>();
    for (const dataset of datasetsQuery.data ?? []) {
      for (const example of dataset.examples) {
        if (example.input) map.set(example.example_id, example.input);
      }
    }
    return map;
  }, [datasetsQuery.data]);

  const openGridRow = openExampleId ? (gridByExample.get(openExampleId) ?? null) : null;
  const openGateRow = openExampleId
    ? (gate?.rows.find(r => r.example_id === openExampleId) ?? null)
    : null;

  return (
    <section>
      <PageHeader
        eyebrow="Model Evaluation"
        title="Runway"
        description="Candidate versions walk the runway against the baseline before promotion. Regressions are attributed to the failing run — not just an aggregate score."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRunExperimentOpen(true)}>
              <FlaskConical className="size-3.5" />
              Run experiment...
            </Button>
            {isMatrix ? null : (
              <ComingSoonButton
                title={`Promote ${gate?.candidate ?? 'candidate'}`}
                description="one-click promotion once the runway is clear — blocked while regressions remain."
              >
                <PlaneTakeoff className="size-3.5" />
                Promote {gate?.candidate ?? 'candidate'}
              </ComingSoonButton>
            )}
          </div>
        }
      />

      <RunExperimentDialog
        open={runExperimentOpen}
        onOpenChange={setRunExperimentOpen}
        baseline={gate?.baseline}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          label="Experiment"
          allLabel={experiments.length === 0 ? 'None found' : 'Auto (latest)'}
          options={experiments.map(e => ({
            value: e.experiment_id,
            label: e.name ?? e.experiment_id,
          }))}
          value={selectedId}
          onChange={event => setSelectedId(event.target.value)}
        />
        {selectedExperiment ? (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold',
              isMatrix
                ? 'border-primary/40 text-primary'
                : 'border-border text-secondary-foreground'
            )}
            data-testid="runway-mode"
          >
            {isMatrix ? <Grid3x3 className="size-3.5" /> : <PlaneTakeoff className="size-3.5" />}
            {isMatrix ? 'Model matrix' : 'A/B gate'}
          </span>
        ) : null}
        {!isMatrix && gate ? (
          <div className="flex flex-wrap items-center gap-2">
            <VsCard label="Baseline" value={gate.baseline ?? '—'} />
            <span className="text-[11px] text-muted-foreground">vs</span>
            <VsCard label="Candidate" value={gate.candidate ?? '—'} accent />
            <VsCard
              label="Runs"
              value={String(gate.experiment.run_count)}
              detail={gate.experiment_id}
            />
          </div>
        ) : null}
        {isMatrix && matrix ? (
          <div className="flex flex-wrap items-center gap-2">
            <VsCard label="Score" value={matrix.score_name ?? '—'} />
            <VsCard
              label="Grid"
              value={`${matrix.rows.length} × ${matrix.cols.length}`}
              detail={`${axisLabel(matrix.row_key)} × ${axisLabel(matrix.col_key)}`}
            />
            <VsCard label="Runs" value={String(matrix.experiment.run_count)} />
          </div>
        ) : null}
      </div>

      {(isMatrix ? matrixQuery.isLoading : gateQuery.isLoading) || experimentsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : experiments.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No experiments found in the loaded corpora. Run an experiment with baseline and candidate
          versions, then Refresh.
        </div>
      ) : isMatrix ? (
        matrixQuery.isError ? (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-destructive">
            Failed to load experiment matrix: {(matrixQuery.error as Error).message}
          </div>
        ) : matrix ? (
          <>
            <div className="mb-3 flex items-start gap-3.5 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 dark:shadow-[0_0_30px_-16px_var(--neon-purple)]">
              <Grid3x3
                className="size-6 shrink-0 text-primary dark:drop-shadow-[0_0_6px_var(--neon-purple)]"
                aria-hidden
              />
              <div>
                <h2 className="text-sm font-semibold">
                  Model matrix — {matrix.rows.length} × {matrix.cols.length} over{' '}
                  {axisLabel(matrix.row_key)} × {axisLabel(matrix.col_key)}
                </h2>
                <p className="mt-0.5 text-xs text-secondary-foreground">
                  Not an A/B gate: every cell is a model/config combination scored on{' '}
                  <b>{matrix.score_name ?? 'its metric'}</b>. The cost/quality tradeoff is the point
                  — click a cell to open its run(s).
                </p>
              </div>
            </div>
            <MatrixGrid matrix={matrix} params={matrixParams} onParamsChange={setMatrixParams} />
          </>
        ) : null
      ) : gateQuery.isError ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-destructive">
          Failed to load experiment gate: {(gateQuery.error as Error).message}
        </div>
      ) : gate ? (
        <>
          <GateBanner gate={gate} />

          <div className="mb-3">
            <ToleranceControls
              maxRegressions={maxRegressions}
              onMaxRegressions={setMaxRegressions}
              maxDrop={maxDrop}
              onMaxDrop={setMaxDrop}
              policy={gate.policy}
            />
          </div>

          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[720px] border-collapse text-xs">
              <thead>
                <tr>
                  <th className="min-w-56 border-b border-border px-3 py-2.5 text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Look
                  </th>
                  <th className="border-b border-border px-3 py-2.5 text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Run
                  </th>
                  {gate.summary.evaluators.map(evaluator => (
                    <th
                      key={evaluator}
                      className="border-b border-border px-3 py-2.5 text-center text-[10px] font-semibold tracking-wider text-muted-foreground uppercase"
                    >
                      {evaluator.replace(/_/g, ' ')}
                    </th>
                  ))}
                  <th className="border-b border-border px-3 py-2.5 text-right text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Latency Δ
                  </th>
                  <th className="border-b border-border px-3 py-2.5 text-right text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Cost Δ
                  </th>
                </tr>
              </thead>
              <tbody>
                {gate.rows.map(row => {
                  const gridRow = gridByExample.get(row.example_id);
                  const statusVerdict: Verdict = row.status_fail ? 'fail' : 'pass';
                  return (
                    <tr
                      key={row.example_id}
                      className={cn(
                        'cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30',
                        row.regressed && 'bg-destructive/5'
                      )}
                      onClick={() => setOpenExampleId(row.example_id)}
                      data-testid={row.regressed ? 'gate-row-regressed' : 'gate-row'}
                    >
                      <td className="max-w-72 px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          {row.regressed ? (
                            <CircleX
                              className="size-3.5 shrink-0 text-destructive"
                              aria-label="regression"
                            />
                          ) : null}
                          <span className="truncate" title={exampleInputs.get(row.example_id)}>
                            {truncate(exampleInputs.get(row.example_id) ?? row.example_id, 64)}
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {row.example_id}
                        </div>
                      </td>
                      <VerdictTd
                        verdict={statusVerdict}
                        baseline={gridRow?.baseline ? gridRow.baseline.status : null}
                        candidate={gridRow?.candidate ? gridRow.candidate.status : null}
                        reason={row.status_fail ? 'candidate run errored' : undefined}
                      />
                      {gate.summary.evaluators.map(evaluator => {
                        const gv = row.verdicts[evaluator];
                        return (
                          <VerdictTd
                            key={evaluator}
                            verdict={gv?.verdict ?? 'na'}
                            baseline={formatScore(parseScore(gv?.baseline))}
                            candidate={formatScore(parseScore(gv?.candidate))}
                            reason={gv?.reason || undefined}
                          />
                        );
                      })}
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-secondary-foreground">
                        {formatDuration(gridRow?.baseline?.latency_ms)} →{' '}
                        {formatDuration(gridRow?.candidate?.latency_ms)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-secondary-foreground">
                        {formatCost(gridRow?.baseline?.cost_usd)} →{' '}
                        {formatCost(gridRow?.candidate?.cost_usd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              {gate.summary.examples} Looks · cells read baseline → candidate ·{' '}
              <span className="text-success">pass</span> ·{' '}
              <span className="text-destructive">fail</span> ·{' '}
              <span className="text-warning">warn (score drop)</span> · – no data · hover a cell for
              the gate reason
            </div>
          </div>
        </>
      ) : null}

      {openExampleId && openGridRow && gate ? (
        <ComparisonDrawer
          row={openGridRow}
          evaluators={gate.summary.evaluators}
          verdicts={openGateRow?.verdicts}
          failingEvaluators={
            openGateRow
              ? gate.summary.evaluators.filter(e => openGateRow.verdicts[e]?.verdict === 'fail')
              : []
          }
          blocked={Boolean(openGateRow?.regressed)}
          baselineVersion={gate.baseline}
          candidateVersion={gate.candidate}
          exampleInput={exampleInputs.get(openExampleId) ?? null}
          onClose={() => setOpenExampleId(null)}
        />
      ) : null}
    </section>
  );
}

function VerdictTd({
  verdict,
  baseline,
  candidate,
  reason,
}: {
  verdict: Verdict;
  baseline: string | null;
  candidate: string | null;
  reason?: string;
}) {
  const cell = (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold',
        VERDICT_CELL[verdict]
      )}
    >
      <span className="font-normal opacity-70">{baseline ?? '–'}</span>
      <span aria-hidden>→</span>
      <span>{candidate ?? '–'}</span>
    </span>
  );
  return (
    <td className="px-3 py-2 text-center">
      {reason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>{cell}</span>
          </TooltipTrigger>
          <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
      ) : (
        cell
      )}
    </td>
  );
}
