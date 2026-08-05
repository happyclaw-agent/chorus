import { useState } from 'react';
import { Trash2 } from 'lucide-react';

import { ApiError } from '@/api/client';
import { useRemoveLook } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Trash icon + confirm dialog that removes a single Look from a Lookbook.
 * Calls the real DELETE /api/datasets/{name}/examples/{id} endpoint, which
 * drops only this Example from the inbox-writable dataset file — every
 * other Look, and the trace that created this one, are untouched.
 */
export function RemoveLookButton({ dataset, exampleId }: { dataset: string; exampleId: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = useRemoveLook();

  function handleConfirm() {
    setError(null);
    remove.mutate(
      { dataset, exampleId },
      {
        onSuccess: () => setOpen(false),
        onError: err => {
          setError(
            err instanceof ApiError ? err.message : `Remove failed: ${(err as Error).message}`
          );
        },
      }
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Remove Look"
        data-testid={`look-remove-button-${exampleId}`}
        onClick={event => {
          event.stopPropagation();
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2 className="size-3.5 text-muted-foreground" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* React portals still bubble clicks through the REACT tree (not the
            DOM tree) — this dialog is a react-tree descendant of the row's
            <tr onClick> toggle even though Radix portals its DOM elsewhere,
            so a click on Cancel/Remove would otherwise also expand/collapse
            the row. Stop it here. */}
        <DialogContent onClick={event => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Remove Look</DialogTitle>
            <DialogDescription>
              Removes <span className="font-mono">{exampleId}</span> from{' '}
              <span className="font-mono">{dataset}</span>. The source trace is untouched — only
              this Look leaves the Lookbook.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <div
              data-testid={`look-remove-error-${exampleId}`}
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirm}
              disabled={remove.isPending}
              data-testid={`look-remove-confirm-${exampleId}`}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
