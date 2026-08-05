import { useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Layers, User } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { useDatasets, useGroup } from '@/api/hooks';
import type { Dataset, Run, RunMode } from '@/api/types';
import { AddAgentControl } from '@/components/groups/AddAgentControl';
import { ServiceChip } from '@/components/groups/ModeChip';
import { LANE_ORDER, MODE_META } from '@/components/groups/modes';
import { ProductionDeepDive } from '@/components/groups/ProductionDeepDive';
import { PromoteMenu } from '@/components/groups/PromoteMenu';
import { RemoveGroupAgentButton } from '@/components/groups/RemoveGroupAgentButton';
import { PageHeader } from '@/components/layout/PageHeader';
import { DrilldownStat } from '@/components/stats/DrilldownStat';
import { StatusPill } from '@/components/traces/StatusPill';
import { Skeleton } from '@/components/ui/skeleton';
import { PATHS, tracesUrlForGroup } from '@/constants/path';
import { formatCost, formatDuration, shortTraceId, truncate } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Matches TraceDetailPage's local Panel convention (title bar + body). */
function Panel({
  title,
  children,
  clip = true,
}: {
  title: string;
  children: React.ReactNode;
  /**
   * Set false when a panel's content needs to render outside its rounded
   * bounds — e.g. MembersPanel's AddAgentControl renders an
   * absolutely-positioned dropdown that `overflow-hidden` would otherwise
   * clip invisible (see #40). Panels with square-cornered children (like a
   * table) that need clipping to the outer rounded corners should keep the
   * default.
   */
  clip?: boolean;
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-card', clip && 'overflow-hidden')}>
      <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

/** Distinct member agent_ids currently in the group, each removable, plus an
 * "add agent" control sourced from the stats agent list. */
function MembersPanel({ groupId, agentIds }: { groupId: string; agentIds: string[] }) {
  return (
    <Panel title={`Members · ${agentIds.length}`} clip={false}>
      <div className="flex flex-wrap items-center gap-2 p-3">
        {agentIds.map(agentId => (
          <div
            key={agentId}
            className="flex items-center gap-1 rounded-full border border-border bg-background/60 py-1 pr-1 pl-2.5"
            data-testid={`group-member-${agentId}`}
          >
            <User className="size-3 text-muted-foreground" aria-hidden />
            <span className="font-mono text-xs">{agentId}</span>
            <RemoveGroupAgentButton groupId={groupId} agentId={agentId} />
          </div>
        ))}
        {agentIds.length === 0 ? (
          <span className="text-xs text-muted-foreground">No members yet.</span>
        ) : null}
        <AddAgentControl groupId={groupId} memberIds={agentIds} />
      </div>
    </Panel>
  );
}

function HeaderStat({
  label,
  value,
  accent,
  to,
  testId,
}: {
  label: string;
  value: string;
  accent?: boolean;
  to?: string;
  testId?: string;
}) {
  const content = (
    <>
      <div
        className={cn(
          'font-mono text-sm font-semibold',
          accent ? 'text-destructive' : 'text-foreground'
        )}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </>
  );

  if (!to) {
    return <div className="rounded-md border border-border bg-card px-3 py-1.5">{content}</div>;
  }

  return (
    <DrilldownStat
      to={to}
      label={`${value} ${label} — view in Traces`}
      testId={testId}
      className="rounded-md border border-border bg-card px-3 py-1.5 hover:border-primary/40"
    >
      {content}
    </DrilldownStat>
  );
}

/** A run row rendered full-width in the single-lane list below the lane
 * tabs — every lane's runs are promotable (#44; dev traces flow into a
 * Lookbook the same as ci/prod). */
function RunRow({ run }: { run: Run }) {
  return (
    <div
      className="rounded-md border border-border bg-card px-3 py-2.5"
      data-testid={`lane-run-${run.trace_id}`}
    >
      <div className="flex items-center gap-2">
        <Link
          to={`/traces/${run.trace_id}`}
          className="font-mono text-xs text-link hover:underline"
        >
          {shortTraceId(run.trace_id)}
        </Link>
        <StatusPill status={run.status} />
        <span className="font-mono text-[11px] text-muted-foreground">{run.agent_id}</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {formatDuration(run.latency_ms)} · {formatCost(run.cost_usd)}
        </span>
        <PromoteMenu traceId={run.trace_id} />
      </div>
      <div
        className="mt-1.5 truncate text-xs text-secondary-foreground"
        title={run.input ?? undefined}
      >
        {truncate(run.input, 220)}
      </div>
    </div>
  );
}

/**
 * Lane selector: one pill per lifecycle lane (dev/ci/prod) showing its run
 * count, similar to the old per-lane `LaneHeader`, but now doubling as the
 * filter control for the single wide list below — clicking a pill switches
 * which lane's runs are shown (mirrors TracesPage's filter-then-single-table
 * pattern, see #44, rather than cramming all three lanes into narrow
 * side-by-side columns).
 */
function LaneTabs({
  counts,
  active,
  onChange,
}: {
  counts: Record<RunMode, number>;
  active: RunMode;
  onChange: (mode: RunMode) => void;
}) {
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2"
      role="tablist"
      aria-label="Lifecycle lane"
    >
      {LANE_ORDER.map(mode => {
        const meta = MODE_META[mode];
        const isActive = mode === active;
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`lane-tab-${mode}`}
            onClick={() => onChange(mode)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
              isActive
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-border bg-card text-muted-foreground hover:text-foreground'
            )}
          >
            <span className={cn('size-2 rounded-full', meta.dot)} />
            <span className="font-semibold">{meta.laneLabel}</span>
            <span className="rounded-full bg-muted/60 px-1.5 text-[10px] text-muted-foreground">
              {counts[mode]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The single wide list of runs for the currently-selected lane. */
function LaneList({ mode, runs }: { mode: RunMode; runs: Run[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-3">
      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No {MODE_META[mode].label} runs yet.
        </div>
      ) : (
        runs.map(run => <RunRow key={run.trace_id} run={run} />)
      )}
    </div>
  );
}

/**
 * "Related Lookbooks" (#44): which Lookbooks (datasets) have at least one
 * Look whose source trace's agent_id is a member of this group. Derived
 * entirely client-side from GET /api/datasets — no backend changes.
 */
function RelatedLookbooksPanel({ agentIds }: { agentIds: string[] }) {
  const datasetsQuery = useDatasets();

  const related = useMemo(() => {
    const members = new Set(agentIds);
    return (datasetsQuery.data ?? []).filter((dataset: Dataset) =>
      dataset.examples.some(example => {
        const agentId = example.metadata?.agent_id;
        return typeof agentId === 'string' && members.has(agentId);
      })
    );
  }, [datasetsQuery.data, agentIds]);

  return (
    <Panel title="Related Lookbooks">
      <div className="p-3" data-testid="related-lookbooks-panel">
        {datasetsQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : related.length === 0 ? (
          <div
            className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground"
            data-testid="related-lookbooks-empty"
          >
            No Lookbooks yet from this group's agents.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {related.map(dataset => (
              <Link
                key={dataset.name}
                to={PATHS.LOOKBOOKS}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-xs hover:border-primary/40"
                data-testid={`related-lookbook-${dataset.name}`}
              >
                <BookOpen className="size-3.5 shrink-0 text-primary opacity-80" aria-hidden />
                <span className="truncate font-medium text-foreground">{dataset.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                  {dataset.example_count} {dataset.example_count === 1 ? 'Look' : 'Looks'}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Group detail: lifecycle lanes (dev → ci → prod) with trace promotion. */
export function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const groupQuery = useGroup(groupId);
  const data = groupQuery.data;
  // Which lane's runs the single wide list below shows — defaults to
  // production, the lane a user checking on a group is most often after.
  const [selectedMode, setSelectedMode] = useState<RunMode>('prod');

  return (
    <section>
      <Link
        to={PATHS.GROUPS}
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        All agent groups
      </Link>

      {groupQuery.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-64 w-full" />
            ))}
          </div>
        </div>
      ) : groupQuery.isError ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-destructive">
          {(groupQuery.error as Error).message.startsWith('404')
            ? `No agent group "${groupId}" found.`
            : `Failed to load group: ${(groupQuery.error as Error).message}`}
        </div>
      ) : data ? (
        <>
          <PageHeader
            eyebrow="Agent Group"
            title={data.group.group_name}
            description="Runs flow through the lifecycle — dev, CI, then production. Promote any trace into your CI suite, or open it in Traces."
          />

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Layers className="size-3.5 text-primary opacity-80" />
              <span className="font-mono">{data.group.group_id}</span>
            </span>
            {data.group.services.map(service => (
              <ServiceChip key={service} name={service} />
            ))}
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <HeaderStat
              label="Runs"
              value={String(data.group.run_count)}
              to={tracesUrlForGroup(data.group.group_id)}
              testId="group-detail-stat-runs"
            />
            <HeaderStat
              label="Errors"
              value={String(data.group.errors)}
              accent={data.group.errors > 0}
              to={tracesUrlForGroup(data.group.group_id, true)}
              testId="group-detail-stat-errors"
            />
            <HeaderStat label="Cost" value={formatCost(data.group.cost_usd)} />
          </div>

          <div className="mb-4">
            <MembersPanel groupId={data.group.group_id} agentIds={data.group.agent_ids} />
          </div>

          {/* Lifecycle lane view (#44): tabs showing each lane's count (dev →
              ci → prod) filter a single wide list below, instead of cramming
              all three lanes into narrow side-by-side columns that truncated
              trace input badly. Mirrors TracesPage's filter-then-single-table
              pattern. */}
          <div className="mb-4">
            <LaneTabs
              counts={{
                dev: data.lanes.dev.length,
                ci: data.lanes.ci.length,
                prod: data.lanes.prod.length,
              }}
              active={selectedMode}
              onChange={setSelectedMode}
            />
            <LaneList mode={selectedMode} runs={data.lanes[selectedMode]} />
          </div>

          {/* PRODUCTION-DEEP-DIVE SLOT — the placeholder is now the real deep-dive
              (component graph + prod-trace drill-down + multi-service waterfall +
              correlated logs). Rendered full-width so the diagram stays readable. */}
          {groupId ? <ProductionDeepDive groupId={groupId} prodRuns={data.lanes.prod} /> : null}

          <div className="mt-4">
            <RelatedLookbooksPanel agentIds={data.group.agent_ids} />
          </div>
        </>
      ) : null}
    </section>
  );
}
