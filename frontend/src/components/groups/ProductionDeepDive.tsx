import { useMemo, useState } from 'react';
import { Network, Plus } from 'lucide-react';

import { useGroupGraph, useTrace, useTraceLogs } from '@/api/hooks';
import type { Run } from '@/api/types';
import { ComponentGraph } from '@/components/groups/ComponentGraph';
import { PromoteToLookDialog } from '@/components/traces/PromoteToLookDialog';
import { LogPanel } from '@/components/traces/LogPanel';
import { SpanWaterfall } from '@/components/traces/SpanWaterfall';
import { StatusPill } from '@/components/traces/StatusPill';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { traceDetailPath } from '@/constants/path';
import { formatCost, formatDuration, shortTraceId, truncate } from '@/lib/format';
import { assignServiceColors } from '@/lib/serviceColors';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';

/**
 * SEAM for the eval-authoring flow. Attaching a production trace to a component
 * is how "create an eval by adding traces to each component of the agent group"
 * is realized. The default implementation opens a stub dialog; a future builder
 * supplies `onAttachTraceToComponent` to persist the trace as a Look for that
 * component. Signature is intentionally the requested
 * `attachTraceToComponent(component, traceId)` shape.
 */
export type AttachTraceToComponent = (component: string, traceId: string | null) => void;

function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {title}
        </span>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** A production trace flowing through the selected component. */
function ComponentTraceRow({
  run,
  selected,
  onSelect,
  onAttach,
}: {
  run: Run;
  selected: boolean;
  onSelect: () => void;
  onAttach: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0',
        selected ? 'bg-muted/40' : 'hover:bg-muted/20'
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="font-mono text-[11px] text-link">{shortTraceId(run.trace_id)}</span>
        <StatusPill status={run.status} />
        <span
          className="min-w-0 flex-1 truncate text-xs text-secondary-foreground"
          title={run.input ?? undefined}
        >
          {truncate(run.input, 64)}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatDuration(run.latency_ms)} · {formatCost(run.cost_usd)}
        </span>
      </button>
      <Button
        size="sm"
        variant="secondary"
        onClick={onAttach}
        title="Attach this trace as a Look for the selected component"
      >
        <Plus className="size-3.5" />
        Add to eval
      </Button>
    </div>
  );
}

function SelectedTraceDetail({ traceId }: { traceId: string }) {
  const traceQuery = useTrace(traceId);
  const logsQuery = useTraceLogs(traceId);

  const serviceColors = useMemo(() => {
    const services: Array<string | null | undefined> = [];
    const walk = (span: NonNullable<typeof traceQuery.data>['spans']) => {
      if (!span) return;
      services.push(span.service);
      span.children.forEach(walk);
    };
    walk(traceQuery.data?.spans ?? null);
    for (const log of logsQuery.data ?? []) services.push(log.service);
    return assignServiceColors(services);
  }, [traceQuery.data, logsQuery.data]);

  if (traceQuery.isLoading) return <Skeleton className="h-40 w-full" />;
  if (traceQuery.isError || !traceQuery.data) {
    return (
      <div className="text-xs text-destructive">Failed to load trace {shortTraceId(traceId)}.</div>
    );
  }

  const { spans } = traceQuery.data;
  const traceStartNs = spans?.start_ns;

  return (
    <div className="space-y-3">
      <Panel
        title={`Multi-service waterfall · ${shortTraceId(traceId)}`}
        action={
          <Link to={traceDetailPath(traceId)} className="text-[11px] text-link hover:underline">
            Open full trace →
          </Link>
        }
      >
        <div className="p-3">
          {spans ? (
            <SpanWaterfall root={spans} />
          ) : (
            <div className="px-1 py-3 text-xs text-muted-foreground">No spans captured.</div>
          )}
        </div>
      </Panel>

      <Panel title={`Correlated logs · ${(logsQuery.data ?? []).length}`}>
        {logsQuery.isLoading ? (
          <div className="p-3">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <LogPanel
            logs={logsQuery.data ?? []}
            serviceColors={serviceColors}
            traceStartNs={traceStartNs}
          />
        )}
      </Panel>
    </div>
  );
}

/**
 * Production deep-dive for a group's prod lane: the component call graph, a
 * drill-down that filters prod traces by the selected component, and — on a
 * selected trace — the multi-service waterfall with time-correlated logs. An
 * "Add to eval" affordance on each component and trace realizes the
 * eval-authoring seam.
 */
export function ProductionDeepDive({
  groupId,
  prodRuns,
  onAttachTraceToComponent,
}: {
  groupId: string;
  prodRuns: Run[];
  onAttachTraceToComponent?: AttachTraceToComponent;
}) {
  const graphQuery = useGroupGraph(groupId);
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [attachTarget, setAttachTarget] = useState<{
    component: string;
    traceId: string | null;
  } | null>(null);
  // A single prod trace being promoted to a Look for the selected component.
  const [promoteTarget, setPromoteTarget] = useState<{
    component: string;
    traceId: string;
  } | null>(null);

  // Eval-authoring seam. A supplied handler fully owns it. Otherwise: attaching
  // a single trace promotes it to a Look (real); the bulk "all traces" case
  // stays a stub (it needs a batch promote the backend doesn't expose yet).
  const attachTraceToComponent: AttachTraceToComponent =
    onAttachTraceToComponent ??
    ((component, traceId) =>
      traceId ? setPromoteTarget({ component, traceId }) : setAttachTarget({ component, traceId }));

  const selectComponent = (id: string) => {
    setSelectedComponent(previous => (previous === id ? null : id));
    setSelectedTraceId(null);
  };

  const componentRuns = useMemo(
    () =>
      selectedComponent ? prodRuns.filter(run => run.services.includes(selectedComponent)) : [],
    [prodRuns, selectedComponent]
  );

  return (
    <section className="mt-4 rounded-lg border border-border bg-background/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Network className="size-4 text-primary opacity-80" />
        <h2 className="text-sm font-semibold text-foreground">Production deep-dive</h2>
        <span className="text-xs text-muted-foreground">
          Click a component to drill into the prod traces flowing through it.
        </span>
      </div>

      <Panel title="Component call graph">
        <div className="p-2">
          {graphQuery.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : graphQuery.isError || !graphQuery.data ? (
            <div className="px-2 py-6 text-center text-xs text-destructive">
              Failed to load component graph.
            </div>
          ) : (
            <ComponentGraph
              graph={graphQuery.data}
              selected={selectedComponent}
              onSelect={selectComponent}
            />
          )}
        </div>
      </Panel>

      {selectedComponent ? (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(300px,380px)_1fr]">
          <Panel
            title={`Prod traces · ${selectedComponent}`}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => attachTraceToComponent(selectedComponent, null)}
                title={`Attach traces as Looks for ${selectedComponent}`}
              >
                <Plus className="size-3.5" />
                Add to eval
              </Button>
            }
          >
            {componentRuns.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground">
                No prod traces flow through {selectedComponent}.
              </div>
            ) : (
              <div>
                {componentRuns.map(run => (
                  <ComponentTraceRow
                    key={run.trace_id}
                    run={run}
                    selected={selectedTraceId === run.trace_id}
                    onSelect={() => setSelectedTraceId(run.trace_id)}
                    onAttach={() => attachTraceToComponent(selectedComponent, run.trace_id)}
                  />
                ))}
              </div>
            )}
          </Panel>

          <div>
            {selectedTraceId ? (
              <SelectedTraceDetail traceId={selectedTraceId} />
            ) : (
              <div className="flex h-full min-h-40 items-center justify-center rounded-lg border border-dashed border-border bg-card/40 px-4 py-8 text-center text-xs text-muted-foreground">
                Select a trace to see its multi-service waterfall and correlated logs.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border bg-card/40 px-4 py-6 text-center text-xs text-muted-foreground">
          Select a component above to drill into its production traces.
        </div>
      )}

      {/* Single-trace attach → real promote to a Look for the component. */}
      {promoteTarget ? (
        <PromoteToLookDialog
          traceId={promoteTarget.traceId}
          defaultDataset={promoteTarget.component}
          open={promoteTarget !== null}
          onOpenChange={value => !value && setPromoteTarget(null)}
        />
      ) : null}

      {/* Bulk "all traces through this component" stub (no batch promote yet). */}
      <Dialog open={attachTarget !== null} onOpenChange={value => !value && setAttachTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add to eval</DialogTitle>
            <DialogDescription>
              Coming at the hackathon: attach{' '}
              {attachTarget?.traceId ? 'this trace' : 'these prod traces'} as a Look for{' '}
              <span className="font-mono">{attachTarget?.component}</span>. Adding a trace to each
              component of the agent group is how a component-level eval is authored.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            component: {attachTarget?.component}
            <br />
            trace: {attachTarget?.traceId ?? 'all prod traces through this component'}
          </div>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setAttachTarget(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
