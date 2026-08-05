import {
  ClipboardCheck,
  ChevronRight,
  Database,
  Gauge,
  Layers,
  History,
  RefreshCw,
  Waypoints,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';

import { useGroups, useRefresh, useStats, useStatus } from '@/api/hooks';
import { ThemeToggle } from '@/components/block/theme-toggle';
import { DrilldownStat } from '@/components/stats/DrilldownStat';
import { Button } from '@/components/ui/button';
import { formatCost } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PATHS, tracesUrlForErrors } from '@/constants/path';

// The four per-agent tools you drop into once inside a group.
const TOOL_ITEMS = [
  { to: PATHS.TRACES, label: 'Traces', icon: Waypoints },
  { to: PATHS.EVALS, label: 'Evals', icon: ClipboardCheck },
  { to: PATHS.RUNS, label: 'Runs', icon: History },
  { to: PATHS.MONITOR, label: 'Monitor', icon: Gauge },
] as const;

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] text-secondary-foreground transition-colors hover:bg-muted/40 hover:text-foreground',
    isActive &&
      'bg-sidebar-accent font-medium text-foreground shadow-[inset_2px_0_0_0_var(--neon-purple)] dark:shadow-[inset_2px_0_0_0_var(--neon-purple),0_0_18px_-8px_var(--neon-purple)]'
  );

function HeaderStats() {
  const { data: stats } = useStats();
  // Groups are optional in Chorus: a corpus can have zero, one, or many. We
  // read the real count so the bar never implies group structure that isn't
  // there — it says "0 groups" plainly rather than leaning on the nav's
  // "Agent Groups" label to imply every agent belongs to one.
  const { data: groups } = useGroups();
  if (!stats) return null;

  const errors = stats.agents.reduce((sum, agent) => sum + agent.errors, 0);
  const agentCount = stats.agents.length;
  const groupCount = groups?.length ?? 0;
  return (
    <div
      className="hidden items-center gap-2 text-xs text-muted-foreground md:flex"
      data-testid="header-stats"
    >
      <span data-testid="header-agents">
        <b className="font-semibold text-secondary-foreground">{agentCount}</b>{' '}
        {agentCount === 1 ? 'agent' : 'agents'}
      </span>
      {groups ? (
        <>
          <span aria-hidden>·</span>
          <span data-testid="header-groups">
            <b className="font-semibold text-secondary-foreground">{groupCount}</b>{' '}
            {groupCount === 1 ? 'group' : 'groups'}
          </span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span data-testid="header-runs">
        <b className="font-semibold text-secondary-foreground">{stats.totals.runs}</b> runs
      </span>
      <span aria-hidden>·</span>
      <span>
        <b className="font-semibold text-secondary-foreground">
          {formatCost(stats.totals.cost_usd)}
        </b>{' '}
        cost
      </span>
      {errors > 0 && (
        <>
          <span aria-hidden>·</span>
          <DrilldownStat
            to={tracesUrlForErrors()}
            label={`${errors} errors — view in Traces`}
            testId="header-errors-stat"
            className="font-medium text-destructive hover:text-destructive/80"
          >
            {errors} errors
          </DrilldownStat>
        </>
      )}
    </div>
  );
}

/**
 * Small "live" pill: a gentle pulse showing the app is polling the backend, with
 * the current run count. Driven by the polled `useStatus` query.
 */
function LiveIndicator() {
  const { data: status, isFetching } = useStatus();
  if (!status) return null;
  return (
    <div
      className="hidden items-center gap-2 rounded-full border border-border bg-card/60 px-2.5 py-1 text-[11px] text-muted-foreground backdrop-blur-sm sm:flex dark:border-success/25 dark:shadow-[0_0_18px_-10px_var(--success)]"
      title="Auto-refreshing — new traces appear without a manual refresh"
      data-testid="live-indicator"
    >
      <span className="relative flex size-2">
        {isFetching ? (
          <span className="absolute inline-flex size-2 animate-ping rounded-full bg-success opacity-75" />
        ) : null}
        <span className="relative inline-flex size-2 rounded-full bg-success dark:shadow-[0_0_8px_1px_var(--success)]" />
      </span>
      <span className="font-mono tracking-[0.14em] text-success uppercase">Live</span>
      <span aria-hidden className="text-border">
        ·
      </span>
      <span>
        <b className="font-semibold text-secondary-foreground">{status.run_count}</b> runs
      </span>
    </div>
  );
}

function RefreshButton() {
  const refresh = useRefresh();
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => refresh.mutate()}
      disabled={refresh.isPending}
      title="Re-ingest trace corpora and refetch"
    >
      <RefreshCw className={cn('size-3.5', refresh.isPending && 'animate-spin')} />
      Refresh
    </Button>
  );
}

function NavRail() {
  const { data: stats } = useStats();

  return (
    <aside className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar/80 p-2 backdrop-blur-sm">
      <div className="neon-eyebrow px-2.5 pt-1 pb-2">Agent Quality</div>
      <NavLink to={PATHS.GROUPS} className={navLinkClass}>
        <Layers className="size-3.5 opacity-75 transition-colors group-aria-[current=page]:text-neon-purple group-aria-[current=page]:opacity-100" />
        Agent Groups
      </NavLink>

      <div className="neon-eyebrow mt-3 px-2.5 pb-1">Tools</div>
      {TOOL_ITEMS.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} className={navLinkClass}>
          <Icon className="size-3.5 opacity-75 transition-colors group-aria-[current=page]:text-neon-purple group-aria-[current=page]:opacity-100" />
          {label}
          {label === 'Traces' && stats ? (
            <span className="ml-auto rounded-full bg-muted/60 px-1.5 text-[10px] text-muted-foreground">
              {stats.totals.runs}
            </span>
          ) : null}
        </NavLink>
      ))}
      <div className="neon-eyebrow mt-3 px-2.5 pb-1">Data</div>
      <NavLink to={PATHS.SOURCES} className={navLinkClass}>
        <Database className="size-3.5 opacity-75 transition-colors group-aria-[current=page]:text-neon-purple group-aria-[current=page]:opacity-100" />
        Sources
        {stats ? (
          <span className="ml-auto rounded-full bg-muted/60 px-1.5 text-[10px] text-muted-foreground">
            {stats.totals.runs}
          </span>
        ) : null}
      </NavLink>

      <div className="mt-auto border-t border-border px-2.5 py-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
        <b className="neon-wordmark font-semibold">CHORUS</b> · powered by Abbrivio
        <br />
        traces via OpenTelemetry
      </div>
    </aside>
  );
}

/**
 * App shell: top bar (wordmark, live stats, refresh, theme toggle) + left nav
 * rail for the four views. Every routed page renders inside <Outlet />.
 */
export function AppShell() {
  return (
    <div className="app-backdrop flex h-full flex-col text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-sidebar/80 px-4 backdrop-blur-md dark:shadow-[0_1px_0_0_oklch(0.62_0.2_285/0.25)]">
        <NavLink to={PATHS.TRACES} className="group flex items-center gap-2.5">
          <span
            className="flex size-6 items-center justify-center rounded-md text-white shadow-[0_0_16px_-4px_var(--neon-purple)] transition-transform group-hover:scale-105"
            style={{ backgroundImage: 'var(--neon-gradient)' }}
            aria-hidden
          >
            <ChevronRight className="size-4 -translate-x-px" strokeWidth={3} />
          </span>
          <span className="neon-wordmark text-sm font-bold">CHORUS</span>
          <span className="neon-eyebrow hidden sm:inline">Agent Quality</span>
        </NavLink>
        <div className="flex-1" />
        <HeaderStats />
        <LiveIndicator />
        <RefreshButton />
        <ThemeToggle />
      </header>
      <div className="flex min-h-0 flex-1">
        <NavRail />
        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto max-w-[1200px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
