import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';

import { useQueryClient } from '@tanstack/react-query';

import { api, ApiError } from '@/api/client';
import { useRuns } from '@/api/hooks';
import type { RunStatus } from '@/api/types';
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
import { Select } from '@/components/ui/select';
import { shortTraceId, truncate } from '@/lib/format';

/**
 * "Add Look..." modal for a Lookbook the user is already viewing on
 * LookbooksPage: an inline trace picker/search (status filter + free-text
 * search over `useRuns()`, the same filtering conventions TracesPage uses)
 * that lets the user pick one or more existing traces and promote them
 * directly into `datasetName` — no "new vs existing" target picker step
 * like AddToLookbookDialog, since the target is already known. Every
 * promoted Look still traces back to a real trace_id via the same
 * POST /api/traces/{id}/promote primitive AddToLookbookDialog uses (lineage
 * is a core product invariant): this is strictly "search/pick an existing
 * trace, promote it here", never a way to fabricate a Look with no source
 * trace.
 */
export function AddLookDialog({
  datasetName,
  open,
  onOpenChange,
  onPromoted,
}: {
  datasetName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once every selected trace has been promoted successfully. */
  onPromoted?: () => void;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ count: number } | null>(null);

  const runsQuery = useRuns({
    status: (status || undefined) as RunStatus | undefined,
    limit: 500,
  });

  // Reset the form each time the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setStatus('');
      setSearch('');
      setSelected(new Set());
      setSubmitting(false);
      setError(null);
      setResult(null);
    }
  }, [open]);

  const rows = useMemo(() => {
    const runs = runsQuery.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter(
      run =>
        run.trace_id.toLowerCase().includes(needle) ||
        (run.input ?? '').toLowerCase().includes(needle) ||
        (run.output ?? '').toLowerCase().includes(needle)
    );
  }, [runsQuery.data, search]);

  const allSelected = rows.length > 0 && rows.every(run => selected.has(run.trace_id));

  function toggleRow(traceId: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map(run => run.trace_id)));
  }

  async function handleSave() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);

    const traceIds = Array.from(selected);
    // One promote request per trace (no bulk endpoint), same batching as
    // AddToLookbookDialog: invalidate once after the whole batch settles
    // rather than once per trace.
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

    setResult({ count: traceIds.length });
    onPromoted?.();
  }

  function handleClose() {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Look to {datasetName}</DialogTitle>
          <DialogDescription>
            {result
              ? `${result.count} ${result.count === 1 ? 'Look' : 'Looks'} added to ${datasetName}, each with lineage back to the run that created it.`
              : `Search and pick one or more traces to promote directly into ${datasetName}.`}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <div
              data-testid="add-look-success"
              className="rounded-md border border-success/50 bg-success/10 px-3 py-2.5 text-xs"
            >
              <div className="font-semibold text-success">
                Promoted {result.count} {result.count === 1 ? 'Look' : 'Looks'} into{' '}
                <span className="font-mono">{datasetName}</span>
              </div>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={handleClose} data-testid="add-look-done">
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                label="Status"
                options={[
                  { value: 'ok', label: 'OK' },
                  { value: 'error', label: 'Error' },
                ]}
                value={status}
                onChange={event => setStatus(event.target.value)}
              />
              <Input
                data-testid="add-look-search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Filter by input, output, or trace id…"
                className="h-8 max-w-72 text-xs"
              />
              <span className="ml-auto text-xs text-muted-foreground">
                {runsQuery.isLoading ? 'Loading…' : `${rows.length} traces`}
              </span>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              {runsQuery.isLoading ? (
                <div className="p-4 text-xs text-muted-foreground">Loading traces…</div>
              ) : rows.length === 0 ? (
                <div className="p-4 text-xs text-muted-foreground">
                  No traces match the current filters.
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                      <th className="w-8 px-2 py-1.5">
                        <input
                          type="checkbox"
                          aria-label="Select all matching traces"
                          checked={allSelected}
                          onChange={toggleAll}
                          data-testid="add-look-select-all"
                        />
                      </th>
                      <th className="px-2 py-1.5 font-semibold">Trace</th>
                      <th className="px-2 py-1.5 font-semibold">Input</th>
                      <th className="px-2 py-1.5 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(run => (
                      <tr
                        key={run.trace_id}
                        className="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
                        onClick={() => toggleRow(run.trace_id)}
                      >
                        <td className="px-2 py-1.5" onClick={event => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select trace ${run.trace_id}`}
                            checked={selected.has(run.trace_id)}
                            onChange={() => toggleRow(run.trace_id)}
                            data-testid={`add-look-select-${run.trace_id}`}
                          />
                        </td>
                        <td className="px-2 py-1.5 font-mono text-secondary-foreground">
                          {shortTraceId(run.trace_id)}
                        </td>
                        <td className="max-w-0 truncate px-2 py-1.5" title={run.input ?? undefined}>
                          {truncate(run.input, 80)}
                        </td>
                        <td className="px-2 py-1.5 text-secondary-foreground">{run.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {error ? (
              <div
                data-testid="add-look-error"
                className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </div>
            ) : null}

            <DialogFooter>
              <span className="mr-auto self-center text-xs text-muted-foreground">
                {selected.size} selected
              </span>
              <Button variant="secondary" size="sm" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={submitting || selected.size === 0}
                data-testid="add-look-save"
              >
                <Plus className="size-3.5" />
                {submitting
                  ? 'Adding…'
                  : `Add ${selected.size} ${selected.size === 1 ? 'Look' : 'Looks'}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
