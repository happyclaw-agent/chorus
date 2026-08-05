export const PATHS = {
  GROUPS: '/groups',
  GROUP_DETAIL: '/groups/:groupId',
  TRACES: '/traces',
  TRACE_DETAIL: '/traces/:traceId',
  EVALS: '/evals',
  RUNS: '/runs',
  MONITOR: '/monitor',
  SOURCES: '/sources',
} as const;

export const traceDetailPath = (traceId: string, rootSpanId?: string | null) => {
  if (!rootSpanId) return `/traces/${traceId}`;
  return `/traces/${traceId}?${new URLSearchParams({ root_span_id: rootSpanId })}`;
};
export const groupDetailPath = (groupId: string) => `/groups/${encodeURIComponent(groupId)}`;

/** Traces filtered to one group (read by TracesPage's useSearchParams
 * initializer) to pre-select this group in the unified Agent/Group source
 * filter. Optionally scoped to error runs only. */
export const tracesUrlForGroup = (groupId: string, onlyErrors?: boolean) => {
  const params = new URLSearchParams({ group: groupId });
  if (onlyErrors) params.set('status', 'error');
  return `/traces?${params.toString()}`;
};

/** Traces filtered to one agent (read by TracesPage's useSearchParams
 * initializer via `agent_id`) to pre-select this agent in the unified
 * Agent/Group source filter. Optionally scoped to error runs only. */
export const tracesUrlForAgent = (agentId: string, onlyErrors?: boolean) => {
  const params = new URLSearchParams({ agent_id: agentId });
  if (onlyErrors) params.set('status', 'error');
  return `/traces?${params.toString()}`;
};

/** Traces filtered to error runs only, with no agent/group scoping — for the
 * global "N errors" stats (AppShell top bar, Monitor's Error rate tile). */
export const tracesUrlForErrors = () => '/traces?status=error';
