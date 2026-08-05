import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/theme-provider';
import { server } from './__mocks__/node';

/**
 * Ticket #37 — every "Errors" stat in the UI should drill into Traces
 * filtered to status=error. Covers the two previously-static global stats
 * (AppShell top bar, Monitor's global "Error rate" tile), Monitor's
 * per-agent Errors column (which requires TracesPage to understand an
 * `agent_id` URL param — new in this ticket), and the round-trip of that
 * param on TracesPage in isolation.
 */
function renderApp(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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

const run = {
  trace_id: 'abc123def4567890',
  corpus: '/tmp/corpus',
  agent_id: 'test-agent',
  agent_version: 'v1',
  experiment_id: null,
  example_id: null,
  group_id: null,
  group_name: null,
  mode: 'prod',
  input: 'What is the forecast?',
  output: 'The forecast is sunny.',
  status: 'ok',
  models: [],
  services: ['claude-code'],
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cost_usd: 0.01,
  latency_ms: 1234,
  started_at: '2026-07-19T09:00:00-04:00',
  ended_at: '2026-07-19T09:00:01-04:00',
  display_name: null,
  notes: null,
};

const otherAgentRun = {
  ...run,
  trace_id: 'def456abc7891234',
  agent_id: 'other-agent',
  status: 'error',
};

/** Two agents, one with errors, so both the global and per-agent stats have
 * something non-zero to click on. */
function useTwoAgentStats() {
  server.use(
    http.get('*/api/runs', () => HttpResponse.json([run, otherAgentRun])),
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
          {
            agent_id: 'other-agent',
            runs: 1,
            errors: 2,
            cost_usd: 0.02,
            input_tokens: 200,
            output_tokens: 60,
            p50_ms: 2000,
            p90_ms: 2000,
            p95_ms: 2000,
          },
        ],
        totals: { runs: 2, cost_usd: 0.03, input_tokens: 300, output_tokens: 110 },
      })
    )
  );
}

describe('AppShell top-bar errors stat', () => {
  it('clicking "N errors" navigates to Traces filtered to status=error (global, no scoping)', async () => {
    useTwoAgentStats();
    renderApp('/monitor');

    const errorsStat = await screen.findByTestId('header-errors-stat');
    expect(errorsStat).toHaveTextContent('2 errors');
    fireEvent.click(errorsStat);

    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();
    const sourceFilter = screen.getByTestId('traces-source-filter') as HTMLSelectElement;
    expect(sourceFilter.value).toBe('');
    const statusSelect = screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement;
    await waitFor(() => expect(statusSelect.value).toBe('error'));
  });
});

describe("Monitor's global Error rate stat", () => {
  it('clicking the Error rate tile navigates to Traces filtered to status=error', async () => {
    useTwoAgentStats();
    renderApp('/monitor');

    const errorRateStat = await screen.findByTestId('monitor-error-rate-stat');
    fireEvent.click(errorRateStat);

    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();
    const sourceFilter = screen.getByTestId('traces-source-filter') as HTMLSelectElement;
    expect(sourceFilter.value).toBe('');
    const statusSelect = screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement;
    await waitFor(() => expect(statusSelect.value).toBe('error'));
  });
});

describe("Monitor's per-agent Errors column", () => {
  it("clicking an agent's Errors cell navigates to Traces filtered by that agent and status=error", async () => {
    useTwoAgentStats();
    renderApp('/monitor');

    const agentErrorsStat = await screen.findByTestId('monitor-agent-errors-other-agent');
    fireEvent.click(agentErrorsStat);

    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();
    const sourceFilter = screen.getByTestId('traces-source-filter') as HTMLSelectElement;
    await waitFor(() => expect(sourceFilter.value).toBe('agent:other-agent'));
    const statusSelect = screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement;
    await waitFor(() => expect(statusSelect.value).toBe('error'));
  });

  it('does not navigate anywhere else (not the group detail / agent page)', async () => {
    useTwoAgentStats();
    renderApp('/monitor');

    const agentErrorsStat = await screen.findByTestId('monitor-agent-errors-test-agent');
    expect(agentErrorsStat).toHaveTextContent('0');
  });
});

describe('TracesPage agent_id URL param (focused, no Monitor involved)', () => {
  it('visiting /traces?agent_id=X directly pre-selects agent X in the source filter', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json([run, otherAgentRun])));
    renderApp('/traces?agent_id=other-agent');

    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();
    const sourceFilter = screen.getByTestId('traces-source-filter') as HTMLSelectElement;
    await waitFor(() => expect(sourceFilter.value).toBe('agent:other-agent'));
    // No status scoping unless the link says so.
    const statusSelect = screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement;
    expect(statusSelect.value).toBe('');
  });

  it('visiting /traces?agent_id=X&status=error pre-selects both agent and status', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json([run, otherAgentRun])));
    renderApp('/traces?agent_id=other-agent&status=error');

    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();
    const sourceFilter = screen.getByTestId('traces-source-filter') as HTMLSelectElement;
    await waitFor(() => expect(sourceFilter.value).toBe('agent:other-agent'));
    const statusSelect = screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement;
    await waitFor(() => expect(statusSelect.value).toBe('error'));
  });
});
