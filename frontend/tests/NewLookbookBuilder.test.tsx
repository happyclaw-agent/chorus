/**
 * Ticket #3 — New Lookbook builder: select/filter traces or a source, save
 * as a dataset with lineage. Covers the three approved entry points, all of
 * which funnel through the same per-trace POST /api/traces/:id/promote
 * primitive (no bulk backend endpoint exists, so the mock asserts N
 * individual promote calls per test):
 *   1. Create new, from selected traces (checkboxes on /traces).
 *   2. Create new, from a filtered source ("select all matching filter").
 *   3. Add to an existing Lookbook via the picker.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/theme-provider';
import { server } from './__mocks__/node';

function renderApp(initialPath = '/traces') {
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

function run(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    trace_id: 'trace-0000000000001',
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
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    cost_usd: 0.01,
    latency_ms: 1234,
    started_at: '2026-07-19T09:00:00-04:00',
    ended_at: '2026-07-19T09:00:01-04:00',
    display_name: null,
    notes: null,
    ...overrides,
  };
}

function threeRuns() {
  return [
    run({ trace_id: 'trace-0000000000001', input: 'First run input' }),
    run({ trace_id: 'trace-0000000000002', input: 'Second run input' }),
    run({ trace_id: 'trace-0000000000003', input: 'Third run input' }),
  ];
}

/** Tracks every promote call so tests can assert exactly which trace ids
 * were promoted into which dataset (no bulk endpoint — one call per trace). */
function trackPromotes() {
  const calls: { traceId: string; dataset: string | undefined }[] = [];
  server.use(
    http.post('*/api/traces/:traceId/promote', async ({ request, params }) => {
      const body = (await request.json().catch(() => ({}))) as {
        expected_output?: string;
        attributes?: { dataset?: string };
      };
      calls.push({ traceId: params.traceId as string, dataset: body.attributes?.dataset });
      return HttpResponse.json({
        case_id: `look-${params.traceId}`,
        input_text: 'input',
        actual_output: 'output',
        expected_output: body.expected_output ?? null,
        trace: { trace_id: params.traceId },
      });
    })
  );
  return calls;
}

describe('New Lookbook builder — from Traces', () => {
  it('creates a new Lookbook from selected traces (entry point 1)', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json(threeRuns())));
    const calls = trackPromotes();
    renderApp();

    expect(await screen.findByText('First run input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trace-select-trace-0000000000001'));
    fireEvent.click(screen.getByTestId('trace-select-trace-0000000000002'));

    expect(screen.getByTestId('traces-selection-count')).toHaveTextContent('2 selected');

    fireEvent.click(screen.getByTestId('traces-add-to-lookbook-button'));
    const dialog = await screen.findByRole('dialog');
    // Defaults to "+ New Lookbook…" already selected.
    fireEvent.change(within(dialog).getByTestId('add-to-lookbook-name-input'), {
      target: { value: 'regression-suite' },
    });
    fireEvent.click(within(dialog).getByTestId('add-to-lookbook-save'));

    await waitFor(() => expect(screen.getByTestId('add-to-lookbook-success')).toBeInTheDocument());
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.traceId).sort()).toEqual([
      'trace-0000000000001',
      'trace-0000000000002',
    ]);
    expect(calls.every(c => c.dataset === 'regression-suite')).toBe(true);
  });

  it('selects all traces matching the current filter and creates a new Lookbook (entry point 2)', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json(threeRuns())));
    const calls = trackPromotes();
    renderApp();

    expect(await screen.findByText('First run input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('traces-select-all'));
    expect(screen.getByTestId('traces-selection-count')).toHaveTextContent('3 selected');

    fireEvent.click(screen.getByTestId('traces-add-to-lookbook-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('add-to-lookbook-name-input'), {
      target: { value: 'all-matching' },
    });
    fireEvent.click(within(dialog).getByTestId('add-to-lookbook-save'));

    await waitFor(() => expect(screen.getByTestId('add-to-lookbook-success')).toBeInTheDocument());
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.dataset === 'all-matching')).toBe(true);
  });

  it('adds selected traces to an existing Lookbook via the picker (entry point 3)', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json(threeRuns())));
    const calls = trackPromotes();
    renderApp();

    expect(await screen.findByText('First run input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trace-select-trace-0000000000003'));

    fireEvent.click(screen.getByTestId('traces-add-to-lookbook-button'));
    const dialog = await screen.findByRole('dialog');

    // Existing datasets (from GET /api/datasets, mocked with
    // "planning-lookbook") populate the picker alongside "+ New Lookbook…".
    fireEvent.change(within(dialog).getByTestId('add-to-lookbook-target-select'), {
      target: { value: 'planning-lookbook' },
    });
    // Choosing an existing dataset hides the new-name field.
    expect(within(dialog).queryByTestId('add-to-lookbook-name-input')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId('add-to-lookbook-save'));

    await waitFor(() => expect(screen.getByTestId('add-to-lookbook-success')).toBeInTheDocument());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ traceId: 'trace-0000000000003', dataset: 'planning-lookbook' });
    expect(screen.getByTestId('add-to-lookbook-success')).toHaveTextContent('planning-lookbook');
  });

  it('surfaces a partial promote failure without losing the successful ones', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json(threeRuns())));
    server.use(
      http.post('*/api/traces/:traceId/promote', async ({ request, params }) => {
        if (params.traceId === 'trace-0000000000002') {
          return HttpResponse.json({ detail: 'trace not found' }, { status: 404 });
        }
        const body = (await request.json().catch(() => ({}))) as { expected_output?: string };
        return HttpResponse.json({
          case_id: `look-${params.traceId}`,
          input_text: 'input',
          actual_output: 'output',
          expected_output: body.expected_output ?? null,
          trace: { trace_id: params.traceId },
        });
      })
    );
    renderApp();

    expect(await screen.findByText('First run input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trace-select-trace-0000000000001'));
    fireEvent.click(screen.getByTestId('trace-select-trace-0000000000002'));

    fireEvent.click(screen.getByTestId('traces-add-to-lookbook-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('add-to-lookbook-name-input'), {
      target: { value: 'flaky-suite' },
    });
    fireEvent.click(within(dialog).getByTestId('add-to-lookbook-save'));

    expect(await screen.findByTestId('add-to-lookbook-error')).toHaveTextContent(/1 of 2 trace/);
    expect(screen.queryByTestId('add-to-lookbook-success')).not.toBeInTheDocument();
  });

  it('collapses per-trace query invalidation into a single pass after a bulk promote', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json(threeRuns())));
    const calls = trackPromotes();
    renderApp();

    expect(await screen.findByText('First run input')).toBeInTheDocument();

    // Start counting only after the initial page load has settled, so we
    // isolate refetches triggered by the bulk promote itself.
    let runsHits = 0;
    server.use(
      http.get('*/api/runs', () => {
        runsHits += 1;
        return HttpResponse.json(threeRuns());
      })
    );

    fireEvent.click(screen.getByTestId('traces-select-all'));
    expect(screen.getByTestId('traces-selection-count')).toHaveTextContent('3 selected');

    fireEvent.click(screen.getByTestId('traces-add-to-lookbook-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('add-to-lookbook-name-input'), {
      target: { value: 'bulk-suite' },
    });
    fireEvent.click(within(dialog).getByTestId('add-to-lookbook-save'));

    await waitFor(() => expect(screen.getByTestId('add-to-lookbook-success')).toBeInTheDocument());
    expect(calls).toHaveLength(3);

    // TracesPage mounts two active useRuns() observers (the filtered
    // `runsQuery` and the `limit: 500` `allRunsQuery`). A single
    // invalidation pass after the whole batch settles refetches /api/runs
    // at most once per observer. Invalidating once per successful promote
    // (the pre-fix behavior) would fire this many times per trace instead —
    // for 3 traces, well beyond the 2-observer ceiling.
    await waitFor(() => expect(runsHits).toBeGreaterThan(0));
    expect(runsHits).toBeLessThanOrEqual(2);
  });

  it('clears the selection when the filters change, so a stale selection never promotes hidden traces', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json(threeRuns())));
    renderApp();

    expect(await screen.findByText('First run input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trace-select-trace-0000000000001'));
    fireEvent.click(screen.getByTestId('trace-select-trace-0000000000002'));
    expect(screen.getByTestId('traces-selection-count')).toHaveTextContent('2 selected');

    fireEvent.change(screen.getByRole('combobox', { name: /Status/ }), {
      target: { value: 'error' },
    });

    expect(screen.queryByTestId('traces-selection-count')).not.toBeInTheDocument();
    // and once the table re-renders, every row checkbox is unchecked too —
    // not just the count banner hidden
    expect(await screen.findByTestId('trace-select-trace-0000000000001')).not.toBeChecked();
  });
});
