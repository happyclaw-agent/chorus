/**
 * Ticket #28 — clicking a Lookbook's "passing"/"failing" count should filter
 * the Look table *in place* on the Lookbooks page, not navigate away to
 * Traces (Traces has no trace_ids/example_id filter primitive, so the old
 * behavior landed on an empty Traces view — see the comment above
 * `DatasetCard` in LookbooksPage.tsx). Clicking the total "Looks" count, or
 * re-clicking the already-active filter, clears back to showing everything.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/theme-provider';
import { server } from './__mocks__/node';

function renderApp(initialPath = '/evals') {
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

function datasetsPayload() {
  return [
    {
      name: 'dataset-a',
      corpus: '/tmp/corpus',
      example_count: 3,
      examples: [
        {
          example_id: 'a1',
          dataset: 'dataset-a',
          input: 'A1 passing input',
          expected: null,
          metadata: null,
        },
        {
          example_id: 'a2',
          dataset: 'dataset-a',
          input: 'A2 failing input',
          expected: null,
          metadata: null,
        },
        {
          example_id: 'a3',
          dataset: 'dataset-a',
          input: 'A3 no-run input',
          expected: null,
          metadata: null,
        },
      ],
    },
    {
      name: 'dataset-b',
      corpus: '/tmp/corpus',
      example_count: 2,
      examples: [
        {
          example_id: 'b1',
          dataset: 'dataset-b',
          input: 'B1 failing input',
          expected: null,
          metadata: null,
        },
        {
          example_id: 'b2',
          dataset: 'dataset-b',
          input: 'B2 passing input',
          expected: null,
          metadata: null,
        },
      ],
    },
  ];
}

function runsPayload() {
  const base = {
    corpus: '/tmp/corpus',
    agent_id: 'test-agent',
    agent_version: 'v1',
    experiment_id: null,
    group_id: null,
    group_name: null,
    mode: 'prod',
    models: [],
    services: [],
    input_tokens: 10,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: 0.001,
    latency_ms: 100,
    started_at: '2026-07-19T09:00:00-04:00',
    ended_at: '2026-07-19T09:00:01-04:00',
    display_name: null,
    notes: null,
  };
  return [
    {
      ...base,
      trace_id: 'trace-a1',
      example_id: 'a1',
      input: 'A1 passing input',
      output: 'ok',
      status: 'ok',
    },
    {
      ...base,
      trace_id: 'trace-a2',
      example_id: 'a2',
      input: 'A2 failing input',
      output: 'bad',
      status: 'error',
    },
    {
      ...base,
      trace_id: 'trace-b1',
      example_id: 'b1',
      input: 'B1 failing input',
      output: 'bad',
      status: 'error',
    },
    {
      ...base,
      trace_id: 'trace-b2',
      example_id: 'b2',
      input: 'B2 passing input',
      output: 'ok',
      status: 'ok',
    },
  ];
}

function setupMocks() {
  server.use(
    http.get('*/api/datasets', () => HttpResponse.json(datasetsPayload())),
    http.get('*/api/runs', () => HttpResponse.json(runsPayload()))
  );
}

describe('Lookbooks in-place status filter', () => {
  it('clicking "passing" filters the Look table to only ok-status Looks, without navigating away', async () => {
    setupMocks();
    renderApp();

    // dataset-a is selected by default (first dataset); its full list shows first.
    expect(await screen.findByText('A1 passing input')).toBeInTheDocument();
    expect(screen.getByText('A2 failing input')).toBeInTheDocument();
    expect(screen.getByText('A3 no-run input')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lookbook-pass-count-dataset-a'));

    await waitFor(() => expect(screen.queryByText('A2 failing input')).not.toBeInTheDocument());
    expect(screen.queryByText('A3 no-run input')).not.toBeInTheDocument();
    expect(screen.getByText('A1 passing input')).toBeInTheDocument();

    // Still on Lookbooks — didn't navigate to Traces.
    expect(screen.getByRole('heading', { name: 'Evals' })).toBeInTheDocument();
    expect(screen.getByTestId('lookbook-pass-count-dataset-a')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Traces' })).not.toBeInTheDocument();
  });

  it('clicking the already-active "passing" filter again clears back to showing all Looks', async () => {
    setupMocks();
    renderApp();

    expect(await screen.findByText('A1 passing input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lookbook-pass-count-dataset-a'));
    await waitFor(() => expect(screen.queryByText('A2 failing input')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('lookbook-pass-count-dataset-a'));

    await waitFor(() => expect(screen.getByText('A2 failing input')).toBeInTheDocument());
    expect(screen.getByText('A3 no-run input')).toBeInTheDocument();
    expect(screen.getByText('A1 passing input')).toBeInTheDocument();
  });

  it('clicking the "Looks" total count clears an active filter', async () => {
    setupMocks();
    renderApp();

    expect(await screen.findByText('A1 passing input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lookbook-fail-count-dataset-a'));
    await waitFor(() => expect(screen.queryByText('A1 passing input')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('lookbook-total-count-dataset-a'));

    await waitFor(() => expect(screen.getByText('A1 passing input')).toBeInTheDocument());
    expect(screen.getByText('A2 failing input')).toBeInTheDocument();
    expect(screen.getByText('A3 no-run input')).toBeInTheDocument();
  });

  it('clicking "failing" on a different (non-selected) dataset card switches selection and applies the filter', async () => {
    setupMocks();
    renderApp();

    // dataset-a is selected by default.
    expect(await screen.findByText('A1 passing input')).toBeInTheDocument();
    expect(screen.getByText(/dataset-a — 3/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lookbook-fail-count-dataset-b'));

    // Selection switched to dataset-b...
    await waitFor(() => expect(screen.getByText(/dataset-b — 2/)).toBeInTheDocument());
    // ...and the failing filter applied: only b1 (error) shows, not b2 (ok).
    expect(screen.getByText('B1 failing input')).toBeInTheDocument();
    expect(screen.queryByText('B2 passing input')).not.toBeInTheDocument();
    // dataset-a's rows are gone entirely (different dataset selected).
    expect(screen.queryByText('A1 passing input')).not.toBeInTheDocument();
  });

  it('shows an empty-state message when a filter excludes every Look', async () => {
    setupMocks();
    server.use(
      http.get('*/api/datasets', () =>
        HttpResponse.json([
          {
            name: 'all-passing',
            corpus: '/tmp/corpus',
            example_count: 1,
            examples: [
              {
                example_id: 'p1',
                dataset: 'all-passing',
                input: 'P1 input',
                expected: null,
                metadata: null,
              },
            ],
          },
        ])
      ),
      http.get('*/api/runs', () =>
        HttpResponse.json([
          {
            trace_id: 'trace-p1',
            corpus: '/tmp/corpus',
            agent_id: 'test-agent',
            agent_version: 'v1',
            experiment_id: null,
            example_id: 'p1',
            group_id: null,
            group_name: null,
            mode: 'prod',
            input: 'P1 input',
            output: 'ok',
            status: 'ok',
            models: [],
            services: [],
            input_tokens: 10,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cost_usd: 0.001,
            latency_ms: 100,
            started_at: '2026-07-19T09:00:00-04:00',
            ended_at: '2026-07-19T09:00:01-04:00',
            display_name: null,
            notes: null,
          },
        ])
      )
    );
    renderApp();

    expect(await screen.findByText('P1 input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lookbook-fail-count-all-passing'));

    expect(await screen.findByText(/No cases with a failed source execution/i)).toBeInTheDocument();
    expect(screen.queryByText('P1 input')).not.toBeInTheDocument();
  });
});
