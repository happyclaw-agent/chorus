/** Types used by the Chorus quality-view API. */

export type RunStatus = 'ok' | 'error';

/** Lifecycle lane a run belongs to: local dev, CI/integration, or production. */
export type RunMode = 'dev' | 'ci' | 'prod';

export interface Run {
  trace_id: string;
  corpus: string;
  agent_id: string;
  agent_version: string | null;
  experiment_id: string | null;
  example_id: string | null;
  /** Agent-group membership (the top-level organizing concept). */
  group_id: string | null;
  group_name: string | null;
  /** Lifecycle lane; null when the run is not tagged with a mode. */
  mode: RunMode | null;
  input: string | null;
  output: string | null;
  status: RunStatus;
  models: string[];
  /** Services (spans) this run touched, e.g. claude-code, llm-gateway. */
  services: string[];
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  /** User-authored display name override (null when unset). Persisted in the
   * inbox as a trace_meta.jsonl sidecar; never mutates the source trace. */
  display_name: string | null;
  /** User-authored free-text notes (null when unset). Same persistence. */
  notes: string | null;
}

/** An agent group — the top-level unit that owns runs across dev/ci/prod. */
export interface Group {
  group_id: string;
  group_name: string;
  run_count: number;
  errors: number;
  cost_usd: number;
  first_seen: string | null;
  last_seen: string | null;
  /** Lifecycle modes present in the group (subset of dev/ci/prod). */
  modes: string[];
  services: string[];
  /** Distinct agent_ids currently counted as members of this group. */
  agent_ids: string[];
}

/** GET /api/groups/{id} — a group plus its runs split into lifecycle lanes. */
export interface GroupDetail {
  group: Group;
  lanes: {
    dev: Run[];
    ci: Run[];
    prod: Run[];
  };
}

/** DELETE /api/groups/{id} result — the group is hidden, not deleted. */
export interface HideGroupResult {
  group_id: string;
  hidden: boolean;
}

/**
 * GET /api/groups/{id}/graph — component (service) call graph for a group.
 * Typed now for the next builder's Production deep-dive; not yet rendered.
 */
export interface ComponentNode {
  id: string;
  span_count: number;
  error_count: number;
  trace_count: number;
  operations: string[];
}

export interface ComponentEdge {
  source: string;
  target: string;
  calls: number;
}

/** Shared shape for both graph endpoints below — the `<ComponentGraph>`
 * component only ever renders `nodes`/`edges`, so it accepts this base type
 * rather than either concrete response. */
export interface ComponentGraphShape {
  nodes: ComponentNode[];
  edges: ComponentEdge[];
}

export interface ComponentGraph extends ComponentGraphShape {
  group: Group;
}

/**
 * GET /api/traces/{id}/graph — system-lineage call graph scoped to a single
 * trace (extends the group-level component graph down to trace level).
 */
export interface TraceComponentGraph extends ComponentGraphShape {
  trace_id: string;
}

/**
 * GET /api/traces/{id}/logs — flat log records for a trace. Typed now for the
 * next builder's Production deep-dive; not yet rendered.
 */
export interface LogRecord {
  trace_id: string;
  span_id: string | null;
  group_id: string | null;
  ts_ns: number;
  severity: string;
  service: string;
  body: string;
  attributes: Record<string, unknown>;
}

export interface Span {
  span_id: string;
  name: string;
  /** Service (component) that emitted this span, e.g. claude-code, llm-gateway. */
  service?: string | null;
  start_ns: number;
  duration_ms: number;
  status: string;
  error_message: string | null;
  attributes: Record<string, unknown>;
  children: Span[];
}

export interface Score {
  trace_id: string;
  name: string;
  value: number | string | boolean | null;
  source: string | null;
  details: unknown;
}

export interface TraceDetail {
  run: Run;
  spans: Span | null;
  scores: Score[];
  /** Time-ordered log records emitted across the trace's services. */
  logs: LogRecord[];
}

export interface Experiment {
  experiment_id: string;
  name: string | null;
  description: string | null;
  baseline: string | null;
  candidate: string | null;
  trace_ids: string[];
  run_count: number;
}

export interface AgentStats {
  agent_id: string;
  runs: number;
  errors: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  p50_ms: number;
  p90_ms: number;
  p95_ms: number;
}

export interface Stats {
  agents: AgentStats[];
  totals: {
    runs: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
}

export interface DatasetExample {
  example_id: string;
  dataset: string;
  input: string | null;
  expected: string | null;
  metadata: Record<string, unknown> | null;
}

export interface Dataset {
  name: string;
  corpus: string;
  example_count: number;
  examples: DatasetExample[];
}

/** One arm (baseline or candidate) of an experiment grid cell. Score values
 * arrive stringified ("True"/"False"/floats). */
export interface GridCell {
  trace_id: string;
  status: RunStatus;
  cost_usd: number | null;
  latency_ms: number | null;
  scores: Record<string, string>;
}

export interface GridRow {
  example_id: string;
  baseline: GridCell | null;
  candidate: GridCell | null;
}

export interface ExperimentGrid {
  experiment: Experiment;
  evaluators: string[];
  rows: GridRow[];
}

/** Per-evaluator/per-row gate outcome. Now backend-driven (was client-side). */
export type Verdict = 'pass' | 'warn' | 'fail' | 'na';

/** Overall CI-style gate status for the experiment. */
export type GateStatus = 'pass' | 'warn' | 'blocked';

/** One evaluator's gate verdict on a Look, with the reason it was reached. */
export interface GateVerdict {
  verdict: Verdict;
  /** Human explanation, e.g. "dropped 0.67 vs baseline (>0.1)"; "" when pass. */
  reason: string;
  baseline: string | null;
  candidate: string | null;
}

/** Tolerance policy the gate was evaluated against. */
export interface GatePolicy {
  numeric_fail_below: number;
  numeric_max_drop: number;
  max_regressions: number;
}

/** One Look's gate outcome: overall flags plus each evaluator's verdict. */
export interface GateRow {
  example_id: string;
  status_fail: boolean;
  regressed: boolean;
  warned: boolean;
  baseline_trace: string | null;
  candidate_trace: string | null;
  verdicts: Record<string, GateVerdict>;
}

export interface GateSummary {
  examples: number;
  regressions: number;
  warnings: number;
  evaluators: string[];
}

/** GET /api/experiments/{id}/gate — the real promotion gate + tolerance policy. */
export interface GateResult {
  experiment_id: string;
  experiment: Experiment;
  baseline: string | null;
  candidate: string | null;
  policy: GatePolicy;
  status: GateStatus;
  /** CI-style pass/fail: false when the gate blocks promotion. */
  passed: boolean;
  summary: GateSummary;
  rows: GateRow[];
}

/** Tolerance overrides for a gate request (omit to use the policy defaults). */
export interface GateParams {
  max_regressions?: number;
  numeric_max_drop?: number;
  numeric_fail_below?: number;
}

/** Metric kind for a matrix experiment cell. `none` when no score matches. */
export type MatrixMetricType = 'bool' | 'numeric' | 'categorical' | 'none';

/**
 * One cell of a matrix experiment (row_key value × col_key value). Which
 * metric fields are populated depends on `metric_type` at the top level:
 * `bool` → pass_count/pass_rate; `categorical` → verdicts (plus
 * correct/accuracy only when a ground truth is present); `numeric` →
 * value_mean.
 */
export interface MatrixCell {
  row: string;
  col: string;
  n: number;
  trace_ids: string[];
  avg_cost_usd: number | null;
  avg_latency_ms: number | null;
  // metric_type === 'bool'
  pass_count?: number;
  pass_rate?: number; // 0..1
  // metric_type === 'categorical'
  verdicts?: { approve?: number; block?: number; unparseable?: number };
  correct?: number;
  accuracy?: number; // 0..1 — only when a ground truth is present
  // metric_type === 'numeric'
  value_mean?: number;
}

/** GET /api/experiments/{id}/matrix — a model matrix (not an A/B gate). */
export interface ExperimentMatrix {
  experiment_id: string;
  experiment: Experiment;
  score_name: string | null;
  metric_type: MatrixMetricType;
  /** For numeric metrics: whether a larger value_mean is the better result. */
  higher_is_better: boolean;
  row_key: string;
  col_key: string;
  /** All facet values seen for each axis key, e.g. {module:[...], coder_model:[...]}. */
  axis_options: Record<string, string[]>;
  rows: string[];
  cols: string[];
  cells: MatrixCell[];
}

/** Optional axis/score overrides for a matrix request (keys from axis_options). */
export interface MatrixParams {
  row?: string;
  col?: string;
  score?: string;
}

/**
 * POST /api/traces/{id}/promote — a trace turned into a Look (an Example) in a
 * versioned dataset. Returned by `promoteTrace`. The Look then shows up in the
 * Lookbooks view (GET /api/datasets).
 */
export interface PromoteResult {
  example_id: string;
  dataset: string;
  source_trace: string;
  input: string;
  expected: string;
}

/**
 * PUT /api/traces/{id}/meta — the persisted display name + notes for a trace.
 * Returned by `setTraceMeta`; the same values also come back on the trace
 * detail's run (run.display_name / run.notes).
 */
export interface TraceMeta {
  trace_id: string;
  name: string | null;
  notes: string | null;
}

/**
 * Body for a trace-meta update. Omit a field to leave it unchanged; pass ""
 * to clear it.
 */
export interface TraceMetaParams {
  name?: string;
  notes?: string;
}

/**
 * PUT /api/datasets/{name} — a Lookbook dataset renamed in place. The
 * examples file is rewritten under the new name in the writable inbox;
 * every Look keeps its example_id and metadata, only the dataset name (and
 * each Example's `dataset` field) changes.
 */
export interface RenameDatasetResult {
  name: string;
  example_count: number;
}

/** Body for editing a Look's expected value (its metadata is untouched). */
export interface UpdateLookParams {
  expected?: string;
}

/** DELETE /api/datasets/{name}/examples/{example_id} result. */
export interface RemoveLookResult {
  removed: string;
  dataset: string;
}

/** Body for a promote request (all optional; the server fills defaults). */
export interface PromoteParams {
  /** Target dataset the Look lands in (default "promoted-looks"). */
  dataset?: string;
  /** Optional expected output; defaults to the trace's own output. */
  expected?: string;
  /** Attribution recorded on the Look (default "runway"). */
  promoted_by?: string;
}

export interface RunFilters {
  agent_id?: string;
  experiment_id?: string;
  group_id?: string;
  mode?: RunMode;
  status?: RunStatus;
  limit?: number;
}

/** GET /api/experiments query params — `lookbook` returns only experiments
 * with at least one run/trace that resolved into that Lookbook (dataset). */
export interface ExperimentFilters {
  lookbook?: string;
}

/** A trace corpus loaded by the server: a directory or the permanent inbox. */
export interface CorpusInfo {
  path: string;
  exists: boolean;
  trace_count: number;
  /** `dir` for a mounted corpus directory; `inbox` for the live-receive inbox. */
  kind: 'dir' | 'inbox';
  /** False for the permanent inbox (cannot be removed). */
  removable: boolean;
}

/** GET /api/status — corpora + live-run count + the OTLP receiver path. */
export interface RunwayStatus {
  run_count: number;
  /** Relative OTLP/HTTP receiver path, e.g. "/v1/traces". */
  otlp_endpoint: string;
  corpora: CorpusInfo[];
}

/** One entry in a directory listing from GET /api/browse. */
export interface BrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_corpus: boolean;
  is_trace: boolean;
}

/** GET /api/browse — a directory listing (dirs + trace files only). */
export interface BrowseListing {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

/** POST /api/corpora result: a directory was added as a corpus. */
export interface AddCorpusResult {
  added: string;
  corpora: CorpusInfo[];
}

/** POST /api/corpora result: a single trace file was imported into the inbox. */
export interface ImportCorpusResult {
  imported_file: string;
  run_count: number;
}

/** POST /api/corpora returns one of the two shapes depending on the path kind. */
export type AddOrImportResult = AddCorpusResult | ImportCorpusResult;

/** DELETE /api/corpora result. */
export interface RemoveCorpusResult {
  removed: string;
  corpora: CorpusInfo[];
}
