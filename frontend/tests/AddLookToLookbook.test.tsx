/**
 * Ticket #45 (part 1) — "Add Look..." on the Lookbooks page itself: an
 * inline trace picker/search modal, scoped to the CURRENTLY-SELECTED
 * dataset, with no "new vs existing" target picker step (the target is
 * already known — the dataset the user is viewing). Every promoted Look
 * still traces back to a real trace_id via the same
 * POST /api/traces/:id/promote primitive AddToLookbookDialog uses.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    run({ trace_id: 'trace-0000000000002', input: 'Second run input', status: 'error' }),
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

describe('Add Look — from the Lookbooks page', () => {
  it('promotes selected traces directly into the currently-selected Lookbook, with no target picker', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json(threeRuns())));
    const calls = trackPromotes();
    renderApp();

    // Default mock /api/datasets returns "planning-lookbook" — selected by
    // default (LookbooksPage falls back to datasets[0]).
    expect(await screen.findByText('planning-lookbook')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lookbooks-add-look-button'));
    const dialog = await screen.findByRole('dialog');

    // No "new vs existing" target picker anywhere in this dialog — the
    // target dataset (planning-lookbook) is already known.
    expect(within(dialog).queryByTestId('add-to-lookbook-target-select')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/New eval suite/)).not.toBeInTheDocument();
    expect(within(dialog).getAllByText(/planning-lookbook/).length).toBeGreaterThan(0);

    expect(await within(dialog).findByText('First run input')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId('add-look-select-trace-0000000000001'));
    fireEvent.click(within(dialog).getByTestId('add-look-select-trace-0000000000003'));

    fireEvent.click(within(dialog).getByTestId('add-look-save'));

    await waitFor(() => expect(screen.getByTestId('add-look-success')).toBeInTheDocument());
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.traceId).sort()).toEqual([
      'trace-0000000000001',
      'trace-0000000000003',
    ]);
    expect(calls.every(c => c.dataset === 'planning-lookbook')).toBe(true);
  });

  it('filters the trace picker by search text and by status, same filtering conventions as Traces', async () => {
    server.use(
      http.get('*/api/runs', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status');
        const runs = threeRuns();
        return HttpResponse.json(status ? runs.filter(r => r.status === status) : runs);
      })
    );
    renderApp();

    expect(await screen.findByText('planning-lookbook')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lookbooks-add-look-button'));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('First run input')).toBeInTheDocument();
    expect(within(dialog).getByText('Second run input')).toBeInTheDocument();
    expect(within(dialog).getByText('Third run input')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByTestId('add-look-search'), {
      target: { value: 'Second' },
    });
    expect(within(dialog).queryByText('First run input')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Second run input')).toBeInTheDocument();
    expect(within(dialog).queryByText('Third run input')).not.toBeInTheDocument();

    // Clear the search, then filter by status instead. The status filter is
    // server-driven (a new useRuns() query), so re-assert with findBy/waitFor
    // rather than a synchronous getBy/queryBy.
    fireEvent.change(within(dialog).getByTestId('add-look-search'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Status/ }), {
      target: { value: 'error' },
    });
    expect(await within(dialog).findByText('Second run input')).toBeInTheDocument();
    expect(within(dialog).queryByText('First run input')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Third run input')).not.toBeInTheDocument();
  });

  it('clears hidden selections when filters change so the saved count stays honest', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json(threeRuns())));
    const calls = trackPromotes();
    renderApp();

    expect(await screen.findByText('planning-lookbook')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lookbooks-add-look-button'));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(await within(dialog).findByTestId('add-look-select-trace-0000000000001'));
    expect(within(dialog).getByText('1 selected')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByTestId('add-look-search'), {
      target: { value: 'Second' },
    });
    expect(within(dialog).getByText('0 selected')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId('add-look-select-trace-0000000000002'));
    fireEvent.click(within(dialog).getByTestId('add-look-save'));

    await waitFor(() => expect(screen.getByTestId('add-look-success')).toBeInTheDocument());
    expect(calls).toEqual([
      { traceId: 'trace-0000000000002', dataset: 'planning-lookbook' },
    ]);
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

    expect(await screen.findByText('planning-lookbook')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lookbooks-add-look-button'));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('First run input')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId('add-look-select-trace-0000000000001'));
    fireEvent.click(within(dialog).getByTestId('add-look-select-trace-0000000000002'));
    fireEvent.click(within(dialog).getByTestId('add-look-save'));

    expect(await within(dialog).findByTestId('add-look-error')).toHaveTextContent(/1 of 2 trace/);
    expect(within(dialog).queryByTestId('add-look-success')).not.toBeInTheDocument();
  });
});
