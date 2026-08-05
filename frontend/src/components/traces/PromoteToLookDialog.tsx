import { useEffect, useState } from 'react';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';

import { ApiError } from '@/api/client';
import { usePromoteTrace } from '@/api/hooks';
import type { PromoteResult } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PATHS } from '@/constants/path';
import { shortTraceId } from '@/lib/format';

/**
 * Controlled dialog that promotes a trace to a Look. Confirms/edits the target
 * dataset (and optionally the expected output), calls the real promote endpoint,
 * and on success shows an inline confirmation with a link to Lookbooks.
 */
export function PromoteToLookDialog({
  traceId,
  open,
  onOpenChange,
  defaultDataset = 'promoted-looks',
}: {
  traceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Target dataset pre-filled in the form (default "promoted-looks"). */
  defaultDataset?: string;
}) {
  const promote = usePromoteTrace();
  const [dataset, setDataset] = useState(defaultDataset);
  const [expected, setExpected] = useState('');
  const [result, setResult] = useState<PromoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset the form each time the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setDataset(defaultDataset);
      setExpected('');
      setResult(null);
      setError(null);
    }
  }, [open, defaultDataset]);

  function handlePromote() {
    setError(null);
    promote.mutate(
      {
        traceId,
        dataset: dataset.trim() || defaultDataset,
        expected: expected.trim() ? expected : undefined,
      },
      {
        onSuccess: promoted => setResult(promoted),
        onError: err => {
          const notFound = err instanceof ApiError && err.status === 404;
          setError(
            notFound
              ? `Trace ${shortTraceId(traceId)} was not found on the server.`
              : `Promotion failed: ${(err as Error).message}`
          );
        },
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote to Look</DialogTitle>
          <DialogDescription>
            {result
              ? 'This trace is now a versioned Look, with lineage back to the run that created it.'
              : 'Turn this trace into a versioned Look (an eval example) in a Lookbook. Its expected output defaults to the trace output — edit it to pin a different ground truth.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <div className="rounded-md border border-success/50 bg-success/10 px-3 py-2.5 text-xs">
              <div className="font-semibold text-success">
                Promoted to Look <span className="font-mono">{result.example_id}</span> in{' '}
                <span className="font-mono">{result.dataset}</span>
              </div>
              <div className="mt-1 text-muted-foreground">
                Lineage: trace{' '}
                <span className="font-mono">{shortTraceId(result.source_trace)}</span>
              </div>
            </div>
            <DialogFooter>
              <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button size="sm" asChild>
                <Link to={PATHS.LOOKBOOKS}>
                  View in Lookbooks
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                Dataset (Lookbook)
              </span>
              <Input
                value={dataset}
                onChange={event => setDataset(event.target.value)}
                placeholder="promoted-looks"
                disabled={promote.isPending}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                Expected output (optional)
              </span>
              <textarea
                value={expected}
                onChange={event => setExpected(event.target.value)}
                placeholder="Leave blank to use the trace's own output as the expected result."
                rows={4}
                disabled={promote.isPending}
                className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-[11px] outline-none focus-visible:ring-[3px] disabled:opacity-50"
              />
            </label>
            {error ? (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handlePromote} disabled={promote.isPending}>
                <Sparkles className="size-3.5" />
                {promote.isPending ? 'Promoting…' : 'Promote to Look'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Self-contained "Promote to Look" button + dialog for a trace. Used on the
 * trace detail page; other surfaces drive {@link PromoteToLookDialog} directly.
 */
export function PromoteToLookButton({
  traceId,
  defaultDataset,
}: {
  traceId: string;
  defaultDataset?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Sparkles className="size-3.5" />
        Promote to Look
      </Button>
      <PromoteToLookDialog
        traceId={traceId}
        open={open}
        onOpenChange={setOpen}
        defaultDataset={defaultDataset}
      />
    </>
  );
}
