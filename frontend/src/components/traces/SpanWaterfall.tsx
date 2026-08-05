import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';

import type { Span } from '@/api/types';
import { Input } from '@/components/ui/input';
import { formatDuration, formatNsClock } from '@/lib/format';
import { assignServiceColors, type ServiceColor } from '@/lib/serviceColors';
import { cn } from '@/lib/utils';

const NS_PER_MS = 1_000_000;

interface FlatSpan {
  span: Span;
  depth: number;
  /** Tree glyph prefix, e.g. "│  ├─ " */
  prefix: string;
  offsetPct: number;
  widthPct: number;
}

function collectServices(root: Span): string[] {
  const out: string[] = [];
  const walk = (span: Span) => {
    if (span.service) out.push(span.service);
    span.children.forEach(walk);
  };
  walk(root);
  return out;
}

function isLlmSpan(span: Span): boolean {
  const name = span.name.toLowerCase();
  return (
    name.includes('llm') ||
    name.startsWith('gen_ai') ||
    name.startsWith('chat ') ||
    Object.keys(span.attributes).some(key => key.startsWith('gen_ai.request'))
  );
}

function isErrorSpan(span: Span): boolean {
  return span.status.toLowerCase() === 'error';
}

function spanEndNs(span: Span): number {
  const own = span.start_ns + span.duration_ms * NS_PER_MS;
  return Math.max(own, ...span.children.map(spanEndNs));
}

function flatten(root: Span): FlatSpan[] {
  const traceStart = root.start_ns;
  const total = Math.max(spanEndNs(root) - traceStart, 1);
  const rows: FlatSpan[] = [];

  const walk = (span: Span, depth: number, ancestorsLast: boolean[]) => {
    let prefix = '';
    if (depth > 0) {
      for (const wasLast of ancestorsLast.slice(0, -1)) prefix += wasLast ? '   ' : '│  ';
      prefix += ancestorsLast[ancestorsLast.length - 1] ? '└─ ' : '├─ ';
    }
    rows.push({
      span,
      depth,
      prefix,
      offsetPct: ((span.start_ns - traceStart) / total) * 100,
      widthPct: Math.max(((span.duration_ms * NS_PER_MS) / total) * 100, 0.5),
    });
    span.children.forEach((child, index) =>
      walk(child, depth + 1, [...ancestorsLast, index === span.children.length - 1])
    );
  };

  walk(root, 0, []);
  return rows;
}

function prettyValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function attributeGroup(key: string): number {
  if (key.startsWith('gen_ai.')) return 0;
  if (key.startsWith('abbrivio.')) return 1;
  return 2;
}

/** True if any attribute key or value on the span contains `query` (already lowercased). */
function attributesMatch(span: Span, query: string): boolean {
  return Object.entries(span.attributes).some(([key, value]) => {
    if (key.toLowerCase().includes(query)) return true;
    const text = typeof value === 'string' ? value : prettyValue(value);
    return text.toLowerCase().includes(query);
  });
}

/** Case-insensitive substring match against span name, service, or attributes (keys + values). */
function spanMatches(span: Span, query: string): boolean {
  if (!query) return true;
  if (span.name.toLowerCase().includes(query)) return true;
  if (span.service?.toLowerCase().includes(query)) return true;
  return attributesMatch(span, query);
}

/** Wrap the first case-insensitive occurrence of `query` in `text` with a <mark>. */
function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const index = text.toLowerCase().indexOf(query);
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[2px] bg-primary/40 text-foreground">
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  );
}

function SpanAttributes({ span, query }: { span: Span; query: string }) {
  const entries = Object.entries(span.attributes).sort(
    ([a], [b]) => attributeGroup(a) - attributeGroup(b) || a.localeCompare(b)
  );

  return (
    <div className="mx-2 mb-2 rounded-md border border-border bg-background p-3">
      {span.error_message ? (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 font-mono text-xs whitespace-pre-wrap text-destructive">
          {span.error_message}
        </div>
      ) : null}
      {entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">No attributes on this span.</div>
      ) : (
        <dl className="grid grid-cols-[minmax(160px,max-content)_1fr] gap-x-4 gap-y-1.5">
          {entries.map(([key, value]) => {
            const text = prettyValue(value);
            const entryMatches =
              query.length > 0 &&
              (key.toLowerCase().includes(query) || text.toLowerCase().includes(query));
            return (
              <div key={key} className="contents">
                <dt
                  className={cn(
                    'font-mono text-[11px] break-all text-muted-foreground',
                    attributeGroup(key) < 2 && 'text-secondary-foreground',
                    entryMatches && 'text-foreground'
                  )}
                >
                  {highlightMatch(key, query)}
                </dt>
                <dd
                  className={cn(
                    'max-h-64 min-w-0 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-foreground',
                    entryMatches && 'rounded bg-primary/10'
                  )}
                >
                  {highlightMatch(text, query)}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

function ServiceLegend({ colors }: { colors: Map<string, ServiceColor> }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2">
      <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        Services
      </span>
      {[...colors.entries()].map(([service, color]) => (
        <span
          key={service}
          className="inline-flex items-center gap-1.5 font-mono text-[10px] text-secondary-foreground"
        >
          <span className={cn('size-2 rounded-[2px]', color.dot)} aria-hidden />
          {service}
        </span>
      ))}
    </div>
  );
}

function WaterfallSearch({
  value,
  onChange,
  matchCount,
  total,
  isSearching,
}: {
  value: string;
  onChange: (next: string) => void;
  matchCount: number;
  total: number;
  isSearching: boolean;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-72">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="Search spans by name, service, attributes…"
          className="h-8 pl-7 text-xs"
          data-testid="waterfall-search"
          aria-label="Search spans"
        />
      </div>
      {isSearching ? (
        <span
          className="font-mono text-[11px] text-muted-foreground"
          data-testid="waterfall-search-count"
        >
          {matchCount} / {total} spans match
        </span>
      ) : null}
    </div>
  );
}

/**
 * Indented span tree with time-proportional bars. Clicking a row expands the
 * span's attribute panel (gen_ai.* / abbrivio.* attributes listed first).
 * Each row also shows the span's absolute wall-clock start time
 * (HH:MM:SS.mmm, derived from `start_ns`).
 *
 * When a trace spans more than one service, bars are colored by service (stable
 * --chart-N assignment), a service legend is shown, and each row carries a
 * colored left accent + service label. Single-service traces keep the original
 * bar coloring (llm spans → chart-4, others → chart-1).
 *
 * A search box filters the tree in place: matching spans (by name, service, or
 * attribute keys/values, case-insensitive) stay at full opacity and get a
 * subtle highlight, while non-matching spans dim rather than disappear — the
 * indentation and tree glyphs stay legible even in a deep (80+ span) trace.
 */
export function SpanWaterfall({ root }: { root: Span }) {
  const rows = useMemo(() => flatten(root), [root]);
  const serviceColors = useMemo(() => assignServiceColors(collectServices(root)), [root]);
  const multiService = serviceColors.size > 1;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const query = search.trim().toLowerCase();
  const isSearching = query.length > 0;
  const matchCount = useMemo(
    () => (isSearching ? rows.filter(row => spanMatches(row.span, query)).length : rows.length),
    [rows, query, isSearching]
  );

  const toggle = (spanId: string) =>
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });

  return (
    <div>
      <WaterfallSearch
        value={search}
        onChange={setSearch}
        matchCount={matchCount}
        total={rows.length}
        isSearching={isSearching}
      />
      {multiService ? <ServiceLegend colors={serviceColors} /> : null}
      {isSearching && matchCount === 0 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground">
          No spans match &ldquo;{search.trim()}&rdquo;.
        </div>
      ) : null}
      {rows.map(({ span, prefix, offsetPct, widthPct }) => {
        const isOpen = expanded.has(span.span_id);
        const error = isErrorSpan(span);
        const color = span.service ? serviceColors.get(span.service) : undefined;
        const barClass = error
          ? 'bg-destructive'
          : multiService && color
            ? color.bar
            : isLlmSpan(span)
              ? 'bg-chart-4'
              : 'bg-chart-1';
        const matched = !isSearching || spanMatches(span, query);
        const dimmed = isSearching && !matched;
        const nameOrServiceMatched =
          isSearching &&
          (span.name.toLowerCase().includes(query) ||
            Boolean(span.service?.toLowerCase().includes(query)));
        const attrOnlyMatch = isSearching && matched && !nameOrServiceMatched;
        return (
          <div
            key={span.span_id}
            data-testid="span-row"
            data-matched={matched}
            data-dimmed={dimmed}
            className={cn(
              'transition-opacity duration-150',
              dimmed && 'opacity-30 hover:opacity-70',
              isSearching && matched && 'rounded bg-primary/5'
            )}
          >
            <button
              type="button"
              onClick={() => toggle(span.span_id)}
              className={cn(
                'grid w-full grid-cols-[minmax(220px,300px)_84px_1fr_90px] items-center gap-3 rounded py-1 pr-2 text-left hover:bg-muted/40',
                multiService && color ? cn('border-l-2 pl-2', color.leftBorder) : 'px-2'
              )}
            >
              <span className="flex min-w-0 items-center gap-1 font-mono text-[11px]">
                {isOpen ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="whitespace-pre text-muted-foreground">{prefix}</span>
                <span
                  className={cn('truncate', error ? 'text-destructive' : 'text-foreground')}
                  title={span.name}
                >
                  {highlightMatch(span.name, query)}
                </span>
                {multiService && span.service ? (
                  <span
                    className={cn(
                      'ml-1.5 shrink-0 text-[10px]',
                      color ? color.text : 'text-muted-foreground'
                    )}
                    title={span.service}
                  >
                    {highlightMatch(span.service, query)}
                  </span>
                ) : null}
                {attrOnlyMatch ? (
                  <span
                    className="ml-1 shrink-0 rounded-[3px] bg-primary/20 px-1 text-[9px] text-secondary-foreground italic"
                    title="Match found in this span's attributes"
                  >
                    attr match
                  </span>
                ) : null}
              </span>
              <span
                className="truncate text-left font-mono text-[10px] text-muted-foreground"
                data-testid="span-timestamp"
                title={`Absolute start time: ${formatNsClock(span.start_ns)}`}
              >
                {formatNsClock(span.start_ns)}
              </span>
              <span className="relative h-3.5 rounded-sm bg-muted/50">
                <span
                  className={cn('absolute top-0.5 bottom-0.5 rounded-[2px]', barClass)}
                  style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                />
              </span>
              <span
                className={cn(
                  'text-right font-mono text-[11px]',
                  error ? 'text-destructive' : 'text-secondary-foreground'
                )}
              >
                {formatDuration(span.duration_ms)}
              </span>
            </button>
            {isOpen ? <SpanAttributes span={span} query={query} /> : null}
          </div>
        );
      })}
    </div>
  );
}
