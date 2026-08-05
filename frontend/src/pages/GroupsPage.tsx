import { AlertTriangle, ArrowRight, Layers } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useGroups } from '@/api/hooks';
import type { Group } from '@/api/types';
import { DeleteGroupButton } from '@/components/groups/DeleteGroupButton';
import { ModeChip, ServiceChip } from '@/components/groups/ModeChip';
import { LANE_ORDER } from '@/components/groups/modes';
import { PageHeader } from '@/components/layout/PageHeader';
import { DrilldownStat } from '@/components/stats/DrilldownStat';
import { Skeleton } from '@/components/ui/skeleton';
import { groupDetailPath, tracesUrlForGroup } from '@/constants/path';
import { formatCost, formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

function Stat({
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

  if (!to) return <div>{content}</div>;

  return (
    <DrilldownStat to={to} label={`${value} ${label} — view in Traces`} testId={testId}>
      {content}
    </DrilldownStat>
  );
}

function GroupCard({ group }: { group: Group }) {
  const navigate = useNavigate();
  const orderedModes = LANE_ORDER.filter(mode => group.modes.includes(mode));
  return (
    // A div (not a <button>) so the Runs/Errors stat tiles below can be their
    // own real, keyboard-accessible <button>s — a <button> may not contain
    // interactive descendants.
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(groupDetailPath(group.group_id))}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          navigate(groupDetailPath(group.group_id));
        }
      }}
      className="group flex cursor-pointer flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/20"
    >
      <div className="flex items-start gap-2">
        <Layers className="mt-0.5 size-4 shrink-0 text-primary opacity-80" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{group.group_name}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {group.group_id}
          </div>
        </div>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        <DeleteGroupButton groupId={group.group_id} groupName={group.group_name} />
      </div>

      <div className="flex flex-wrap gap-1">
        {orderedModes.map(mode => (
          <ModeChip key={mode} mode={mode} />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Runs"
          value={String(group.run_count)}
          to={tracesUrlForGroup(group.group_id)}
          testId="group-stat-runs"
        />
        <Stat
          label="Errors"
          value={String(group.errors)}
          accent={group.errors > 0}
          to={tracesUrlForGroup(group.group_id, true)}
          testId="group-stat-errors"
        />
        <Stat label="Cost" value={formatCost(group.cost_usd)} />
      </div>

      <div className="flex flex-wrap gap-1">
        {group.services.map(service => (
          <ServiceChip key={service} name={service} />
        ))}
      </div>

      <div className="mt-auto flex items-center gap-1.5 border-t border-border pt-2 text-[11px] text-muted-foreground">
        <span>{formatTimestamp(group.first_seen)}</span>
        <ArrowRight className="size-3" aria-hidden />
        <span>{formatTimestamp(group.last_seen)}</span>
        {group.errors > 0 ? (
          <span className="ml-auto inline-flex items-center gap-1 text-destructive">
            <AlertTriangle className="size-3" />
            {group.errors}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The new top-level view: agent groups, the layer above Traces/Lookbooks/Runway/Monitor. */
export function GroupsPage() {
  const groupsQuery = useGroups();
  const groups = groupsQuery.data ?? [];

  return (
    <section>
      <PageHeader
        eyebrow="Quality Layer"
        title="Agent Groups"
        description="The organizing layer above your agent-quality tools. Each group is a body of work that flows through dev → integration → prod. Drop into Traces, Lookbooks, Runway, or Monitor once you're inside one."
      />

      {groupsQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-52 w-full rounded-xl" />
          ))}
        </div>
      ) : groupsQuery.isError ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-destructive">
          Failed to load groups: {(groupsQuery.error as Error).message}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No agent groups found in the loaded corpora. Tag runs with a group and Refresh.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map(group => (
            <GroupCard key={group.group_id} group={group} />
          ))}
        </div>
      )}
    </section>
  );
}
