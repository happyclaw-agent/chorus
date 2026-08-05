import { useState } from 'react';
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Database,
  FileJson,
  Inbox,
  Radio,
} from 'lucide-react';

import { useAddCorpus, useStatus } from '@/api/hooks';
import { ApiError } from '@/api/client';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn, getAppUrl } from '@/lib/utils';

interface Result {
  kind: 'ok' | 'error';
  text: string;
}

function ResultBanner({ result, onDismiss }: { result: Result; onDismiss: () => void }) {
  const ok = result.kind === 'ok';
  return (
    <div
      className={cn(
        'mb-3 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs',
        ok ? 'border-success/40 bg-success/10' : 'border-destructive/40 bg-destructive/10'
      )}
      role="status"
      data-testid="sources-result"
    >
      {ok ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      ) : (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      )}
      <span className="flex-1 break-all text-secondary-foreground">{result.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="cursor-pointer text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function OtlpCard() {
  const { data: status } = useStatus();
  const [copied, setCopied] = useState(false);
  const endpoint = status?.otlp_endpoint ?? '/v1/traces';
  const fullUrl = getAppUrl(endpoint);

  const copy = () => {
    void navigator.clipboard?.writeText(fullUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        <Radio className="size-3.5 text-success" aria-hidden />
        Live OTLP receiver
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <code
          className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs break-all text-foreground"
          data-testid="otlp-endpoint"
        >
          {fullUrl}
        </code>
        <Button variant="secondary" size="sm" onClick={copy} title="Copy the OTLP endpoint URL">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Point any OpenTelemetry SDK at this standard OTLP/HTTP endpoint. Traces appear live without
        an application-specific transport or envelope.
      </p>
    </div>
  );
}

function ImportCard() {
  const importCorpus = useAddCorpus();
  const [path, setPath] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const submit = () => {
    const source = path.trim();
    if (!source) return;
    setResult(null);
    importCorpus.mutate(source, {
      onSuccess: response => {
        const imported = 'imported_file' in response ? response.imported_file : response.added;
        setResult({ kind: 'ok', text: `Imported ${imported}` });
      },
      onError: error =>
        setResult({
          kind: 'error',
          text: error instanceof ApiError ? error.message : (error as Error).message,
        }),
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        <FileJson className="size-3.5 text-primary" aria-hidden />
        Import standard OTLP
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Input
          aria-label="OTLP file or directory"
          value={path}
          onChange={event => setPath(event.target.value)}
          placeholder="/path/to/traces.otlp.jsonl"
          className="min-w-64 flex-1 font-mono"
        />
        <Button size="sm" onClick={submit} disabled={!path.trim() || importCorpus.isPending}>
          <Database className="size-3.5" />
          {importCorpus.isPending ? 'Importing…' : 'Import'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Import a canonical OTLP JSON file, OTLP JSONL file, or a directory containing those files.
      </p>
      {result ? (
        <div className="mt-3">
          <ResultBanner result={result} onDismiss={() => setResult(null)} />
        </div>
      ) : null}
    </div>
  );
}

export function SourcesPage() {
  const status = useStatus();

  return (
    <section>
      <PageHeader
        eyebrow="Data Plane"
        title="Sources"
        description="Bring traces in through standard OTLP and inspect the canonical local corpus Chorus is reading."
      />

      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <OtlpCard />
        <ImportCard />
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Inbox className="size-4 text-primary" aria-hidden />
          <div>
            <h2 className="text-sm font-semibold">Canonical trace corpus</h2>
            <p className="text-xs text-muted-foreground">
              Append-only OTLP JSONL; Abbrivio content, feedback, and eval records remain linked
              sidecars.
            </p>
          </div>
        </div>

        {status.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : status.isError ? (
          <div className="p-5 text-sm text-destructive">
            Failed to load sources: {(status.error as Error).message}
          </div>
        ) : (
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Kind</TableHead>
                <TableHead className="w-full">Path</TableHead>
                <TableHead className="text-right">Trace runs</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(status.data?.corpora ?? []).map(corpus => (
                <TableRow key={corpus.path}>
                  <TableCell>
                    <Badge variant="outline">{corpus.kind}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] break-all">{corpus.path}</TableCell>
                  <TableCell className="text-right font-mono">{corpus.trace_count}</TableCell>
                  <TableCell>
                    <span className={corpus.exists ? 'text-success' : 'text-destructive'}>
                      {corpus.exists ? 'Ready' : 'Waiting'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
