/**
 * Ticket #45 (part 2) — a "Runs & Gates" panel on LookbooksPage's
 * selected-dataset view, listing past experiments run against it (via
 * GET /api/experiments?lookbook=<dataset>, a derived — not stored —
 * lookbook<->experiment link, see fastapi_server/app/store.py). Each row
 * also shows its dr-evals gate verdict (GET /api/experiments/:id/gate).
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
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
      name: 'planning-lookbook',
      corpus: '/tmp/corpus',
      example_count: 1,
      examples: [
        {
          example_id: 'look-001',
          dataset: 'planning-lookbook',
          input: 'What if spend +15%?',
          expected: null,
          metadata: null,
        },
      ],
    },
    {
      name: 'empty-lookbook',
      corpus: '/tmp/corpus',
      example_count: 0,
      examples: [],
    },
  ];
}

const planningExperiment = {
  experiment_id: 'exp-1',
  name: 'model swap v1 vs v2',
  description: '',
  baseline: 'v1',
  candidate: 'v2',
  trace_ids: ['abc123def4567890', 'cand123def4567890'],
  run_count: 4,
};

function mockExperimentsFilteredByLookbook() {
  server.use(
    http.get('*/api/experiments', ({ request }) => {
      const url = new URL(request.url);
      const lookbook = url.searchParams.get('lookbook');
      if (lookbook === 'planning-lookbook') {
        return HttpResponse.json([planningExperiment]);
      }
      return HttpResponse.json([]);
    })
  );
}

describe('Runs & Gates panel', () => {
  it("shows the Lookbook's run/gate history: name, baseline vs candidate, run count, and gate verdict", async () => {
    server.use(http.get('*/api/datasets', () => HttpResponse.json(datasetsPayload())));
    mockExperimentsFilteredByLookbook();
    server.use(
      http.get('*/api/experiments/:experimentId/gate', () =>
        HttpResponse.json({
          experiment_id: 'exp-1',
          experiment: planningExperiment,
          baseline: 'v1',
          candidate: 'v2',
          policy: { numeric_fail_below: 0.5, numeric_max_drop: 0.1, max_regressions: 0 },
          status: 'pass',
          passed: true,
          summary: { examples: 2, regressions: 0, warnings: 0, evaluators: [] },
          rows: [],
        })
      )
    );
    renderApp();

    expect(await screen.findByText('planning-lookbook')).toBeInTheDocument();
    const panel = await screen.findByTestId('runs-and-gates-panel');
    const row = await within(panel).findByTestId('runs-and-gates-row-exp-1');
    expect(within(row).getByText(/model swap v1 vs v2/)).toBeInTheDocument();
    expect(within(row).getByText('v1 → v2')).toBeInTheDocument();
    expect(within(row).getByText('4')).toBeInTheDocument();
    expect(await within(row).findByTestId('runs-and-gates-gate-exp-1')).toHaveTextContent(/pass/);
  });

  it('shows no experiments for a Lookbook with no run history', async () => {
    server.use(http.get('*/api/datasets', () => HttpResponse.json(datasetsPayload())));
    mockExperimentsFilteredByLookbook();
    renderApp();

    expect(await screen.findByText('planning-lookbook')).toBeInTheDocument();
    // Switch to the dataset with no linked experiments.
    fireEvent.click(screen.getByTestId('lookbook-total-count-empty-lookbook'));

    const panel = await screen.findByTestId('runs-and-gates-panel');
    expect(await within(panel).findByTestId('runs-and-gates-empty')).toBeInTheDocument();
    expect(within(panel).queryByTestId('runs-and-gates-row-exp-1')).not.toBeInTheDocument();
  });
});
