import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

/** What the unified Traces source filter currently resolves to. */
export type TraceSource =
  | { kind: 'all' }
  | { kind: 'agent'; id: string }
  | { kind: 'group'; id: string };

interface AgentGroupOption {
  value: string;
  label: string;
}

interface AgentGroupFilterProps {
  /** Individual agent ids (already sorted/de-duped by the caller). */
  agents: AgentGroupOption[];
  /** Agent groups (from the useGroups hook), distinguished as a "Groups" section. */
  groups: AgentGroupOption[];
  value: TraceSource;
  onChange: (source: TraceSource) => void;
  className?: string;
}

const ALL_VALUE = '';
const AGENT_PREFIX = 'agent:';
const GROUP_PREFIX = 'group:';

/** Encode a {@link TraceSource} into the native `<select>` string value. */
function encode(source: TraceSource): string {
  switch (source.kind) {
    case 'agent':
      return `${AGENT_PREFIX}${source.id}`;
    case 'group':
      return `${GROUP_PREFIX}${source.id}`;
    default:
      return ALL_VALUE;
  }
}

/** Decode a native `<select>` value back into a {@link TraceSource}. */
function decode(raw: string): TraceSource {
  if (raw.startsWith(AGENT_PREFIX)) return { kind: 'agent', id: raw.slice(AGENT_PREFIX.length) };
  if (raw.startsWith(GROUP_PREFIX)) return { kind: 'group', id: raw.slice(GROUP_PREFIX.length) };
  return { kind: 'all' };
}

/**
 * Unified Traces source filter: one dropdown listing individual Agents and
 * Agent Groups, with Groups split into their own labeled section. Selecting an
 * Agent filters by `agent_id`; selecting a Group filters by `group_id`.
 *
 * Styled to match the shared dr-ui `Select`; native `<optgroup>`s give the
 * accessible "Agents"/"Groups" section headers.
 */
export function AgentGroupFilter({
  agents,
  groups,
  value,
  onChange,
  className,
}: AgentGroupFilterProps) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-secondary-foreground',
        className
      )}
    >
      <span className="text-muted-foreground">Source:</span>
      <span className="relative inline-flex items-center">
        <select
          data-testid="traces-source-filter"
          aria-label="Agent or Group"
          className="cursor-pointer appearance-none bg-transparent pr-5 font-medium text-foreground outline-none"
          value={encode(value)}
          onChange={event => onChange(decode(event.target.value))}
        >
          <option value={ALL_VALUE}>All agents &amp; groups</option>
          {agents.length > 0 ? (
            <optgroup label="Agents">
              {agents.map(agent => (
                <option key={agent.value} value={`${AGENT_PREFIX}${agent.value}`}>
                  {agent.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {groups.length > 0 ? (
            <optgroup label="Groups">
              {groups.map(group => (
                <option key={group.value} value={`${GROUP_PREFIX}${group.value}`}>
                  {group.label}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <ChevronDown className="pointer-events-none absolute right-0 size-3.5 text-muted-foreground" />
      </span>
    </label>
  );
}
