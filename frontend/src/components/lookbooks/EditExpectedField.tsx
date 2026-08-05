import { useEffect, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';

import { ApiError } from '@/api/client';
import { useUpdateLook } from '@/api/hooks';
import { Button } from '@/components/ui/button';

/**
 * Inline editable "Expected" field for a Look, shown in a Lookbook's
 * expanded row detail. Saves via the real PUT
 * /api/datasets/{name}/examples/{id} endpoint, which rewrites only the
 * `expected` field in place — the Look's metadata (source_trace,
 * promoted_by, ...) is preserved untouched.
 */
export function EditExpectedField({
  dataset,
  exampleId,
  expected,
}: {
  dataset: string;
  exampleId: string;
  expected: string | null;
}) {
  const update = useUpdateLook();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(expected ?? '');
  const [error, setError] = useState<string | null>(null);

  // Re-seed from the persisted value whenever it changes underneath us
  // (a refetch after save, or switching to a different Look's row), but only
  // while not actively editing — otherwise a background refetch would stomp
  // on in-progress edits.
  useEffect(() => {
    if (!editing) setValue(expected ?? '');
  }, [expected, editing]);

  function handleSave() {
    setError(null);
    update.mutate(
      { dataset, exampleId, expected: value },
      {
        onSuccess: () => setEditing(false),
        onError: err => {
          setError(
            err instanceof ApiError ? err.message : `Save failed: ${(err as Error).message}`
          );
        },
      }
    );
  }

  function handleCancel() {
    setValue(expected ?? '');
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            Expected
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit expected"
            data-testid={`look-edit-expected-button-${exampleId}`}
            onClick={event => {
              event.stopPropagation();
              setEditing(true);
            }}
          >
            <Pencil className="size-3 text-muted-foreground" />
          </Button>
        </div>
        <pre className="rounded-md border border-border bg-card p-2.5 font-mono text-[11px] whitespace-pre-wrap text-secondary-foreground">
          {expected ?? '—'}
        </pre>
      </div>
    );
  }

  return (
    <div onClick={event => event.stopPropagation()}>
      <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        Expected
      </div>
      <textarea
        data-testid={`look-expected-input-${exampleId}`}
        value={value}
        onChange={event => setValue(event.target.value)}
        rows={4}
        disabled={update.isPending}
        className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2.5 py-2 font-mono text-[11px] outline-none focus-visible:ring-[3px] disabled:opacity-50"
      />
      {error ? (
        <div
          data-testid={`look-expected-error-${exampleId}`}
          className="mt-1.5 rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive"
        >
          {error}
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={update.isPending}
          data-testid={`look-expected-save-${exampleId}`}
        >
          <Check className="size-3.5" />
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleCancel}
          disabled={update.isPending}
          data-testid={`look-expected-cancel-${exampleId}`}
        >
          <X className="size-3.5" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
