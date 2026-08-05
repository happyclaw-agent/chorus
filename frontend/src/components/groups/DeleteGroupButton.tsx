import { useState } from 'react';
import { Trash2 } from 'lucide-react';

import { ApiError } from '@/api/client';
import { useDeleteGroup } from '@/api/hooks';
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
 * Trash icon + confirm dialog that hides an Agent Group. Calls the real
 * DELETE /api/groups/{id} endpoint, which appends a `hide_group` override.
 * No trace file or run is touched (mirrors RemoveLookButton's
 * confirm-before-delete pattern).
 */
export function DeleteGroupButton({ groupId, groupName }: { groupId: string; groupName: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hide = useDeleteGroup();

  function handleConfirm() {
    setError(null);
    hide.mutate(groupId, {
      onSuccess: () => setOpen(false),
      onError: err => {
        setError(err instanceof ApiError ? err.message : `Hide failed: ${(err as Error).message}`);
      },
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Hide ${groupName}`}
        data-testid={`group-delete-button-${groupId}`}
        onClick={event => {
          event.stopPropagation();
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2 className="size-3.5 text-muted-foreground" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* Stop clicks from also bubbling into the card's own onClick (see
            RemoveLookButton for the same react-tree-portal-bubbling note). */}
        <DialogContent onClick={event => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Hide Agent Group</DialogTitle>
            <DialogDescription>
              Hides <span className="font-mono">{groupName}</span> from the Agent Groups list. No
              trace or run is deleted; this only removes the group from this Chorus view.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <div
              data-testid={`group-delete-error-${groupId}`}
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
              disabled={hide.isPending}
              data-testid={`group-delete-confirm-${groupId}`}
            >
              {hide.isPending ? 'Hiding…' : 'Hide'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
