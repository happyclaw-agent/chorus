import { useState } from 'react';
import { X } from 'lucide-react';

import { ApiError } from '@/api/client';
import { useRemoveAgentFromGroup } from '@/api/hooks';
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
 * Icon + confirm dialog that removes one agent from an Agent Group. Calls
 * the real DELETE /api/groups/{id}/agents/{agentId} endpoint, which only
 * clears this specific group's membership — the agent's runs in any other
 * group are untouched, and re-adding it later is a single click away.
 * Mirrors RemoveLookButton's confirm-before-remove pattern.
 */
export function RemoveGroupAgentButton({ groupId, agentId }: { groupId: string; agentId: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = useRemoveAgentFromGroup();

  function handleConfirm() {
    setError(null);
    remove.mutate(
      { groupId, agentId },
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
        aria-label={`Remove ${agentId} from group`}
        data-testid={`group-member-remove-button-${agentId}`}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <X className="size-3.5 text-muted-foreground" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove member</DialogTitle>
            <DialogDescription>
              Removes <span className="font-mono">{agentId}</span> from this group only — any
              membership it has in another group is untouched, and it can be added back anytime.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <div
              data-testid={`group-member-remove-error-${agentId}`}
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
              data-testid={`group-member-remove-confirm-${agentId}`}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
