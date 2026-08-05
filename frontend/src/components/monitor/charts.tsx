import type { ReactNode } from 'react';

import { DrilldownStat } from '@/components/stats/DrilldownStat';
import { cn } from '@/lib/utils';

/**
 * Dependency-light chart primitives for the Monitor view (HTML/CSS marks, no
 * chart library). Colors come exclusively from the dr-ui --chart-* tokens;
 * all text wears text tokens. Every plot ships a per-mark hover tooltip.
 */

export function ChartCard({
  title,
  sub,
  legend,
  children,
}: {
  title: string;
  sub?: string;
  legend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="mb-3 flex items-start gap-2">
        <div>
          <h3 className="text-xs font-semibold">{title}</h3>
          {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
        </div>
        {legend ? <div className="ml-auto flex shrink-0 gap-3">{legend}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function LegendChip({ label, swatchClass }: { label: string; swatchClass: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <span className={cn('size-2 rounded-[2px]', swatchClass)} aria-hidden />
      {label}
    </span>
  );
}

function Tooltip({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-1 font-mono text-[10px] whitespace-nowrap text-popover-foreground shadow-md group-hover:block">
      {children}
    </span>
  );
}

export interface TimePoint {
  label: string;
  value: number;
}

/** Vertical bar chart over time buckets: one series, hover tooltip per bar,
 * two recessive gridlines with tick labels. */
export function TimeBarChart({
  points,
  barClass,
  formatValue,
  height = 132,
}: {
  points: TimePoint[];
  barClass: string;
  formatValue: (value: number) => string;
  height?: number;
}) {
  const max = Math.max(...points.map(point => point.value), 1);
  return (
    <div>
      <div className="relative" style={{ height }}>
        {/* gridlines */}
        {[1, 0.5].map(fraction => (
          <div
            key={fraction}
            className="absolute right-0 left-0 border-t border-border/60"
            style={{ top: `${(1 - fraction) * 100}%` }}
          >
            <span className="absolute -top-1.5 left-0 bg-card pr-1 font-mono text-[9px] text-muted-foreground">
              {formatValue(max * fraction)}
            </span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end gap-[2px] pt-2 pl-9">
          {points.map((point, index) => (
            <span key={index} className="group relative flex h-full flex-1 items-end">
              <span
                className={cn('w-full rounded-t-[3px]', barClass)}
                style={{
                  height: `${(point.value / max) * 100}%`,
                  minHeight: point.value > 0 ? 2 : 0,
                }}
              />
              {/* enlarged hit target */}
              <span className="absolute inset-y-0 -inset-x-[1px]" />
              <Tooltip>
                {point.label} · {formatValue(point.value)}
              </Tooltip>
            </span>
          ))}
        </div>
      </div>
      <div className="mt-1 flex justify-between pl-9 font-mono text-[9px] text-muted-foreground">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

export interface HBarRow {
  label: string;
  values: number[];
}

/** Horizontal grouped bars (e.g. p50/p90/p95 per agent). Series within a group
 * are lightness steps of one hue — magnitude, not identity — plus a legend. */
export function HBarGroupChart({
  rows,
  seriesClasses,
  seriesNames,
  formatValue,
}: {
  rows: HBarRow[];
  seriesClasses: string[];
  seriesNames: string[];
  formatValue: (value: number) => string;
}) {
  const max = Math.max(...rows.flatMap(row => row.values), 1);
  return (
    <div className="space-y-3">
      {rows.map(row => (
        <div key={row.label}>
          <div className="mb-1 truncate text-[11px] font-medium text-secondary-foreground">
            {row.label}
          </div>
          <div className="space-y-[2px]">
            {row.values.map((value, index) => (
              <div key={index} className="group relative flex items-center gap-2">
                <span
                  className={cn('h-2.5 rounded-r-[3px]', seriesClasses[index])}
                  style={{ width: `${Math.max((value / max) * 100, 0.5)}%` }}
                />
                <span className="font-mono text-[10px] text-muted-foreground">
                  {formatValue(value)}
                </span>
                <Tooltip>
                  {row.label} · {seriesNames[index]} · {formatValue(value)}
                </Tooltip>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Horizontal single-series bars with direct value labels. */
export function HBarChart({
  rows,
  barClass,
  formatValue,
}: {
  rows: { label: string; value: number }[];
  barClass: string;
  formatValue: (value: number) => string;
}) {
  const max = Math.max(...rows.map(row => row.value), 1e-9);
  return (
    <div className="space-y-2.5">
      {rows.map(row => (
        <div key={row.label} className="group relative">
          <div className="mb-0.5 flex items-baseline justify-between gap-2">
            <span className="truncate text-[11px] font-medium text-secondary-foreground">
              {row.label}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {formatValue(row.value)}
            </span>
          </div>
          <div className="h-2.5 rounded-[3px] bg-muted/40">
            <span
              className={cn('block h-full rounded-[3px]', barClass)}
              style={{ width: `${Math.max((row.value / max) * 100, 0.5)}%` }}
            />
          </div>
          <Tooltip>
            {row.label} · {formatValue(row.value)}
          </Tooltip>
        </div>
      ))}
    </div>
  );
}

/** Stat tile — a headline number is not a chart (dataviz: hero number).
 * Optionally clickable: pass `to` (a Traces URL) to drill down, mirroring how
 * Groups/GroupDetail wrap their Runs/Errors stats in `DrilldownStat`. */
export function StatTile({
  label,
  value,
  detail,
  detailClass,
  to,
  testId,
}: {
  label: string;
  value: string;
  detail?: string;
  detailClass?: string;
  to?: string;
  testId?: string;
}) {
  const content = (
    <>
      <span className="neon-rule absolute inset-x-0 top-0 h-px" aria-hidden />
      <div className="neon-eyebrow">{label}</div>
      <div className="mt-1.5 font-mono text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      {detail ? (
        <div className={cn('mt-0.5 text-[11px] text-muted-foreground', detailClass)}>{detail}</div>
      ) : null}
    </>
  );

  if (!to) {
    return (
      <div className="relative overflow-hidden rounded-lg border border-border bg-card px-4 py-3 dark:shadow-[0_0_24px_-18px_var(--neon-purple)]">
        {content}
      </div>
    );
  }

  return (
    <DrilldownStat
      to={to}
      label={`${value} ${label} — view in Traces`}
      testId={testId}
      className="relative block w-full overflow-hidden rounded-lg border border-border bg-card px-4 py-3 hover:border-primary/40 dark:shadow-[0_0_24px_-18px_var(--neon-purple)]"
    >
      {content}
    </DrilldownStat>
  );
}
