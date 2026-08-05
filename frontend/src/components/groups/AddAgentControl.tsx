import { useState } from 'react';
import { Plus, UserPlus } from 'lucide-react';

import { ApiError } from '@/api/client';
import { useAddAgentToGroup, useStats } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Searchable "add agent" dropdown for a group's Members panel, sourced from
 * the already-fetched GET /api/stats agent list (analogous to SourcesPage's
 * EntityPicker, but filtered client-side over the local list rather than a
 * debounced server search — the full agent list is already in hand, and it's
 * expected to stay small for a local corpus).
 */
export function AddAgentControl({
  groupId,
  memberIds,
}: {
  groupId: string;
  /** Agent ids already in the group, excluded from the candidate list. */
  memberIds: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stats = useStats();
  const addAgent = useAddAgentToGroup();

  const memberSet = new Set(memberIds);
  const nonMemberIds = (stats.data?.agents ?? [])
    .map(a => a.agent_id)
    .filter(id => !memberSet.has(id));
  const candidates = nonMemberIds.filter(id => id.toLowerCase().includes(query.toLowerCase()));

  // Bug #2: an agent that hasn't produced any traces yet will never show up
  // in GET /api/stats, so there'd otherwise be no way to add it. Offer a
  // "create" option whenever the typed name doesn't exactly (case
  // -insensitively) match an existing non-member agent — the backend's
  // add_agent_to_group accepts any agent_id unconditionally.
  const trimmedQuery = query.trim();
  const hasExactMatch = nonMemberIds.some(id => id.toLowerCase() === trimmedQuery.toLowerCase());
  const showCreateOption = trimmedQuery.length > 0 && !hasExactMatch;

  function handleSelect(agentId: string) {
    setError(null);
    addAgent.mutate(
      { groupId, agentId },
      {
        onSuccess: () => {
          setQuery('');
          setOpen(false);
        },
        onError: err => {
          setError(err instanceof ApiError ? err.message : `Add failed: ${(err as Error).message}`);
        },
      }
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <UserPlus className="size-3.5 text-muted-foreground" aria-hidden />
        <Input
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder="add agent…"
          className="h-8 w-48 text-xs"
          aria-label="Add agent to group"
          data-testid="group-add-agent-input"
        />
      </div>
      {error ? (
        <div
          data-testid="group-add-agent-error"
          className="mt-1 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
        >
          {error}
        </div>
      ) : null}
      {open ? (
        <div
          className="absolute z-20 mt-1 max-h-48 w-56 overflow-auto rounded-md border border-border bg-popover shadow-md"
          data-testid="group-add-agent-list"
        >
          {stats.isLoading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
          ) : (
            <>
              {candidates.length === 0 && !showCreateOption ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">No matching agents</div>
              ) : (
                candidates.map(agentId => (
                  <Button
                    key={agentId}
                    type="button"
                    variant="ghost"
                    className="block h-auto w-full justify-start truncate rounded-none px-3 py-1.5 text-left font-mono text-xs"
                    onMouseDown={event => {
                      // onMouseDown so this fires before the input's onBlur closes the list
                      event.preventDefault();
                      handleSelect(agentId);
                    }}
                    data-testid={`group-add-agent-option-${agentId}`}
                  >
                    {agentId}
                  </Button>
                ))
              )}
              {showCreateOption ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="flex h-auto w-full items-center gap-1.5 justify-start truncate rounded-none border-t border-border px-3 py-1.5 text-left font-mono text-xs text-primary"
                  onMouseDown={event => {
                    // onMouseDown so this fires before the input's onBlur closes the list
                    event.preventDefault();
                    handleSelect(trimmedQuery);
                  }}
                  data-testid="group-add-agent-create-option"
                >
                  <Plus className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">Create &quot;{trimmedQuery}&quot;</span>
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
