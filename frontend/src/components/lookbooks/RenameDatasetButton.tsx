import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';

import { ApiError } from '@/api/client';
import { useRenameDataset } from '@/api/hooks';
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

/**
 * Icon-button + dialog to rename a Lookbook (a dataset). Calls the real
 * PUT /api/datasets/{name} endpoint, which rewrites the dataset's examples
 * file under the new name inside the writable inbox — every Look keeps its
 * example_id and metadata, only the dataset name changes. The endpoint 400s
 * if the dataset lives in a read-only corpus (can't rename what Chorus
 * doesn't own) or if the new name is already taken; both surface here as an
 * inline error rather than crashing the page.
 */
export function RenameDatasetButton({
  datasetName,
  onRenamed,
}: {
  datasetName: string;
  /** Called with the new name once the rename succeeds, so the caller can
   * follow the selection onto the renamed dataset. */
  onRenamed: (newName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(datasetName);
  const [error, setError] = useState<string | null>(null);
  const rename = useRenameDataset();

  // Reset the form to the current name each time the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setName(datasetName);
      setError(null);
    }
  }, [open, datasetName]);

  function handleSave() {
    const newName = name.trim();
    if (!newName || newName === datasetName) {
      setOpen(false);
      return;
    }
    setError(null);
    rename.mutate(
      { name: datasetName, newName },
      {
        onSuccess: result => {
          onRenamed(result.name);
          setOpen(false);
        },
        onError: err => {
          setError(
            err instanceof ApiError ? err.message : `Rename failed: ${(err as Error).message}`
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
        aria-label={`Rename ${datasetName}`}
        data-testid="lookbook-rename-button"
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename eval suite</DialogTitle>
            <DialogDescription>
              Renames the suite in place — every eval case keeps its lineage; only the suite name
              changes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                Name
              </span>
              <Input
                data-testid="lookbook-rename-input"
                value={name}
                onChange={event => setName(event.target.value)}
                disabled={rename.isPending}
                autoFocus
              />
            </label>
            {error ? (
              <div
                data-testid="lookbook-rename-error"
                className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={rename.isPending || !name.trim()}
              data-testid="lookbook-rename-save"
            >
              {rename.isPending ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
