import { useExperiments, useGate } from '@/api/hooks';
import type { Experiment } from '@/api/types';
import { cn } from '@/lib/utils';

/**
 * A single experiment's evaluation-gate verdict (GET /api/experiments/{id}/gate),
 * fetched in its own row-scoped component so each row's query is
 * independent (rules-of-hooks-safe — no hook called in a loop) and one
 * slow/failing gate doesn't block the rest of the list from rendering.
 */
function GateBadge({ experimentId }: { experimentId: string }) {
  const gateQuery = useGate(experimentId);

  if (gateQuery.isLoading) {
    return <span className="text-[10px] text-muted-foreground">…</span>;
  }
  if (gateQuery.isError || !gateQuery.data) {
    return <span className="text-[10px] text-muted-foreground">—</span>;
  }

  const { status, passed } = gateQuery.data;
  const tone =
    status === 'blocked'
      ? 'bg-destructive/15 text-destructive'
      : status === 'warn'
        ? 'bg-warning/15 text-warning'
        : 'bg-success/15 text-success';

  return (
    <span
      data-testid={`runs-and-gates-gate-${experimentId}`}
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold',
        tone
      )}
    >
      {passed ? 'pass' : status}
    </span>
  );
}

function ExperimentRow({ experiment }: { experiment: Experiment }) {
  return (
    <tr
      data-testid={`runs-and-gates-row-${experiment.experiment_id}`}
      className="border-b border-border last:border-b-0"
    >
      <td className="px-3 py-2">
        <div className="font-medium">{experiment.name ?? experiment.experiment_id}</div>
        <div className="font-mono text-[10px] text-muted-foreground">
          {experiment.experiment_id}
        </div>
      </td>
      <td className="px-3 py-2 font-mono text-[11px] text-secondary-foreground">
        {experiment.baseline ?? '—'} → {experiment.candidate ?? '—'}
      </td>
      <td className="px-3 py-2 text-right font-mono text-[11px]">{experiment.run_count}</td>
      <td className="px-3 py-2 text-right">
        <GateBadge experimentId={experiment.experiment_id} />
      </td>
    </tr>
  );
}

/**
 * "Runs & Gates" panel on LookbooksPage's selected-dataset view: the past
 * experiments run against this Lookbook. The lookbook<->experiment link is
 * derived server-side (each experiment's trace_ids -> run.example_id ->
 * dataset membership, GET /api/experiments?lookbook=) rather than stored —
 * see the quality-view experiment projection in the Chorus API
 * for why (Experiment is a vendored pydantic model, not source we own).
 */
export function RunsAndGatesPanel({ datasetName }: { datasetName: string }) {
  const experimentsQuery = useExperiments({ lookbook: datasetName });
  const experiments = experimentsQuery.data ?? [];

  return (
    <div
      data-testid="runs-and-gates-panel"
      className="mt-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Runs & Gates
      </div>
      {experimentsQuery.isLoading ? (
        <div className="p-4 text-sm text-muted-foreground">Loading…</div>
      ) : experiments.length === 0 ? (
        <div data-testid="runs-and-gates-empty" className="p-4 text-sm text-muted-foreground">
          No eval runs are linked to this suite yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                <th className="border-b border-border px-3 py-2 font-semibold">Experiment</th>
                <th className="border-b border-border px-3 py-2 font-semibold">
                  Baseline → Candidate
                </th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">Runs</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">Gate</th>
              </tr>
            </thead>
            <tbody>
              {experiments.map(experiment => (
                <ExperimentRow key={experiment.experiment_id} experiment={experiment} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
