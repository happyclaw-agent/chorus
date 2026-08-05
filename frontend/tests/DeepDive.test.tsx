import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ComponentGraph } from '../src/components/groups/ComponentGraph';
import { LogPanel } from '../src/components/traces/LogPanel';
import { ThemeProvider } from '../src/theme/theme-provider';
import type { ComponentGraph as ComponentGraphData, LogRecord } from '../src/api/types';

const graph: ComponentGraphData = {
  group: {
    group_id: 'emea-planning',
    group_name: 'EMEA Planning',
    run_count: 3,
    errors: 1,
    cost_usd: 3.02,
    first_seen: null,
    last_seen: null,
    modes: ['dev', 'ci', 'prod'],
    services: ['claude-code', 'datarobot-mcp', 'daria-deployment', 'llm-gateway'],
    agent_ids: ['claude-code', 'daria'],
  },
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
    { source: 'daria-deployment', target: 'llm-gateway', calls: 2 },
  ],
};

const logs: LogRecord[] = [
  {
    trace_id: 't1',
    span_id: null,
    group_id: 'emea-planning',
    ts_ns: 200_000_000,
    severity: 'INFO',
    service: 'datarobot-mcp',
    body: 'vdb_query matched 3 EMEA planning docs',
    attributes: {},
  },
  {
    trace_id: 't1',
    span_id: null,
    group_id: 'emea-planning',
    ts_ns: 800_000_000,
    severity: 'ERROR',
    service: 'llm-gateway',
    body: 'downstream model timeout after 30s',
    attributes: { 'http.status': 504 },
  },
];

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

describe('ComponentGraph', () => {
  it('renders one node per service, the call chain, and an error badge', () => {
    const onSelect = vi.fn();
    render(<ComponentGraph graph={graph} selected={null} onSelect={onSelect} />);

    // one card per service
    expect(screen.getByText('claude-code')).toBeInTheDocument();
    expect(screen.getByText('datarobot-mcp')).toBeInTheDocument();
    expect(screen.getByText('daria-deployment')).toBeInTheDocument();
    expect(screen.getByText('llm-gateway')).toBeInTheDocument();

    // error badge only on the failing component
    expect(screen.getByText('1 err')).toBeInTheDocument();

    // clicking a node selects it
    fireEvent.click(screen.getByText('llm-gateway'));
    expect(onSelect).toHaveBeenCalledWith('llm-gateway');
  });
});

describe('LogPanel', () => {
  it('renders severity, service and body for each log record', () => {
    render(<LogPanel logs={logs} traceStartNs={0} />);

    expect(screen.getByText('INFO')).toBeInTheDocument();
    expect(screen.getByText('ERROR')).toBeInTheDocument();
    expect(screen.getByText('downstream model timeout after 30s')).toBeInTheDocument();
    // services are labeled
    expect(screen.getByText('datarobot-mcp')).toBeInTheDocument();
  });
});

describe('Production deep-dive drill-down', () => {
  it('drills from component → prod trace → multi-service waterfall + correlated logs', async () => {
    renderApp('/groups/emea-planning');

    // deep-dive section + component graph
    expect(
      await screen.findByRole('heading', { name: 'Production deep-dive' })
    ).toBeInTheDocument();
    // component node (a clickable card button) from the graph endpoint
    const claudeNode = await screen.findByRole('button', { name: /claude-code/ });
    fireEvent.click(claudeNode);

    // prod traces flowing through the selected component appear; select one
    // (also present in the prod lane, so grab the drill-down occurrence).
    const traceRows = await screen.findAllByText('prod scenario run');
    fireEvent.click(traceRows[traceRows.length - 1]);

    // multi-service waterfall (root span) + correlated logs (ERROR timeout)
    await waitFor(() => expect(screen.getAllByText('agent.run').length).toBeGreaterThan(0));
    expect(await screen.findByText('downstream model timeout after 30s')).toBeInTheDocument();
  });
});
