import { useMemo } from 'react';

import { useRuns, useStats } from '@/api/hooks';
import type { Run } from '@/api/types';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  ChartCard,
  HBarChart,
  HBarGroupChart,
  LegendChip,
  StatTile,
  TimeBarChart,
  type TimePoint,
} from '@/components/monitor/charts';
import { DrilldownStat } from '@/components/stats/DrilldownStat';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { tracesUrlForAgent, tracesUrlForErrors } from '@/constants/path';
import { formatCost, formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function formatCompact(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1_000) return `${(count / 1000).toFixed(1)}k`;
  return String(Math.round(count));
}

interface Buckets {
  unit: 'hour' | 'day';
  runs: TimePoint[];
  cost: TimePoint[];
}

/** Bucket run start times client-side (hourly when the corpus spans <= 48h,
 * daily otherwise), with empty buckets filled so gaps are visible. */
function bucketRuns(runs: Run[]): Buckets | null {
  const times = runs
    .map(run => ({ run, ms: run.started_at ? Date.parse(run.started_at) : NaN }))
    .filter(entry => Number.isFinite(entry.ms));
  if (times.length === 0) return null;

  const min = Math.min(...times.map(entry => entry.ms));
  const max = Math.max(...times.map(entry => entry.ms));
  const unit: Buckets['unit'] = max - min <= 48 * HOUR_MS ? 'hour' : 'day';
  const size = unit === 'hour' ? HOUR_MS : DAY_MS;

  const counts = new Map<number, { runs: number; cost: number }>();
  for (const { run, ms } of times) {
    const key = Math.floor(ms / size);
    const bucket = counts.get(key) ?? { runs: 0, cost: 0 };
    bucket.runs += 1;
    bucket.cost += run.cost_usd ?? 0;
    counts.set(key, bucket);
  }

  const first = Math.floor(min / size);
  const last = Math.floor(max / size);
  const label = (key: number) =>
    new Date(key * size).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(unit === 'hour' ? { hour: 'numeric' } : {}),
    });

  const runsSeries: TimePoint[] = [];
  const costSeries: TimePoint[] = [];
  for (let key = first; key <= last; key++) {
    const bucket = counts.get(key);
    runsSeries.push({ label: label(key), value: bucket?.runs ?? 0 });
    costSeries.push({ label: label(key), value: bucket?.cost ?? 0 });
  }
  return { unit, runs: runsSeries, cost: costSeries };
}

const PERCENTILE_NAMES = ['p50', 'p90', 'p95'];
// Same hue, stepped — latency percentiles are magnitude, not identity.
const PERCENTILE_CLASSES = ['bg-chart-1/40', 'bg-chart-1/70', 'bg-chart-1'];

export function MonitorPage() {
  const statsQuery = useStats();
  const runsQuery = useRuns({ limit: 500 });

  const buckets = useMemo(() => bucketRuns(runsQuery.data ?? []), [runsQuery.data]);

  const stats = statsQuery.data;
  const totalErrors = stats?.agents.reduce((sum, agent) => sum + agent.errors, 0) ?? 0;
  const errorRate = stats && stats.totals.runs > 0 ? totalErrors / stats.totals.runs : 0;
  const totalTokens = stats ? stats.totals.input_tokens + stats.totals.output_tokens : 0;

  if (statsQuery.isLoading || runsQuery.isLoading) {
    return (
      <section>
        <PageHeader
          eyebrow="Telemetry"
          title="Monitor"
          description="Production quality signals across every agent."
        />
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </section>
    );
  }

  if (statsQuery.isError || !stats) {
    return (
      <section>
        <PageHeader
          eyebrow="Telemetry"
          title="Monitor"
          description="Production quality signals across every agent."
        />
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-destructive">
          Failed to load stats
          {statsQuery.error ? `: ${(statsQuery.error as Error).message}` : '.'}
        </div>
      </section>
    );
  }

  return (
    <section>
      <PageHeader
        eyebrow="Telemetry"
        title="Monitor"
        description="Operational quality signals across every traced agent: volume, failures, spend, and latency percentiles."
      />

      <div className="mb-3 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <StatTile
          label="Total runs"
          value={String(stats.totals.runs)}
          detail={`across ${stats.agents.length} ${stats.agents.length === 1 ? 'agent' : 'agents'}`}
        />
        <StatTile
          label="Error rate"
          value={`${(errorRate * 100).toFixed(1)}%`}
          detail={`${totalErrors} failed ${totalErrors === 1 ? 'run' : 'runs'}`}
          detailClass={totalErrors > 0 ? 'text-destructive' : 'text-success'}
          to={tracesUrlForErrors()}
          testId="monitor-error-rate-stat"
        />
        <StatTile
          label="Total cost"
          value={formatCost(stats.totals.cost_usd)}
          detail="priced from gen_ai.usage tokens"
        />
        <StatTile
          label="Tokens"
          value={formatCompact(totalTokens)}
          detail={`${formatCompact(stats.totals.input_tokens)} in · ${formatCompact(stats.totals.output_tokens)} out`}
        />
      </div>

      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard
          title="Runs over time"
          sub={`per ${buckets?.unit ?? 'day'} · bucketed from run start times`}
        >
          {buckets ? (
            <TimeBarChart
              points={buckets.runs}
              barClass="bg-chart-1"
              formatValue={value => `${Math.round(value)} runs`}
            />
          ) : (
            <div className="py-6 text-xs text-muted-foreground">No timestamped runs.</div>
          )}
        </ChartCard>
        <ChartCard
          title="Cost over time"
          sub={`per ${buckets?.unit ?? 'day'} · summed run cost (unpriced models excluded)`}
        >
          {buckets ? (
            <TimeBarChart
              points={buckets.cost}
              barClass="bg-chart-4"
              formatValue={value => formatCost(value)}
            />
          ) : (
            <div className="py-6 text-xs text-muted-foreground">No timestamped runs.</div>
          )}
        </ChartCard>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard
          title="Latency percentiles"
          sub="per agent · ms"
          legend={
            <>
              {PERCENTILE_NAMES.map((name, index) => (
                <LegendChip key={name} label={name} swatchClass={PERCENTILE_CLASSES[index]} />
              ))}
            </>
          }
        >
          <HBarGroupChart
            rows={stats.agents.map(agent => ({
              label: agent.agent_id,
              values: [agent.p50_ms, agent.p90_ms, agent.p95_ms],
            }))}
            seriesClasses={PERCENTILE_CLASSES}
            seriesNames={PERCENTILE_NAMES}
            formatValue={value => formatDuration(value)}
          />
        </ChartCard>
        <ChartCard title="Cost per agent" sub="total run cost attributed to each agent">
          <HBarChart
            rows={stats.agents.map(agent => ({ label: agent.agent_id, value: agent.cost_usd }))}
            barClass="bg-chart-4"
            formatValue={value => formatCost(value)}
          />
        </ChartCard>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          Per-agent breakdown
        </div>
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Agent</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Errors</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Tokens in</TableHead>
              <TableHead className="text-right">Tokens out</TableHead>
              <TableHead className="text-right">p50</TableHead>
              <TableHead className="text-right">p90</TableHead>
              <TableHead className="text-right">p95</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.agents.map(agent => (
              <TableRow key={agent.agent_id}>
                <TableCell className="font-medium">{agent.agent_id}</TableCell>
                <TableCell className="text-right font-mono">{agent.runs}</TableCell>
                <TableCell className="p-0 text-right">
                  <DrilldownStat
                    to={tracesUrlForAgent(agent.agent_id, true)}
                    label={`${agent.errors} errors for ${agent.agent_id} — view in Traces`}
                    testId={`monitor-agent-errors-${agent.agent_id}`}
                    className={cn(
                      'block w-full px-3 py-2.5 text-right font-mono',
                      agent.errors > 0 ? 'font-semibold text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {agent.errors}
                  </DrilldownStat>
                </TableCell>
                <TableCell className="text-right font-mono">{formatCost(agent.cost_usd)}</TableCell>
                <TableCell className="text-right font-mono">
                  {formatCompact(agent.input_tokens)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatCompact(agent.output_tokens)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatDuration(agent.p50_ms)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatDuration(agent.p90_ms)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatDuration(agent.p95_ms)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
