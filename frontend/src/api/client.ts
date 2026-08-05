import { getApiUrl } from '@/lib/utils';

import type {
  AddOrImportResult,
  BrowseListing,
  ComponentGraph,
  CorpusInfo,
  Dataset,
  Experiment,
  EvalRun,
  EvaluationOverview,
  ExperimentGrid,
  ExperimentMatrix,
  GateParams,
  GateResult,
  Group,
  GroupDetail,
  HideGroupResult,
  LogRecord,
  MatrixParams,
  PromoteParams,
  PromoteResult,
  RemoveLookResult,
  RenameDatasetResult,
  TraceMeta,
  TraceMetaParams,
  UpdateLookParams,
  RemoveCorpusResult,
  Run,
  RunCount,
  RunFacets,
  RunFilters,
  ChorusStatus,
  Stats,
  TraceComponentGraph,
  TraceDetail,
  DatasetExample,
} from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type QueryParams = Record<string, string | number | undefined>;
let tokenPrompt: Promise<string | null> | null = null;

function needsQueryGroupRoute(groupId: string): boolean {
  return groupId.includes('/') || groupId.includes('\\');
}

async function promptForApiToken(): Promise<string | null> {
  if (!tokenPrompt) {
    tokenPrompt = Promise.resolve().then(() => {
      const value = window.prompt('Enter the Chorus API token for this session:')?.trim() ?? '';
      if (!value) return null;
      window.sessionStorage.setItem('chorus.apiToken', value);
      return value;
    });
  }
  try {
    return await tokenPrompt;
  } finally {
    tokenPrompt = null;
  }
}

/**
 * Small typed fetch wrapper. All URLs are built off `getApiUrl()`, which
 * resolves `window.ENV.BASE_PATH` (injected by the FastAPI server when the app
 * runs under a workload base path) and falls back to `/` in local dev, where
 * Vite proxies `/api` to the backend.
 */
async function request<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    params?: QueryParams;
    body?: unknown;
  } = {}
): Promise<T> {
  const url = new URL(`${getApiUrl()}${path}`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const hasBody = options.body !== undefined;
  const fetchWithToken = (token: string | null) =>
    fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    });

  const existingToken = window.sessionStorage.getItem('chorus.apiToken');
  let response = await fetchWithToken(existingToken);
  if (response.status === 401) {
    const newerToken = window.sessionStorage.getItem('chorus.apiToken');
    if (newerToken && newerToken !== existingToken) {
      response = await fetchWithToken(newerToken);
    } else {
      window.sessionStorage.removeItem('chorus.apiToken');
      const enteredToken = await promptForApiToken();
      if (enteredToken) response = await fetchWithToken(enteredToken);
    }
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') {
        detail = body.detail;
      }
    } catch {
      // non-JSON error body — keep statusText
    }
    throw new ApiError(response.status, `${response.status}: ${detail}`);
  }

  return (await response.json()) as T;
}

export const api = {
  getRuns: (filters: RunFilters = {}) => request<Run[]>('/runs', { params: { ...filters } }),
  getAllRuns: async (filters: RunFilters = {}) => {
    const pageSize = 1000;
    const rows: Run[] = [];
    const { offset: _offset, limit: _limit, ...corpusFilters } = filters;
    while (true) {
      const page = await request<Run[]>('/runs', {
        params: { ...corpusFilters, offset: rows.length, limit: pageSize },
      });
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  },
  getRunCount: (filters: RunFilters = {}) =>
    request<RunCount>('/run-count', {
      params: { ...filters, limit: undefined, offset: undefined },
    }),
  getRunFacets: () => request<RunFacets>('/run-facets'),
  getGroups: () => request<Group[]>('/groups'),
  getGroup: (groupId: string) =>
    needsQueryGroupRoute(groupId)
      ? request<GroupDetail>('/group-by-id', { params: { group_id: groupId } })
      : request<GroupDetail>(`/groups/${encodeURIComponent(groupId)}`),
  getGroupGraph: (groupId: string) =>
    needsQueryGroupRoute(groupId)
      ? request<ComponentGraph>('/group-by-id/graph', { params: { group_id: groupId } })
      : request<ComponentGraph>(`/groups/${encodeURIComponent(groupId)}/graph`),
  /**
   * DELETE /api/groups/{id} — hide an Agent Group by appending a
   * `hide_group` override to the inbox-global sidecar. Trace files are never
   * mutated. 404s if the group isn't currently visible.
   */
  hideGroup: (groupId: string) =>
    needsQueryGroupRoute(groupId)
      ? request<HideGroupResult>('/group-by-id', {
          method: 'DELETE',
          params: { group_id: groupId },
        })
      : request<HideGroupResult>(`/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' }),
  /**
   * POST /api/groups/{id}/agents — add an agent to an Agent Group. Wins over
   * both trace-stamped and groups.jsonl-sidecar membership; can create a
   * brand-new group_id. Returns the updated group detail.
   */
  addAgentToGroup: (groupId: string, agentId: string) =>
    needsQueryGroupRoute(groupId)
      ? request<GroupDetail>('/group-by-id/agents', {
          method: 'POST',
          params: { group_id: groupId },
          body: { agent_id: agentId },
        })
      : request<GroupDetail>(`/groups/${encodeURIComponent(groupId)}/agents`, {
          method: 'POST',
          body: { agent_id: agentId },
        }),
  /**
   * DELETE /api/groups/{id}/agents/{agentId} — remove an agent from one
   * specific Agent Group; membership in any other group is untouched.
   * Returns the updated group detail.
   */
  removeAgentFromGroup: (groupId: string, agentId: string) =>
    needsQueryGroupRoute(groupId) || needsQueryGroupRoute(agentId)
      ? request<GroupDetail>('/group-by-id/agents', {
          method: 'DELETE',
          params: { group_id: groupId, agent_id: agentId },
        })
      : request<GroupDetail>(
          `/groups/${encodeURIComponent(groupId)}/agents/${encodeURIComponent(agentId)}`,
          { method: 'DELETE' }
        ),
  getTrace: (traceId: string, rootSpanId?: string) =>
    request<TraceDetail>(`/ui/traces/${traceId}`, { params: { root_span_id: rootSpanId } }),
  getTraceLogs: (traceId: string, rootSpanId?: string) =>
    request<LogRecord[]>(`/traces/${traceId}/logs`, { params: { root_span_id: rootSpanId } }),
  getTraceGraph: (traceId: string, rootSpanId?: string) =>
    request<TraceComponentGraph>(`/traces/${traceId}/graph`, {
      params: { root_span_id: rootSpanId },
    }),
  /**
   * PUT /api/traces/{id}/meta — persist a user-authored display name and/or
   * notes for a trace. Written into the inbox as a sidecar (no source-trace
   * mutation); omit a field to leave it unchanged, "" to clear it.
   */
  setTraceMeta: (traceId: string, rootSpanId: string | undefined, body: TraceMetaParams) =>
    request<TraceMeta>(`/traces/${traceId}/meta`, {
      method: 'PUT',
      params: { root_span_id: rootSpanId },
      body,
    }),
  /**
   * POST /api/traces/{id}/promote — turn a trace into an eval case in a
   * versioned eval suite. Idempotent per (dataset, example_id).
   */
  promoteTrace: async (traceId: string, body: PromoteParams = {}) => {
    const dataset = body.dataset ?? 'promoted-evals';
    const result = await request<{
      case_id: string;
      input_text: string;
      actual_output: string;
      expected_output: string | null;
      trace: { trace_id: string };
    }>(`/traces/${traceId}/promote`, {
      method: 'POST',
      body: {
        root_span_id: body.root_span_id,
        expected_output: body.expected,
        attributes: { dataset, promoted_by: body.promoted_by ?? 'chorus' },
      },
    });
    return {
      example_id: result.case_id,
      dataset,
      source_trace: result.trace.trace_id,
      input: result.input_text,
      expected: result.expected_output ?? result.actual_output,
    } satisfies PromoteResult;
  },
  /** GET /api/experiments — completed evaluation executions. */
  getExperiments: () => request<Experiment[]>('/experiments'),
  getEvalRuns: () => request<EvalRun[]>('/eval-runs'),
  getEvaluationOverview: () => request<EvaluationOverview>('/evals'),
  getExperimentGrid: (experimentId: string) =>
    request<ExperimentGrid>(`/experiments/${experimentId}/grid`),
  getExperimentMatrix: (experimentId: string, params: MatrixParams = {}) =>
    request<ExperimentMatrix>(`/experiments/${experimentId}/matrix`, {
      params: { row: params.row, col: params.col, score: params.score },
    }),
  /**
   * GET /api/experiments/{id}/gate — the real promotion gate. Query params
   * override the policy defaults; omit one to keep its default (0 sends "0").
   */
  getGate: (experimentId: string, params: GateParams = {}) =>
    request<GateResult>(`/experiments/${experimentId}/gate`, {
      params: {
        max_regressions: params.max_regressions,
        numeric_max_drop: params.numeric_max_drop,
        numeric_fail_below: params.numeric_fail_below,
      },
    }),
  getStats: () => request<Stats>('/stats'),
  getDatasets: () => request<Dataset[]>('/datasets'),
  /**
   * PUT /api/datasets/{name} — rename a Lookbook dataset: rewrites its
   * examples file under the new name in the writable inbox, preserving
   * every Look. 400s if the dataset lives in a read-only corpus or the new
   * name is already taken; 404s if the dataset doesn't exist.
   */
  renameDataset: (name: string, newName: string) =>
    request<RenameDatasetResult>(`/datasets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: { name: newName },
    }),
  /**
   * PUT /api/datasets/{name}/examples/{exampleId} — edit a Look's expected
   * value in place; its metadata (source_trace, promoted_by, ...) is
   * preserved untouched.
   */
  updateLook: (name: string, exampleId: string, body: UpdateLookParams) =>
    request<DatasetExample>(
      `/datasets/${encodeURIComponent(name)}/examples/${encodeURIComponent(exampleId)}`,
      { method: 'PUT', body }
    ),
  /** DELETE /api/datasets/{name}/examples/{exampleId} — remove a Look from a dataset. */
  removeLook: (name: string, exampleId: string) =>
    request<RemoveLookResult>(
      `/datasets/${encodeURIComponent(name)}/examples/${encodeURIComponent(exampleId)}`,
      { method: 'DELETE' }
    ),
  refresh: () => request<{ runs: number }>('/refresh', { method: 'POST' }),

  /** GET /api/status — corpora, live run count, and the OTLP receiver path. */
  getStatus: () => request<ChorusStatus>('/status'),
  /** GET /api/corpora — the loaded trace corpora. */
  getCorpora: () => request<CorpusInfo[]>('/corpora'),
  /**
   * POST /api/corpora — the server decides based on the path: a directory is
   * added as a corpus, a single .otlp.json[.gz] file is imported into the inbox.
   */
  importOrAddCorpus: (path: string) =>
    request<AddOrImportResult>('/corpora', { method: 'POST', body: { path } }),
  /** POST /api/corpora with a directory path (same endpoint as importOrAddCorpus). */
  addCorpus: (path: string) =>
    request<AddOrImportResult>('/corpora', { method: 'POST', body: { path } }),
  /** DELETE /api/corpora — remove a corpus directory (never the inbox). */
  removeCorpus: (path: string) =>
    request<RemoveCorpusResult>('/corpora', { method: 'DELETE', body: { path } }),
  /** GET /api/browse — a directory listing (dirs + trace files). */
  browse: (path?: string) => request<BrowseListing>('/browse', { params: { path } }),
};
