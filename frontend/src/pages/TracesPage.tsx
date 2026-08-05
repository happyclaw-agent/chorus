import { useEffect, useMemo, useState } from 'react';
import { BookPlus } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useExperiments, useGroups, useRuns } from '@/api/hooks';
import type { RunStatus } from '@/api/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { AddToLookbookDialog } from '@/components/traces/AddToLookbookDialog';
import { AgentGroupFilter, type TraceSource } from '@/components/traces/AgentGroupFilter';
import { StatusPill } from '@/components/traces/StatusPill';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { traceDetailPath } from '@/constants/path';
import { formatCost, formatDuration, formatTokens, shortTraceId, truncate } from '@/lib/format';

export function TracesPage() {
  // Other pages (Groups, GroupDetail, Lookbooks) drill down into Traces via
  // query params — read them once on mount to seed the initial filters. This
  // intentionally only applies on first render (lazy useState initializers);
  // once the user starts changing filters, the URL isn't kept in sync, so
  // there's no fight over who owns the params.
  const [searchParams] = useSearchParams();
  const [source, setSource] = useState<TraceSource>(() => {
    const groupId = searchParams.get('group');
    if (groupId) return { kind: 'group', id: groupId };
    const agentId = searchParams.get('agent_id');
    if (agentId) return { kind: 'agent', id: agentId };
    return { kind: 'all' };
  });
  const [status, setStatus] = useState(() => searchParams.get('status') ?? '');
  const [experimentId, setExperimentId] = useState('');
  const [search, setSearch] = useState(() => searchParams.get('search') ?? '');
  const navigate = useNavigate();

  // Multi-select for the "Add to Lookbook" bulk action (ticket #3). Keyed by
  // trace_id; "select all matching filter" is just "select every row
  // currently visible" since `rows` below is already the filtered set.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addToLookbookOpen, setAddToLookbookOpen] = useState(false);

  // A selection is only meaningful under the filters it was made with —
  // changing any filter can hide previously-selected traces from view, so
  // clear the selection rather than risk promoting traces the user can no
  // longer see (and can't tell are still selected).
  useEffect(() => {
    setSelected(new Set());
  }, [source, status, experimentId, search]);

  const runsQuery = useRuns({
    agent_id: source.kind === 'agent' ? source.id : undefined,
    group_id: source.kind === 'group' ? source.id : undefined,
    status: (status || undefined) as RunStatus | undefined,
    experiment_id: experimentId || undefined,
    limit: 500,
  });
  // Unfiltered fetch drives the filter options so selects don't collapse to
  // the currently-selected value.
  const allRunsQuery = useRuns({ limit: 500 });
  const experimentsQuery = useExperiments();
  const groupsQuery = useGroups();

  const agentOptions = useMemo(() => {
    const ids = new Set((allRunsQuery.data ?? []).map(run => run.agent_id));
    return [...ids].sort().map(id => ({ value: id, label: id }));
  }, [allRunsQuery.data]);

  const groupOptions = useMemo(() => {
    return (groupsQuery.data ?? [])
      .map(group => ({ value: group.group_id, label: group.group_name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [groupsQuery.data]);

  const experimentOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const experiment of experimentsQuery.data ?? []) ids.add(experiment.experiment_id);
    for (const run of allRunsQuery.data ?? []) {
      if (run.experiment_id) ids.add(run.experiment_id);
    }
    return [...ids].sort().map(id => ({ value: id, label: id }));
  }, [experimentsQuery.data, allRunsQuery.data]);

  const rows = useMemo(() => {
    const runs = runsQuery.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter(
      run =>
        run.trace_id.toLowerCase().includes(needle) ||
        (run.input ?? '').toLowerCase().includes(needle) ||
        (run.output ?? '').toLowerCase().includes(needle)
    );
  }, [runsQuery.data, search]);

  const allSelected = rows.length > 0 && rows.every(run => selected.has(run.trace_id));

  function toggleRow(traceId: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  }

  /** Header checkbox: selects/clears every currently-visible (filtered) row —
   * this is entry point 2, "create new from a filtered source". */
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map(run => run.trace_id)));
  }

  return (
    <section>
      <PageHeader
        eyebrow="Observability"
        title="Traces"
        description="Every agent run, captured via OTEL. Any trace — or any single span — can be promoted to a Look and versioned."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <AgentGroupFilter
          agents={agentOptions}
          groups={groupOptions}
          value={source}
          onChange={setSource}
        />
        <Select
          label="Status"
          options={[
            { value: 'ok', label: 'OK' },
            { value: 'error', label: 'Error' },
          ]}
          value={status}
          onChange={event => setStatus(event.target.value)}
        />
        <Select
          label="Experiment"
          options={experimentOptions}
          value={experimentId}
          onChange={event => setExperimentId(event.target.value)}
        />
        <Input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Filter by input, output, or trace id…"
          className="h-8 max-w-72 text-xs"
        />
        <span className="ml-auto text-xs text-muted-foreground">
          {runsQuery.isLoading ? 'Loading…' : `${rows.length} runs`}
        </span>
      </div>

      {selected.size > 0 ? (
        <div className="mb-2 flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <span data-testid="traces-selection-count" className="text-secondary-foreground">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button
              size="sm"
              data-testid="traces-add-to-lookbook-button"
              onClick={() => setAddToLookbookOpen(true)}
            >
              <BookPlus className="size-3.5" />
              Add to Lookbook
            </Button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {runsQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : runsQuery.isError ? (
          <div className="p-6 text-sm text-destructive">
            Failed to load runs: {(runsQuery.error as Error).message}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            No runs match the current filters.
          </div>
        ) : (
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all runs"
                    checked={allSelected}
                    onChange={toggleAll}
                    data-testid="traces-select-all"
                  />
                </TableHead>
                <TableHead>Trace</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="w-full">Input</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(run => (
                <TableRow
                  key={run.trace_id}
                  className="cursor-pointer"
                  onClick={() => navigate(traceDetailPath(run.trace_id))}
                >
                  <TableCell onClick={event => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select trace ${run.trace_id}`}
                      checked={selected.has(run.trace_id)}
                      onChange={() => toggleRow(run.trace_id)}
                      data-testid={`trace-select-${run.trace_id}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-secondary-foreground">
                    {shortTraceId(run.trace_id)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-secondary-foreground">
                    {run.agent_id}
                  </TableCell>
                  <TableCell className="max-w-0" title={run.input ?? undefined}>
                    {run.display_name ? (
                      <>
                        <div className="truncate font-medium text-foreground">
                          {run.display_name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {truncate(run.input, 120)}
                        </div>
                      </>
                    ) : (
                      <div className="truncate">{truncate(run.input, 120)}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatDuration(run.latency_ms)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {run.input_tokens == null && run.output_tokens == null
                      ? '—'
                      : formatTokens((run.input_tokens ?? 0) + (run.output_tokens ?? 0))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatCost(run.cost_usd)}
                  </TableCell>
                  <TableCell>
                    <StatusPill status={run.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <AddToLookbookDialog
        traceIds={Array.from(selected)}
        open={addToLookbookOpen}
        onOpenChange={setAddToLookbookOpen}
        onPromoted={() => setSelected(new Set())}
      />
    </section>
  );
}
