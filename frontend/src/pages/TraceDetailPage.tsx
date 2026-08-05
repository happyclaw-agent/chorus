import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useTrace, useTraceGraph } from '@/api/hooks';
import { ApiError } from '@/api/client';
import type { Score } from '@/api/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { ComponentGraph } from '@/components/groups/ComponentGraph';
import { LogPanel } from '@/components/traces/LogPanel';
import { PromoteToLookButton } from '@/components/traces/PromoteToLookDialog';
import { SpanWaterfall } from '@/components/traces/SpanWaterfall';
import { StatusPill } from '@/components/traces/StatusPill';
import { TraceMetaEditor } from '@/components/traces/TraceMetaEditor';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PATHS } from '@/constants/path';
import {
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokens,
  shortTraceId,
  truncate,
} from '@/lib/format';
import { assignServiceColors } from '@/lib/serviceColors';
import type { Span } from '@/api/types';

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      <div className={mono ? 'font-mono text-xs' : 'text-xs'}>{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

function ScoreValue({ value }: { value: Score['value'] }) {
  if (typeof value === 'number') return <>{Number.isInteger(value) ? value : value.toFixed(3)}</>;
  if (typeof value === 'boolean')
    return <span className={value ? 'text-success' : 'text-destructive'}>{String(value)}</span>;
  return <>{value ?? '—'}</>;
}

function ScoresPanel({ scores }: { scores: Score[] }) {
  return (
    <Panel title={`Scores · ${scores.length}`}>
      {scores.length === 0 ? (
        <div className="px-4 py-4 text-xs text-muted-foreground">
          No scores recorded against this trace yet.
        </div>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scores.map((score, index) => (
              <TableRow key={`${score.name}-${index}`}>
                <TableCell className="font-medium">{score.name}</TableCell>
                <TableCell className="text-right font-mono">
                  <ScoreValue value={score.value} />
                </TableCell>
                <TableCell className="text-muted-foreground">{score.source ?? '—'}</TableCell>
                <TableCell className="max-w-96 font-mono text-[11px] break-all text-muted-foreground">
                  {score.details == null ? '—' : JSON.stringify(score.details)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function SystemLineagePanel({
  traceId,
  rootSpanId,
}: {
  traceId: string;
  rootSpanId: string | null;
}) {
  const graphQuery = useTraceGraph(traceId, rootSpanId ?? undefined);
  const [selected, setSelected] = useState<string | null>(null);

  if (graphQuery.isLoading) {
    return (
      <Panel title="System lineage">
        <div className="p-4">
          <Skeleton className="h-32 w-full" />
        </div>
      </Panel>
    );
  }
  const graph = graphQuery.data;
  if (!graph || graph.nodes.length === 0) return null;

  return (
    <Panel
      title={`System lineage · ${graph.nodes.length} service${graph.nodes.length === 1 ? '' : 's'}`}
    >
      <div className="p-3">
        <ComponentGraph
          graph={graph}
          selected={selected}
          onSelect={id => setSelected(current => (current === id ? null : id))}
        />
      </div>
    </Panel>
  );
}

export function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>();
  const [searchParams] = useSearchParams();
  const rootSpanId = searchParams.get('root_span_id') ?? undefined;
  const traceQuery = useTrace(traceId, rootSpanId);

  if (traceQuery.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (traceQuery.isError) {
    const error = traceQuery.error;
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div>
        <Link
          to={PATHS.TRACES}
          className="mb-4 inline-flex items-center gap-1.5 text-xs text-link hover:underline"
        >
          <ArrowLeft className="size-3.5" /> Back to traces
        </Link>
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-destructive">
          {notFound ? `Trace ${traceId} was not found.` : `Failed to load trace: ${error.message}`}
        </div>
      </div>
    );
  }

  const detail = traceQuery.data!;
  const { run, spans, scores, logs } = detail;

  const spanServices: Array<string | null | undefined> = [];
  const collect = (span: Span | null) => {
    if (!span) return;
    spanServices.push(span.service);
    span.children.forEach(collect);
  };
  collect(spans);
  for (const log of logs ?? []) spanServices.push(log.service);
  const serviceColors = assignServiceColors(spanServices);

  return (
    <section>
      <Link
        to={PATHS.TRACES}
        className="mb-3 inline-flex items-center gap-1.5 text-xs text-link hover:underline"
      >
        <ArrowLeft className="size-3.5" /> Back to traces
      </Link>

      <PageHeader
        eyebrow="Trace Detail"
        title={run.display_name?.trim() ? run.display_name : `Trace ${shortTraceId(run.trace_id)}`}
        description={run.input ? truncate(run.input, 180) : undefined}
        actions={
          <PromoteToLookButton traceId={run.trace_id} rootSpanId={run.root_span_id ?? undefined} />
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-border bg-card px-4 py-3">
        <StatusPill status={run.status} />
        <MetaItem label="Agent" value={run.agent_id} />
        <MetaItem label="Version" value={run.agent_version ?? '—'} mono />
        <MetaItem label="Duration" value={formatDuration(run.latency_ms)} mono />
        <MetaItem
          label="Tokens"
          value={`${formatTokens(run.input_tokens)} in / ${formatTokens(run.output_tokens)} out`}
          mono
        />
        <MetaItem label="Cost" value={formatCost(run.cost_usd)} mono />
        <MetaItem label="Started" value={formatTimestamp(run.started_at)} />
        {run.experiment_id ? <MetaItem label="Experiment" value={run.experiment_id} mono /> : null}
        {run.models.length > 0 ? (
          <MetaItem label="Models" value={run.models.join(', ')} mono />
        ) : null}
      </div>

      <div className="space-y-4">
        <Panel title="Name & notes">
          <TraceMetaEditor
            traceId={run.trace_id}
            rootSpanId={run.root_span_id ?? undefined}
            displayName={run.display_name}
            notes={run.notes}
          />
        </Panel>

        <Panel title="Span waterfall">
          <div className="p-3">
            {spans ? (
              <SpanWaterfall root={spans} />
            ) : (
              <div className="px-1 py-3 text-xs text-muted-foreground">
                No spans captured for this trace.
              </div>
            )}
          </div>
        </Panel>

        <SystemLineagePanel traceId={run.trace_id} rootSpanId={run.root_span_id} />

        {logs && logs.length > 0 ? (
          <Panel title={`Logs · ${logs.length}`}>
            <LogPanel logs={logs} serviceColors={serviceColors} traceStartNs={spans?.start_ns} />
          </Panel>
        ) : null}

        <ScoresPanel scores={scores} />

        {run.input ? (
          <Panel title="Input">
            <pre className="max-h-96 overflow-auto p-4 font-mono text-[11px] whitespace-pre-wrap text-secondary-foreground">
              {run.input}
            </pre>
          </Panel>
        ) : null}

        {run.output ? (
          <Panel title="Output">
            <pre className="max-h-96 overflow-auto p-4 font-mono text-[11px] whitespace-pre-wrap text-secondary-foreground">
              {run.output}
            </pre>
          </Panel>
        ) : null}
      </div>
    </section>
  );
}
