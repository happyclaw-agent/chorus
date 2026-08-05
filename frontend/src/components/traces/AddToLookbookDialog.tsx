import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookPlus } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useQueryClient } from '@tanstack/react-query';

import { api, ApiError } from '@/api/client';
import { useDatasets } from '@/api/hooks';
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

/** Synthetic option value that reveals the "name the new dataset" field. */
const NEW_LOOKBOOK = '__new__';

/**
 * Shared bulk "Add to Lookbook" dialog for the three approved entry points
 * (new-from-selection, new-from-filtered-set, add-to-existing): given a set
 * of trace ids (the caller's current selection — whether hand-picked via
 * checkboxes or "select all matching filter"), let the user pick a target —
 * a brand-new Lookbook by name, or an existing one from a picker — then
 * promote every selected trace into it via the same per-trace
 * POST /api/traces/{id}/promote primitive PromoteToLookDialog uses. There is
 * intentionally no bulk backend endpoint: each trace is promoted with its
 * own request (Promise.allSettled), so partial failures are reported without
 * losing the successes.
 */
export function AddToLookbookDialog({
  traceIds,
  open,
  onOpenChange,
  onPromoted,
}: {
  traceIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once every selected trace has been promoted successfully. */
  onPromoted?: () => void;
}) {
  const datasetsQuery = useDatasets();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string>(NEW_LOOKBOOK);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ dataset: string; count: number } | null>(null);

  const datasetNames = useMemo(
    () => (datasetsQuery.data ?? []).map(dataset => dataset.name),
    [datasetsQuery.data]
  );

  // Reset the form each time the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setTarget(NEW_LOOKBOOK);
      setNewName('');
      setSubmitting(false);
      setError(null);
      setResult(null);
    }
  }, [open]);

  const isNew = target === NEW_LOOKBOOK;
  const datasetName = (isNew ? newName : target).trim();

  async function handleSave() {
    if (!datasetName || traceIds.length === 0) return;
    setSubmitting(true);
    setError(null);

    // Call the raw API directly rather than the usePromoteTrace() hook: the
    // hook invalidates ['datasets']/['runs']/['experiments']/['experiment-gate']
    // on every individual success, and firing that once per trace in a
    // 500-trace bulk batch cascades into hundreds of unnecessary refetches
    // while the batch is still in flight. Instead, invalidate each key once,
    // after the whole batch has settled.
    const outcomes = await Promise.allSettled(
      traceIds.map(traceId => api.promoteTrace(traceId, { dataset: datasetName }))
    );
    setSubmitting(false);

    void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    void queryClient.invalidateQueries({ queryKey: ['runs'] });
    void queryClient.invalidateQueries({ queryKey: ['experiments'] });
    void queryClient.invalidateQueries({ queryKey: ['experiment-gate'] });
    for (const traceId of traceIds) {
      void queryClient.invalidateQueries({ queryKey: ['trace', traceId] });
    }

    const failures = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    if (failures.length > 0) {
      const first = failures[0].reason;
      const message = first instanceof ApiError ? first.message : (first as Error).message;
      setError(`${failures.length} of ${traceIds.length} trace(s) failed to promote: ${message}`);
      return;
    }

    setResult({ dataset: datasetName, count: traceIds.length });
    onPromoted?.();
  }

  function handleClose() {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to Lookbook</DialogTitle>
          <DialogDescription>
            {result
              ? 'Every selected trace is now a versioned Look, with lineage back to the run that created it.'
              : `Promote ${traceIds.length} selected ${traceIds.length === 1 ? 'trace' : 'traces'} into a Lookbook — a new one, or an existing one alongside its current Looks.`}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <div
              data-testid="add-to-lookbook-success"
              className="rounded-md border border-success/50 bg-success/10 px-3 py-2.5 text-xs"
            >
              <div className="font-semibold text-success">
                Promoted {result.count} {result.count === 1 ? 'Look' : 'Looks'} into{' '}
                <span className="font-mono">{result.dataset}</span>
              </div>
            </div>
            <DialogFooter>
              <Button variant="secondary" size="sm" onClick={handleClose}>
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
                Target Lookbook
              </span>
              <select
                data-testid="add-to-lookbook-target-select"
                value={target}
                onChange={event => setTarget(event.target.value)}
                disabled={submitting}
                className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px] disabled:opacity-50"
              >
                <option value={NEW_LOOKBOOK}>+ New Lookbook…</option>
                {datasetNames.map(name => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {isNew ? (
              <label className="block space-y-1">
                <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  New Lookbook name
                </span>
                <Input
                  data-testid="add-to-lookbook-name-input"
                  value={newName}
                  onChange={event => setNewName(event.target.value)}
                  placeholder="e.g. regression-suite"
                  disabled={submitting}
                  autoFocus
                />
              </label>
            ) : null}
            {error ? (
              <div
                data-testid="add-to-lookbook-error"
                className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" size="sm" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={submitting || !datasetName || traceIds.length === 0}
                data-testid="add-to-lookbook-save"
              >
                <BookPlus className="size-3.5" />
                {submitting ? 'Adding…' : `Add ${traceIds.length} to Lookbook`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
