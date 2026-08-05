/**
 * Ticket #9 — trace-level system-lineage graph: extends the existing
 * group-level component graph (ComponentGraph.tsx, exercised standalone in
 * DeepDive.test.tsx) down to a single trace. Covers the reused component
 * rendering a trace-shaped fixture directly, and the "System lineage" panel
 * wired into TraceDetailPage via GET /api/traces/:id/graph.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ComponentGraph } from '../src/components/groups/ComponentGraph';
import { ThemeProvider } from '../src/theme/theme-provider';
import type { TraceComponentGraph } from '../src/api/types';
import { server } from './__mocks__/node';

const traceGraph: TraceComponentGraph = {
  trace_id: 'abc123def4567890',
  nodes: [
    { id: 'claude-code', span_count: 9, error_count: 0, trace_count: 1, operations: ['datarobot_agent'] },
    { id: 'datarobot-mcp', span_count: 1, error_count: 0, trace_count: 1, operations: ['tool.vdb_query'] },
    { id: 'daria-deployment', span_count: 1, error_count: 0, trace_count: 1, operations: ['agent.plan'] },
    { id: 'llm-gateway', span_count: 1, error_count: 1, trace_count: 1, operations: ['chat.completion'] },
  ],
  edges: [
    { source: 'claude-code', target: 'datarobot-mcp', calls: 1 },
    { source: 'datarobot-mcp', target: 'daria-deployment', calls: 1 },
    { source: 'daria-deployment', target: 'llm-gateway', calls: 2 },
  ],
};

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

describe('ComponentGraph rendering a trace-shaped graph (no `group` field)', () => {
  it('renders one node per service touched by the trace', () => {
    const onSelect = vi.fn();
    render(<ComponentGraph graph={traceGraph} selected={null} onSelect={onSelect} />);

    expect(screen.getByText('claude-code')).toBeInTheDocument();
    expect(screen.getByText('datarobot-mcp')).toBeInTheDocument();
    expect(screen.getByText('daria-deployment')).toBeInTheDocument();
    expect(screen.getByText('llm-gateway')).toBeInTheDocument();
    expect(screen.getByText('1 err')).toBeInTheDocument();

    fireEvent.click(screen.getByText('llm-gateway'));
    expect(onSelect).toHaveBeenCalledWith('llm-gateway');
  });
});

describe('System lineage panel on TraceDetailPage', () => {
  it('fetches GET /api/traces/:id/graph and renders the multi-service lineage graph', async () => {
    server.use(
      http.get('*/api/traces/:traceId/graph', ({ params }) =>
        HttpResponse.json({ ...traceGraph, trace_id: params.traceId })
      )
    );
    renderApp('/traces/abc123def4567890');

    expect(await screen.findByText(/System lineage/)).toBeInTheDocument();
    expect(await screen.findByText('datarobot-mcp')).toBeInTheDocument();
    expect(screen.getByText('daria-deployment')).toBeInTheDocument();

    // clicking a node highlights it locally (no navigation away from the page)
    const mcpNode = screen.getByRole('button', { name: /datarobot-mcp/ });
    fireEvent.click(mcpNode);
    expect(mcpNode).toHaveAttribute('aria-pressed', 'true');
  });

  it('omits the panel when the trace touches no services (empty graph)', async () => {
    server.use(
      http.get('*/api/traces/:traceId/graph', ({ params }) =>
        HttpResponse.json({ trace_id: params.traceId, nodes: [], edges: [] })
      )
    );
    renderApp('/traces/abc123def4567890');

    // the trace still loads (span waterfall panel); the lineage panel shows
    // a loading skeleton briefly, then renders nothing once the empty graph
    // resolves (no services to show a lineage graph for).
    expect(await screen.findByText('Span waterfall')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/System lineage/)).not.toBeInTheDocument());
  });
});
