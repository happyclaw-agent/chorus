import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ComponentGraphShape as ComponentGraphData, ComponentNode } from '@/api/types';
import type { ServiceColor } from '@/lib/serviceColors';
import { assignServiceColors } from '@/lib/serviceColors';
import { cn } from '@/lib/utils';

interface EdgeSegment {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  midX: number;
  midY: number;
  calls: number;
}

/**
 * Longest-path level for each node: sources (no incoming edges) sit at level 0,
 * every target is pushed one level past its deepest source. Gives a clean
 * left-to-right layout for DAG-shaped call graphs.
 */
function computeLevels(graph: ComponentGraphData): Map<string, number> {
  const level = new Map<string, number>();
  for (const node of graph.nodes) level.set(node.id, 0);
  // Relax edges up to N times (safe upper bound for a DAG).
  for (let iteration = 0; iteration < graph.nodes.length; iteration += 1) {
    let changed = false;
    for (const edge of graph.edges) {
      const next = (level.get(edge.source) ?? 0) + 1;
      if (next > (level.get(edge.target) ?? 0)) {
        level.set(edge.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return level;
}

function ComponentNodeCard({
  node,
  color,
  selected,
  onSelect,
  registerRef,
}: {
  node: ComponentNode;
  color: ServiceColor;
  selected: boolean;
  onSelect: (id: string) => void;
  registerRef: (id: string, element: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      type="button"
      ref={element => registerRef(node.id, element)}
      onClick={() => onSelect(node.id)}
      aria-pressed={selected}
      className={cn(
        'relative z-10 w-44 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors',
        color.softBg,
        selected ? cn('border-2', color.chipBorder, 'ring-2 ring-ring/40') : 'border-border',
        'hover:border-foreground/30'
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('size-2 shrink-0 rounded-full', color.dot)} aria-hidden />
        <span
          className="truncate font-mono text-[11px] font-semibold text-foreground"
          title={node.id}
        >
          {node.id}
        </span>
        {node.error_count > 0 ? (
          <span className="ml-auto shrink-0 rounded-full bg-destructive/15 px-1.5 py-0.5 text-[9px] font-semibold text-destructive">
            {node.error_count} err
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
        <span>{node.span_count} spans</span>
        <span aria-hidden>·</span>
        <span>{node.trace_count} traces</span>
      </div>
      {node.operations.length > 0 ? (
        <div
          className="mt-1 truncate font-mono text-[9px] text-muted-foreground/80"
          title={node.operations.join(', ')}
        >
          {node.operations.slice(0, 2).join(', ')}
          {node.operations.length > 2 ? ` +${node.operations.length - 2}` : ''}
        </div>
      ) : null}
    </button>
  );
}

/**
 * Left-to-right architecture diagram for a group's component call graph. One
 * card per service (colored by a stable --chart-N slot), edges drawn as an SVG
 * overlay measured from the rendered cards with call-count labels. Cards are
 * clickable and drive the production drill-down.
 */
export function ComponentGraph({
  graph,
  selected,
  onSelect,
}: {
  graph: ComponentGraphData;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [segments, setSegments] = useState<EdgeSegment[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const serviceColors = useMemo(
    () => assignServiceColors(graph.nodes.map(node => node.id)),
    [graph]
  );

  const columns = useMemo(() => {
    const levels = computeLevels(graph);
    const byLevel = new Map<number, ComponentNode[]>();
    for (const node of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      const level = levels.get(node.id) ?? 0;
      const bucket = byLevel.get(level) ?? [];
      bucket.push(node);
      byLevel.set(level, bucket);
    }
    return [...byLevel.entries()].sort(([a], [b]) => a - b).map(([, nodes]) => nodes);
  }, [graph]);

  const registerRef = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) nodeRefs.current.set(id, element);
    else nodeRefs.current.delete(id);
  }, []);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const base = container.getBoundingClientRect();
    setSize({ width: base.width, height: base.height });
    const next: EdgeSegment[] = [];
    for (const edge of graph.edges) {
      const source = nodeRefs.current.get(edge.source);
      const target = nodeRefs.current.get(edge.target);
      if (!source || !target) continue;
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const x1 = sourceRect.right - base.left;
      const y1 = sourceRect.top + sourceRect.height / 2 - base.top;
      const x2 = targetRect.left - base.left;
      const y2 = targetRect.top + targetRect.height / 2 - base.top;
      next.push({
        key: `${edge.source}->${edge.target}`,
        x1,
        y1,
        x2,
        y2,
        midX: (x1 + x2) / 2,
        midY: (y1 + y2) / 2,
        calls: edge.calls,
      });
    }
    setSegments(next);
  }, [graph]);

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  return (
    <div ref={containerRef} className="relative overflow-x-auto">
      {/* Edge overlay. Stroke/fill reference reserved --border/--muted-foreground
          tokens (var() token references, not color literals). */}
      <svg
        className="pointer-events-none absolute inset-0"
        width={size.width || '100%'}
        height={size.height || '100%'}
        aria-hidden
      >
        <defs>
          <marker
            id="component-graph-arrow"
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 Z" style={{ fill: 'var(--border)' }} />
          </marker>
        </defs>
        {segments.map(segment => {
          const dx = Math.max((segment.x2 - segment.x1) / 2, 16);
          return (
            <path
              key={segment.key}
              d={`M ${segment.x1} ${segment.y1} C ${segment.x1 + dx} ${segment.y1}, ${segment.x2 - dx} ${segment.y2}, ${segment.x2} ${segment.y2}`}
              fill="none"
              style={{ stroke: 'var(--border)' }}
              strokeWidth={1.5}
              markerEnd="url(#component-graph-arrow)"
            />
          );
        })}
      </svg>

      {/* Call-count labels, positioned over each edge midpoint. */}
      {segments.map(segment => (
        <span
          key={`label-${segment.key}`}
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-card px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
          style={{ left: segment.midX, top: segment.midY }}
        >
          {segment.calls}×
        </span>
      ))}

      <div className="flex min-w-max items-stretch gap-12 py-4">
        {columns.map((nodes, columnIndex) => (
          <div key={columnIndex} className="flex flex-col justify-center gap-4">
            {nodes.map(node => (
              <ComponentNodeCard
                key={node.id}
                node={node}
                color={serviceColors.get(node.id) ?? serviceColors.values().next().value!}
                selected={selected === node.id}
                onSelect={onSelect}
                registerRef={registerRef}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
