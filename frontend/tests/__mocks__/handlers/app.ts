import { http, HttpResponse } from 'msw';

const run = {
  trace_id: 'abc123def4567890',
  corpus: '/tmp/corpus',
  agent_id: 'test-agent',
  agent_version: 'v1',
  experiment_id: null,
  example_id: 'look-001',
  group_id: 'emea-planning',
  group_name: 'EMEA Planning',
  mode: 'prod',
  input: 'What is the forecast?',
  output: 'The forecast is sunny.',
  status: 'ok',
  models: [],
  services: ['claude-code', 'llm-gateway'],
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 200,
  cost_usd: 0.01,
  latency_ms: 1234,
  started_at: '2026-07-19T09:00:00-04:00',
  ended_at: '2026-07-19T09:00:01-04:00',
  display_name: null,
  notes: null,
};

const group = {
  group_id: 'emea-planning',
  group_name: 'EMEA Planning',
  run_count: 3,
  errors: 1,
  cost_usd: 3.02,
  first_seen: '2026-07-19T08:55:24-04:00',
  last_seen: '2026-07-19T13:55:24-04:00',
  modes: ['ci', 'dev', 'prod'],
  services: ['claude-code', 'daria', 'llm-gateway'],
  agent_ids: ['test-agent'],
};

const experiment = {
  experiment_id: 'exp-1',
  name: 'model swap v1 vs v2',
  description: '',
  baseline: 'v1',
  candidate: 'v2',
  trace_ids: ['abc123def4567890', 'cand123def4567890'],
  run_count: 2,
};

// A matrix experiment (no A/B arms) — exercises the matrix-grid branch.
const boolMatrixExperiment = {
  experiment_id: 'coder-matrix',
  name: 'Coder model x module matrix',
  description: '',
  baseline: null,
  candidate: null,
  trace_ids: ['m1', 'm2', 'm3', 'm4'],
  run_count: 4,
};

const verdictMatrixExperiment = {
  experiment_id: 'reviewer-matrix',
  name: 'Reviewer model verdicts vs ground truth',
  description: '',
  baseline: null,
  candidate: null,
  trace_ids: ['v1', 'v2', 'v3'],
  run_count: 3,
};

const numericMatrixExperiment = {
  experiment_id: 'latency-matrix',
  name: 'Latency by model x module',
  description: '',
  baseline: null,
  candidate: null,
  trace_ids: ['n1', 'n2', 'n3', 'n4'],
  run_count: 4,
};

const boolMatrix = {
  experiment_id: 'coder-matrix',
  experiment: boolMatrixExperiment,
  score_name: 'ground_truth_tests',
  metric_type: 'bool' as const,
  higher_is_better: true,
  row_key: 'module',
  col_key: 'coder_model',
  axis_options: {
    module: ['binning', 'avg'],
    coder_model: [
      'datarobot/bedrock/anthropic.claude-opus-4-8',
      'datarobot/bedrock/deepseek.r1-v1:0',
    ],
    model: ['datarobot/bedrock/anthropic.claude-opus-4-8', 'datarobot/bedrock/deepseek.r1-v1:0'],
  },
  rows: ['binning', 'avg'],
  cols: ['datarobot/bedrock/anthropic.claude-opus-4-8', 'datarobot/bedrock/deepseek.r1-v1:0'],
  cells: [
    {
      row: 'binning',
      col: 'datarobot/bedrock/anthropic.claude-opus-4-8',
      n: 1,
      trace_ids: ['m1'],
      avg_cost_usd: 20.5,
      avg_latency_ms: 240000,
      pass_count: 1,
      pass_rate: 1.0,
    },
    {
      row: 'binning',
      col: 'datarobot/bedrock/deepseek.r1-v1:0',
      n: 2,
      trace_ids: ['m2', 'm3'],
      avg_cost_usd: 0.007,
      avg_latency_ms: 11000,
      pass_count: 0,
      pass_rate: 0.0,
    },
    // avg × opus intentionally omitted -> empty cell
    {
      row: 'avg',
      col: 'datarobot/bedrock/deepseek.r1-v1:0',
      n: 1,
      trace_ids: ['m4'],
      avg_cost_usd: 0.006,
      avg_latency_ms: 9000,
      pass_count: 1,
      pass_rate: 1.0,
    },
  ],
};

const verdictMatrix = {
  experiment_id: 'reviewer-matrix',
  experiment: verdictMatrixExperiment,
  score_name: 'reviewer_verdict',
  metric_type: 'categorical' as const,
  higher_is_better: true,
  row_key: 'coder_model',
  col_key: 'reviewer_model',
  axis_options: {
    coder_model: ['datarobot/bedrock/deepseek.r1-v1:0'],
    reviewer_model: [
      'datarobot/bedrock/anthropic.claude-opus-4-8',
      'datarobot/bedrock/openai.gpt-oss-120b-1:0',
    ],
    model: [
      'datarobot/bedrock/anthropic.claude-opus-4-8',
      'datarobot/bedrock/openai.gpt-oss-120b-1:0',
    ],
  },
  rows: ['datarobot/bedrock/deepseek.r1-v1:0'],
  cols: [
    'datarobot/bedrock/anthropic.claude-opus-4-8',
    'datarobot/bedrock/openai.gpt-oss-120b-1:0',
  ],
  cells: [
    {
      row: 'datarobot/bedrock/deepseek.r1-v1:0',
      col: 'datarobot/bedrock/anthropic.claude-opus-4-8',
      n: 5,
      trace_ids: ['v1', 'v2', 'v3', 'v1b', 'v1c'],
      avg_cost_usd: 0.7,
      avg_latency_ms: 50000,
      verdicts: { block: 5 },
      correct: 5,
      accuracy: 1.0,
    },
    {
      row: 'datarobot/bedrock/deepseek.r1-v1:0',
      col: 'datarobot/bedrock/openai.gpt-oss-120b-1:0',
      n: 5,
      trace_ids: ['v4', 'v5', 'v6', 'v7', 'v8'],
      avg_cost_usd: 0.0008,
      avg_latency_ms: 10000,
      verdicts: { approve: 4, block: 1 },
      correct: 1,
      accuracy: 0.2,
    },
  ],
};

// A numeric matrix (metric_type "numeric" with value_mean cells). Lower latency
// is better, so heat should invert relative to the raw value.
const numericMatrix = {
  experiment_id: 'latency-matrix',
  experiment: numericMatrixExperiment,
  score_name: 'latency_ms',
  metric_type: 'numeric' as const,
  higher_is_better: false,
  row_key: 'module',
  col_key: 'coder_model',
  axis_options: {
    module: ['binning', 'avg'],
    coder_model: [
      'datarobot/bedrock/anthropic.claude-opus-4-8',
      'datarobot/bedrock/deepseek.r1-v1:0',
    ],
  },
  rows: ['binning', 'avg'],
  cols: ['datarobot/bedrock/anthropic.claude-opus-4-8', 'datarobot/bedrock/deepseek.r1-v1:0'],
  cells: [
    {
      row: 'binning',
      col: 'datarobot/bedrock/anthropic.claude-opus-4-8',
      n: 2,
      trace_ids: ['n1', 'n2'],
      avg_cost_usd: 0.5,
      avg_latency_ms: 12000,
      value_mean: 12.34,
    },
    {
      row: 'binning',
      col: 'datarobot/bedrock/deepseek.r1-v1:0',
      n: 1,
      trace_ids: ['n3'],
      avg_cost_usd: 0.002,
      avg_latency_ms: 4200,
      value_mean: 4.2,
    },
    {
      row: 'avg',
      col: 'datarobot/bedrock/deepseek.r1-v1:0',
      n: 1,
      trace_ids: ['n4'],
      avg_cost_usd: 0.003,
      avg_latency_ms: 8800,
      value_mean: 8.8,
    },
  ],
};

const matrices: Record<string, typeof boolMatrix | typeof verdictMatrix | typeof numericMatrix> = {
  'coder-matrix': boolMatrix,
  'reviewer-matrix': verdictMatrix,
  'latency-matrix': numericMatrix,
};

const corpora = [
  {
    path: '/tmp/demo-corpus',
    exists: true,
    trace_count: 27,
    kind: 'dir' as const,
    removable: true,
  },
  {
    path: '/Users/test/hackathon-corpus',
    exists: true,
    trace_count: 50,
    kind: 'dir' as const,
    removable: true,
  },
  {
    path: '/Users/test/.chorus/inbox',
    exists: true,
    trace_count: 0,
    kind: 'inbox' as const,
    removable: false,
  },
];

export const appHandlers = [
  http.get('*/api/status', () =>
    HttpResponse.json({ run_count: 198, otlp_endpoint: '/v1/traces', corpora })
  ),
  http.get('*/api/corpora', () => HttpResponse.json(corpora)),
  http.post('*/api/corpora', async ({ request }) => {
    const body = (await request.json()) as { path?: string };
    const path = body.path ?? '';
    if (path.endsWith('.otlp.json') || path.endsWith('.otlp.json.gz')) {
      return HttpResponse.json({ imported_file: path, run_count: 199 });
    }
    return HttpResponse.json({ added: path, corpora });
  }),
  http.delete('*/api/corpora', async ({ request }) => {
    const body = (await request.json()) as { path?: string };
    return HttpResponse.json({ removed: body.path ?? '', corpora });
  }),
  http.get('*/api/entities/:entityType', ({ params }) =>
    HttpResponse.json({ entity_type: params.entityType, entities: [] })
  ),
  http.get('*/api/browse', ({ request }) => {
    const url = new URL(request.url);
    const path = url.searchParams.get('path') ?? '/Users/test';
    return HttpResponse.json({
      path,
      parent: '/Users',
      entries: [
        {
          name: 'demo-corpus',
          path: `${path}/demo-corpus`,
          is_dir: true,
          is_corpus: true,
          is_trace: false,
        },
        {
          name: 'notes',
          path: `${path}/notes`,
          is_dir: true,
          is_corpus: false,
          is_trace: false,
        },
        {
          name: 'run.otlp.json',
          path: `${path}/run.otlp.json`,
          is_dir: false,
          is_corpus: false,
          is_trace: true,
        },
      ],
    });
  }),
  http.post('*/api/refresh', () => HttpResponse.json({ runs: 198 })),
  http.get('*/api/runs', () => HttpResponse.json([run])),
  http.get('*/api/groups', () => HttpResponse.json([group])),
  http.get('*/api/groups/:groupId', ({ params }) => {
    if (params.groupId !== 'emea-planning') {
      return HttpResponse.json({ detail: 'not found' }, { status: 404 });
    }
    return HttpResponse.json({
      group,
      lanes: {
        dev: [{ ...run, trace_id: 'dev0000000000001', mode: 'dev', input: 'iterate on tool' }],
        ci: [{ ...run, trace_id: 'ci00000000000001', mode: 'ci', input: 'ci regression run' }],
        prod: [
          { ...run, mode: 'prod', input: 'prod scenario run' },
          {
            ...run,
            trace_id: 'prod000000000002',
            mode: 'prod',
            status: 'error',
            input: 'prod scenario that errored',
          },
        ],
      },
    });
  }),
  http.delete('*/api/groups/:groupId', ({ params }) =>
    HttpResponse.json({ group_id: params.groupId, hidden: true })
  ),
  http.post('*/api/groups/:groupId/agents', ({ params }) =>
    HttpResponse.json({
      group: { ...group, group_id: params.groupId },
      lanes: { dev: [], ci: [], prod: [] },
    })
  ),
  http.delete('*/api/groups/:groupId/agents/:agentId', ({ params }) =>
    HttpResponse.json({
      group: { ...group, group_id: params.groupId },
      lanes: { dev: [], ci: [], prod: [] },
    })
  ),
  http.get('*/api/experiments', () =>
    HttpResponse.json([
      experiment,
      boolMatrixExperiment,
      verdictMatrixExperiment,
      numericMatrixExperiment,
    ])
  ),
  http.get('*/api/experiments/:experimentId/matrix', ({ params }) => {
    const matrix = matrices[params.experimentId as string];
    if (!matrix) return HttpResponse.json({ detail: 'not found' }, { status: 404 });
    return HttpResponse.json(matrix);
  }),
  http.get('*/api/experiments/:experimentId/gate', ({ request, params }) => {
    if (params.experimentId !== 'exp-1') {
      return HttpResponse.json({ detail: 'not found' }, { status: 404 });
    }
    const url = new URL(request.url);
    const maxRegressions = Number(url.searchParams.get('max_regressions') ?? '0');
    const numericMaxDrop = Number(url.searchParams.get('numeric_max_drop') ?? '0.1');
    // look-001 regresses; whether the gate blocks depends on the tolerance.
    const regressions = 1;
    const passed = regressions <= maxRegressions;
    return HttpResponse.json({
      experiment_id: 'exp-1',
      experiment,
      baseline: 'v1',
      candidate: 'v2',
      policy: {
        numeric_fail_below: 0.5,
        numeric_max_drop: numericMaxDrop,
        max_regressions: maxRegressions,
      },
      status: passed ? 'pass' : 'blocked',
      passed,
      summary: {
        examples: 2,
        regressions,
        warnings: 0,
        evaluators: ['ground_truth_tests', 'reviewer_verdict'],
      },
      rows: [
        {
          example_id: 'look-001',
          status_fail: true,
          regressed: true,
          warned: false,
          baseline_trace: 'abc123def4567890',
          candidate_trace: 'cand123def4567890',
          verdicts: {
            ground_truth_tests: {
              verdict: 'fail',
              reason: 'boolean flipped True→False',
              baseline: 'True',
              candidate: 'False',
            },
            reviewer_verdict: {
              verdict: 'fail',
              reason: 'dropped 0.67 vs baseline (>0.1)',
              baseline: '0.92',
              candidate: '0.25',
            },
          },
        },
        {
          example_id: 'look-002',
          status_fail: false,
          regressed: false,
          warned: false,
          baseline_trace: 'abc123def4567890',
          candidate_trace: 'cand123def4567890',
          verdicts: {
            ground_truth_tests: {
              verdict: 'pass',
              reason: '',
              baseline: 'True',
              candidate: 'True',
            },
            reviewer_verdict: { verdict: 'pass', reason: '', baseline: '0.9', candidate: '0.91' },
          },
        },
      ],
    });
  }),
  http.get('*/api/experiments/:experimentId/grid', () =>
    HttpResponse.json({
      experiment,
      evaluators: ['ground_truth_tests', 'reviewer_verdict'],
      rows: [
        {
          example_id: 'look-001',
          baseline: {
            trace_id: 'abc123def4567890',
            status: 'ok',
            cost_usd: 0.01,
            latency_ms: 1234,
            scores: { ground_truth_tests: 'True', reviewer_verdict: '0.92' },
          },
          candidate: {
            trace_id: 'cand123def4567890',
            status: 'error',
            cost_usd: 0.02,
            latency_ms: 4321,
            scores: { ground_truth_tests: 'False', reviewer_verdict: '0.25' },
          },
        },
        {
          example_id: 'look-002',
          baseline: {
            trace_id: 'abc123def4567890',
            status: 'ok',
            cost_usd: 0.01,
            latency_ms: 1000,
            scores: { ground_truth_tests: 'True', reviewer_verdict: '0.9' },
          },
          candidate: {
            trace_id: 'cand123def4567890',
            status: 'ok',
            cost_usd: 0.01,
            latency_ms: 900,
            scores: { ground_truth_tests: 'True', reviewer_verdict: '0.91' },
          },
        },
      ],
    })
  ),
  http.get('*/api/datasets', () =>
    HttpResponse.json([
      {
        name: 'planning-lookbook',
        corpus: '/tmp/corpus',
        example_count: 2,
        examples: [
          {
            example_id: 'look-001',
            dataset: 'planning-lookbook',
            input: 'What if spend +15%?',
            expected: 'Grounded scenario result.',
            metadata: {
              source_trace: 'abc123def4567890',
              promoted_by: 'jj',
              graders: ['ground_truth_tests'],
              assertions: 2,
            },
          },
          {
            example_id: 'look-002',
            dataset: 'planning-lookbook',
            input: 'Forecast Q4 revenue.',
            expected: null,
            metadata: null,
          },
        ],
      },
    ])
  ),
  http.put('*/api/datasets/:name', async ({ request, params }) => {
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    return HttpResponse.json({ name: body.name ?? params.name, example_count: 2 });
  }),
  http.put('*/api/datasets/:name/examples/:exampleId', async ({ request, params }) => {
    const body = (await request.json().catch(() => ({}))) as { expected?: string };
    return HttpResponse.json({
      example_id: params.exampleId,
      dataset: params.name,
      input: 'What if spend +15%?',
      expected: body.expected ?? null,
      metadata: {
        source_trace: 'abc123def4567890',
        promoted_by: 'jj',
        graders: ['ground_truth_tests'],
        assertions: 2,
      },
    });
  }),
  http.delete('*/api/datasets/:name/examples/:exampleId', ({ params }) =>
    HttpResponse.json({ removed: params.exampleId, dataset: params.name })
  ),
  http.get('*/api/stats', () =>
    HttpResponse.json({
      agents: [
        {
          agent_id: 'test-agent',
          runs: 1,
          errors: 0,
          cost_usd: 0.01,
          input_tokens: 100,
          output_tokens: 50,
          p50_ms: 1234,
          p90_ms: 1234,
          p95_ms: 1234,
        },
      ],
      totals: { runs: 1, cost_usd: 0.01, input_tokens: 100, output_tokens: 50 },
    })
  ),
  http.get('*/api/ui/traces/:traceId', ({ params }) =>
    HttpResponse.json({
      run,
      spans: {
        span_id: 'span-1',
        name: 'agent.run',
        service: 'claude-code',
        start_ns: 0,
        duration_ms: 1234,
        status: 'ok',
        error_message: null,
        attributes: { 'gen_ai.prompt': 'What is the forecast?' },
        children: [
          {
            span_id: 'span-2',
            name: 'chat.completion',
            service: 'llm-gateway',
            start_ns: 500_000_000,
            duration_ms: 600,
            status: 'ok',
            error_message: null,
            attributes: {},
            children: [],
          },
        ],
      },
      scores: [
        { trace_id: params.traceId, name: 'accuracy', value: 0.9, source: 'judge', details: null },
      ],
      logs: [
        {
          trace_id: params.traceId,
          span_id: null,
          group_id: 'emea-planning',
          ts_ns: 200_000_000,
          severity: 'INFO',
          service: 'claude-code',
          body: 'started planning run',
          attributes: {},
        },
        {
          trace_id: params.traceId,
          span_id: null,
          group_id: 'emea-planning',
          ts_ns: 800_000_000,
          severity: 'ERROR',
          service: 'llm-gateway',
          body: 'downstream model timeout after 30s',
          attributes: { 'http.status': 504 },
        },
      ],
    })
  ),
  http.put('*/api/traces/:traceId/meta', async ({ request, params }) => {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      notes?: string;
    };
    return HttpResponse.json({
      trace_id: params.traceId,
      name: body.name ?? null,
      notes: body.notes ?? null,
    });
  }),
  http.post('*/api/traces/:traceId/promote', async ({ request, params }) => {
    const body = (await request.json().catch(() => ({}))) as {
      expected_output?: string;
      attributes?: { dataset?: string };
    };
    return HttpResponse.json({
      case_id: 'look-001',
      input_text: 'What is the forecast?',
      actual_output: 'The forecast is sunny.',
      expected_output: body.expected_output ?? null,
      trace: { trace_id: params.traceId },
    });
  }),
  http.post('*/api/traces/:traceId/judge', async ({ request }) => {
    // The browser sends no token; the backend resolves the caller's DataRobot
    // identity server-side (proxy-injected visitor key when deployed, dev
    // shell token on localhost), so the judge just succeeds.
    const body = (await request.json().catch(() => ({}))) as { samples?: number };
    const samples = body.samples ?? 1;
    return HttpResponse.json({
      verdict: 'block',
      confidence: 0.87,
      votes: `${samples}/${samples}`,
      model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
      samples,
      input_tokens: 512,
      output_tokens: 47,
      per_sample: Array.from({ length: samples }, () => ({
        verdict: 'block',
        confidence: 0.87,
        reasoning: 'Output is not grounded in the input.',
        input_tokens: Math.round(512 / samples),
        output_tokens: Math.round(47 / samples),
      })),
    });
  }),
  http.post('*/api/traces/:traceId/describe', () => {
    // The browser sends no token; the backend resolves the caller's
    // DataRobot identity server-side, so the describe call just succeeds.
    return HttpResponse.json({
      trace_id: 'abc123def4567890',
      description: 'The agent looked up the EMEA planning forecast and returned a sunny outlook.',
      model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
    });
  }),
  http.get('*/api/traces/:traceId/logs', ({ params }) =>
    HttpResponse.json([
      {
        trace_id: params.traceId,
        span_id: null,
        group_id: 'emea-planning',
        ts_ns: 200_000_000,
        severity: 'INFO',
        service: 'datarobot-mcp',
        body: 'vdb_query matched 3 EMEA planning docs',
        attributes: { docs: 3 },
      },
      {
        trace_id: params.traceId,
        span_id: null,
        group_id: 'emea-planning',
        ts_ns: 800_000_000,
        severity: 'ERROR',
        service: 'llm-gateway',
        body: 'downstream model timeout after 30s',
        attributes: { 'http.status': 504 },
      },
    ])
  ),
  http.get('*/api/traces/:traceId/graph', ({ params }) =>
    HttpResponse.json({
      trace_id: params.traceId,
      nodes: [
        {
          id: 'claude-code',
          span_count: 1,
          error_count: 0,
          trace_count: 1,
          operations: ['agent.run'],
        },
        {
          id: 'llm-gateway',
          span_count: 1,
          error_count: 0,
          trace_count: 1,
          operations: ['chat.completion'],
        },
      ],
      edges: [{ source: 'claude-code', target: 'llm-gateway', calls: 1 }],
    })
  ),
  http.get('*/api/groups/:groupId/graph', () =>
    HttpResponse.json({
      group,
      nodes: [
        {
          id: 'claude-code',
          span_count: 9,
          error_count: 0,
          trace_count: 5,
          operations: ['datarobot_agent'],
        },
        {
          id: 'datarobot-mcp',
          span_count: 1,
          error_count: 0,
          trace_count: 1,
          operations: ['tool.vdb_query'],
        },
        {
          id: 'daria-deployment',
          span_count: 1,
          error_count: 0,
          trace_count: 1,
          operations: ['agent.plan'],
        },
        {
          id: 'llm-gateway',
          span_count: 1,
          error_count: 1,
          trace_count: 1,
          operations: ['chat.completion'],
        },
      ],
      edges: [
        { source: 'claude-code', target: 'datarobot-mcp', calls: 1 },
        { source: 'datarobot-mcp', target: 'daria-deployment', calls: 1 },
        { source: 'daria-deployment', target: 'llm-gateway', calls: 1 },
      ],
    })
  ),
];
