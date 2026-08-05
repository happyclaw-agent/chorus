import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './client';
import type {
  ExperimentFilters,
  GateParams,
  MatrixParams,
  PromoteParams,
  RunFilters,
  TraceMetaParams,
  UpdateLookParams,
} from './types';

/**
 * Gentle background poll for the list/summary queries so runs pushed to the
 * live OTLP receiver (or corpora added on another tab) appear without a manual
 * refresh. Long enough not to thrash the backend; short enough to feel live.
 */
const LIVE_REFETCH_MS = 10_000;

export function useRuns(filters: RunFilters = {}) {
  return useQuery({
    queryKey: ['runs', filters],
    queryFn: () => api.getRuns(filters),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/** GET /api/groups — all agent groups (the top-level organizing layer). */
export function useGroups() {
  return useQuery({
    queryKey: ['groups'],
    queryFn: () => api.getGroups(),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/** GET /api/groups/{id} — one group plus its dev/ci/prod lane runs. */
export function useGroup(groupId: string | undefined) {
  return useQuery({
    queryKey: ['group', groupId],
    queryFn: () => api.getGroup(groupId!),
    enabled: Boolean(groupId),
  });
}

/**
 * GET /api/groups/{id}/graph — component call graph for a group. Provided for
 * the next builder's Production deep-dive; not yet rendered by any view.
 */
export function useGroupGraph(groupId: string | undefined) {
  return useQuery({
    queryKey: ['group-graph', groupId],
    queryFn: () => api.getGroupGraph(groupId!),
    enabled: Boolean(groupId),
  });
}

/**
 * DELETE /api/groups/{id} — hide an Agent Group. On success invalidates the
 * groups list so the hidden group disappears from GroupsPage.
 */
export function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => api.hideGroup(groupId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

/**
 * POST /api/groups/{id}/agents — add an agent to an Agent Group. On success
 * invalidates the groups list and this group's detail so the new member and
 * its runs show up in the rollup.
 */
export function useAddAgentToGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, agentId }: { groupId: string; agentId: string }) =>
      api.addAgentToGroup(groupId, agentId),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
      void queryClient.invalidateQueries({ queryKey: ['group', variables.groupId] });
    },
  });
}

/**
 * DELETE /api/groups/{id}/agents/{agentId} — remove an agent from one
 * specific Agent Group. On success invalidates the groups list and this
 * group's detail so the member and its runs disappear from the rollup.
 */
export function useRemoveAgentFromGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, agentId }: { groupId: string; agentId: string }) =>
      api.removeAgentFromGroup(groupId, agentId),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
      void queryClient.invalidateQueries({ queryKey: ['group', variables.groupId] });
    },
  });
}

export function useTrace(traceId: string | undefined) {
  return useQuery({
    queryKey: ['trace', traceId],
    queryFn: () => api.getTrace(traceId!),
    enabled: Boolean(traceId),
  });
}

/**
 * GET /api/traces/{id}/logs — flat log records for a trace. Provided for the
 * next builder's Production deep-dive; not yet rendered by any view.
 */
export function useTraceLogs(traceId: string | undefined) {
  return useQuery({
    queryKey: ['trace-logs', traceId],
    queryFn: () => api.getTraceLogs(traceId!),
    enabled: Boolean(traceId),
  });
}

/**
 * GET /api/traces/{id}/graph — system-lineage call graph for a single trace
 * (the group-level component graph extended down to trace level). Rendered
 * on TraceDetailPage's "System lineage" panel.
 */
export function useTraceGraph(traceId: string | undefined) {
  return useQuery({
    queryKey: ['trace-graph', traceId],
    queryFn: () => api.getTraceGraph(traceId!),
    enabled: Boolean(traceId),
  });
}

/**
 * GET /api/experiments — `filters.lookbook` (a dataset name) scopes the
 * result to experiments run against that Lookbook, e.g. the "Runs & Gates"
 * panel on LookbooksPage.
 */
export function useExperiments(filters: ExperimentFilters = {}) {
  return useQuery({
    queryKey: ['experiments', filters],
    queryFn: () => api.getExperiments(filters),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function useExperimentGrid(experimentId: string | undefined) {
  return useQuery({
    queryKey: ['experiment-grid', experimentId],
    queryFn: () => api.getExperimentGrid(experimentId!),
    enabled: Boolean(experimentId),
  });
}

/**
 * GET /api/experiments/{id}/matrix — a model matrix (row × col heatmap) for
 * experiments without an A/B baseline/candidate. `params` override the
 * auto-picked axes/score (keys come from the response's axis_options).
 */
export function useExperimentMatrix(experimentId: string | undefined, params: MatrixParams = {}) {
  return useQuery({
    queryKey: ['experiment-matrix', experimentId, params.row, params.col, params.score],
    queryFn: () => api.getExperimentMatrix(experimentId!, params),
    enabled: Boolean(experimentId),
  });
}

/**
 * GET /api/experiments/{id}/gate — the real promotion gate for an A/B
 * experiment. `params` are tolerance overrides; the query key includes them so
 * moving a control re-verdicts live. Polled like the other live queries.
 */
export function useGate(experimentId: string | undefined, params: GateParams = {}) {
  return useQuery({
    queryKey: [
      'experiment-gate',
      experimentId,
      params.max_regressions,
      params.numeric_max_drop,
      params.numeric_fail_below,
    ],
    queryFn: () => api.getGate(experimentId!, params),
    enabled: Boolean(experimentId),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: () => api.getStats(),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function useDatasets() {
  return useQuery({
    queryKey: ['datasets'],
    queryFn: () => api.getDatasets(),
  });
}

/**
 * PUT /api/datasets/{name} — rename a Lookbook dataset. On success
 * invalidates the datasets list so the renamed dataset (and its Looks)
 * reload under the new name.
 */
export function useRenameDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, newName }: { name: string; newName: string }) =>
      api.renameDataset(name, newName),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

/**
 * PUT /api/datasets/{name}/examples/{exampleId} — edit a Look's expected
 * value. On success invalidates the datasets list so the edited Look
 * reloads with its new expected value (metadata untouched).
 */
export function useUpdateLook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      dataset,
      exampleId,
      ...body
    }: { dataset: string; exampleId: string } & UpdateLookParams) =>
      api.updateLook(dataset, exampleId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

/**
 * DELETE /api/datasets/{name}/examples/{exampleId} — remove a Look from a
 * dataset. On success invalidates the datasets list so the removed Look
 * disappears.
 */
export function useRemoveLook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ dataset, exampleId }: { dataset: string; exampleId: string }) =>
      api.removeLook(dataset, exampleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

/**
 * GET /api/status — corpora + live run count + OTLP path. Polled so the run
 * count and any newly received traces surface without a manual refresh.
 */
export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => api.getStatus(),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/** GET /api/corpora — the loaded trace corpora (polled to stay current). */
export function useCorpora() {
  return useQuery({
    queryKey: ['corpora'],
    queryFn: () => api.getCorpora(),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/** GET /api/browse — a directory listing; enabled once a path is chosen. */
export function useBrowse(path: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['browse', path ?? ''],
    queryFn: () => api.browse(path),
    enabled,
  });
}

/** Invalidate everything that a corpus change can affect (runs, experiments, …). */
function invalidateAfterCorpusChange(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of [
    'runs',
    'groups',
    'group',
    'experiments',
    'stats',
    'status',
    'corpora',
    'datasets',
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/** POST /api/corpora — add a directory corpus or import a single trace file. */
export function useAddCorpus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.importOrAddCorpus(path),
    onSuccess: () => invalidateAfterCorpusChange(queryClient),
  });
}

/** DELETE /api/corpora — remove a corpus directory. */
export function useRemoveCorpus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.removeCorpus(path),
    onSuccess: () => invalidateAfterCorpusChange(queryClient),
  });
}

/**
 * POST /api/traces/{id}/promote — promote a trace to a Look. Invalidates the
 * datasets (Lookbooks), the trace detail, and the run/experiment/gate views so
 * the new Look and its lineage surface live.
 */
export function usePromoteTrace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ traceId, ...body }: { traceId: string } & PromoteParams) =>
      api.promoteTrace(traceId, body),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
      void queryClient.invalidateQueries({ queryKey: ['trace', variables.traceId] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['experiments'] });
      void queryClient.invalidateQueries({ queryKey: ['experiment-gate'] });
    },
  });
}

/**
 * PUT /api/traces/{id}/meta — save a trace's display name + notes. On success
 * invalidates the trace detail (so the persisted values reload) and the run
 * lists (the name can surface there too).
 */
export function useSetTraceMeta() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ traceId, ...body }: { traceId: string } & TraceMetaParams) =>
      api.setTraceMeta(traceId, body),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['trace', variables.traceId] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });
}

/** POST /api/refresh, then refetch everything. */
export function useRefresh() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refresh(),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
