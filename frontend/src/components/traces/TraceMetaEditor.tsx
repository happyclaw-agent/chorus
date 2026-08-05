import { useEffect, useRef, useState } from 'react';
import { Check, Save } from 'lucide-react';

import { ApiError } from '@/api/client';
import { useSetTraceMeta } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { shortTraceId } from '@/lib/format';

/**
 * Editable display name + free-text notes for a trace. Seeds from the trace's
 * persisted values (run.display_name / run.notes) and saves via the real
 * PUT /api/traces/{id}/meta endpoint, which writes a trace_meta.jsonl sidecar
 * into the inbox — the source trace file is never mutated and lineage is kept
 * (the override references the trace_id only). Values survive a refresh.
 */
export function TraceMetaEditor({
  traceId,
  displayName,
  notes,
}: {
  traceId: string;
  displayName: string | null;
  notes: string | null;
}) {
  const save = useSetTraceMeta();
  const [name, setName] = useState(displayName ?? '');
  const [note, setNote] = useState(notes ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed the editable fields when the persisted values change (after a
  // save's own refetch, or when navigating between traces that reuse this
  // component). Deliberately does NOT touch `saved`/`error` — see below.
  useEffect(() => {
    setName(displayName ?? '');
    setNote(notes ?? '');
  }, [traceId, displayName, notes]);

  // Reset save/error state only on an actual trace switch. A successful save
  // invalidates the `['trace', traceId]` query, whose refetch re-runs the
  // effect above with the SAME traceId — if that also cleared `saved`, the
  // "Saved" confirmation would vanish within milliseconds of appearing
  // (before a user could ever see it). Keyed on traceId alone, this only
  // fires when the trace actually changes.
  useEffect(() => {
    setSaved(false);
    setError(null);
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, [traceId]);

  const dirty = name !== (displayName ?? '') || note !== (notes ?? '');

  function handleSave() {
    setError(null);
    setSaved(false);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    save.mutate(
      { traceId, name, notes: note },
      {
        onSuccess: () => {
          setSaved(true);
          // Auto-dismiss after a few seconds (standard toast behavior) rather
          // than relying on the next prop change to clear it — that's the
          // refetch race described above.
          savedTimer.current = setTimeout(() => setSaved(false), 3000);
        },
        onError: err => {
          const notFound = err instanceof ApiError && err.status === 404;
          setError(
            notFound
              ? `Trace ${shortTraceId(traceId)} was not found on the server.`
              : `Save failed: ${(err as Error).message}`
          );
        },
      }
    );
  }

  return (
    <div className="space-y-3 p-4" data-testid="trace-meta-editor">
      <label className="block space-y-1">
        <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Display name
        </span>
        <Input
          data-testid="trace-name-input"
          value={name}
          onChange={event => {
            setName(event.target.value);
            setSaved(false);
          }}
          placeholder="Give this trace a memorable name…"
          disabled={save.isPending}
        />
      </label>

      <label className="block space-y-1">
        <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Notes
        </span>
        <textarea
          data-testid="trace-notes-input"
          value={note}
          onChange={event => {
            setNote(event.target.value);
            setSaved(false);
          }}
          placeholder="Free-text notes about this trace — why it matters, what to check, follow-ups…"
          rows={4}
          disabled={save.isPending}
          className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
        />
      </label>

      {error ? (
        <div
          data-testid="trace-meta-error"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-2.5">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={save.isPending || !dirty}
          data-testid="trace-meta-save"
        >
          <Save className="size-3.5" />
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {saved ? (
          <span
            data-testid="trace-meta-saved"
            className="inline-flex items-center gap-1 text-xs text-success"
          >
            <Check className="size-3.5" /> Saved
          </span>
        ) : null}
      </div>
    </div>
  );
}
