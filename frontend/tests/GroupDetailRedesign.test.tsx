/**
 * Ticket #44 — Group Detail page: promote from any lane (drop the dead
 * "Replay locally" stub), redesign the cramped 3-column dev/ci/prod layout
 * into a single filtered wide view, and surface related eval suites derived
 * from source-trace lineage.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/theme-provider';
import { server } from './__mocks__/node';

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

const group = {
  group_id: 'emea-planning',
  group_name: 'EMEA Planning',
  run_count: 4,
  errors: 1,
  cost_usd: 3.02,
  first_seen: '2026-07-19T08:55:24-04:00',
  last_seen: '2026-07-19T13:55:24-04:00',
  modes: ['ci', 'dev', 'prod'],
  services: ['claude-code', 'llm-gateway'],
  agent_ids: ['test-agent'],
};

const baseRun = {
  trace_id: 'abc123def4567890',
  corpus: '/tmp/corpus',
  agent_id: 'test-agent',
  agent_version: 'v1',
  experiment_id: null,
  example_id: null,
  group_id: 'emea-planning',
  group_name: 'EMEA Planning',
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
};

function groupDetailHandler() {
  return http.get('*/api/groups/:groupId', ({ params }) => {
    if (params.groupId !== 'emea-planning') {
      return HttpResponse.json({ detail: 'not found' }, { status: 404 });
    }
    return HttpResponse.json({
      group,
      lanes: {
        dev: [{ ...baseRun, trace_id: 'dev0000000000001', mode: 'dev', input: 'iterate on tool' }],
        ci: [{ ...baseRun, trace_id: 'ci00000000000001', mode: 'ci', input: 'ci regression run' }],
        prod: [
          { ...baseRun, trace_id: 'prod000000000001', mode: 'prod', input: 'prod scenario run' },
          {
            ...baseRun,
            trace_id: 'prod000000000002',
            mode: 'prod',
            status: 'error',
            input: 'prod scenario that errored',
          },
        ],
      },
    });
  });
}

function emptyDatasetsHandler() {
  return http.get('*/api/datasets', () => HttpResponse.json([]));
}

describe('Promote from any lane', () => {
  it('a dev-lane row shows a working Promote menu with no "Replay locally" option anywhere', async () => {
    server.use(groupDetailHandler(), emptyDatasetsHandler());
    renderApp('/groups/emea-planning');

    expect(await screen.findByRole('heading', { name: 'EMEA Planning' })).toBeInTheDocument();

    // Switch to the dev lane.
    fireEvent.click(screen.getByTestId('lane-tab-dev'));
    expect(await screen.findByText('iterate on tool')).toBeInTheDocument();

    const devRow = screen.getByTestId('lane-run-dev0000000000001');
    const promoteButton = within(devRow).getByRole('button', { name: /Promote/ });
    fireEvent.click(promoteButton);

    expect(await screen.findByText('Add to eval suite')).toBeInTheDocument();
    expect(screen.getByText('Open in Traces')).toBeInTheDocument();
    expect(screen.queryByText('Replay locally in coding session')).not.toBeInTheDocument();

    // Not present anywhere else on the page either (other lanes' menus are
    // closed, but the option string shouldn't exist in the DOM at all).
    expect(screen.queryByText(/Replay locally/)).not.toBeInTheDocument();
  });
});

describe('Redesigned trace view', () => {
  it('shows lane counts as tabs and switches the single wide list between lanes without dropping runs', async () => {
    server.use(groupDetailHandler(), emptyDatasetsHandler());
    renderApp('/groups/emea-planning');

    expect(await screen.findByRole('heading', { name: 'EMEA Planning' })).toBeInTheDocument();

    // Counts are visible on the tabs regardless of which lane is selected.
    expect(await screen.findByTestId('lane-tab-dev')).toHaveTextContent('1');
    expect(screen.getByTestId('lane-tab-ci')).toHaveTextContent('1');
    expect(screen.getByTestId('lane-tab-prod')).toHaveTextContent('2');

    // Only one lane's runs are shown at a time, in a single wide list.
    fireEvent.click(screen.getByTestId('lane-tab-dev'));
    expect(await screen.findByText('iterate on tool')).toBeInTheDocument();
    expect(screen.queryByText('ci regression run')).not.toBeInTheDocument();
    expect(screen.queryByText('prod scenario run')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lane-tab-ci'));
    expect(await screen.findByText('ci regression run')).toBeInTheDocument();
    expect(screen.queryByText('iterate on tool')).not.toBeInTheDocument();
    expect(screen.queryByText('prod scenario run')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lane-tab-prod'));
    expect(await screen.findByText('prod scenario run')).toBeInTheDocument();
    expect(screen.getByText('prod scenario that errored')).toBeInTheDocument();
    expect(screen.queryByText('iterate on tool')).not.toBeInTheDocument();
    expect(screen.queryByText('ci regression run')).not.toBeInTheDocument();

    // Total run count across all lanes is preserved (1 + 1 + 2 = 4), matching
    // the group header's run_count stat — nothing silently dropped.
    expect(screen.getByTestId('group-detail-stat-runs')).toHaveTextContent('4');
  });
});

describe('Related eval suites', () => {
  it('shows a dataset containing a case promoted from a group run', async () => {
    server.use(
      groupDetailHandler(),
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
                metadata: { source_trace: 'prod000000000001' },
              },
              {
                example_id: 'look-002',
                dataset: 'planning-lookbook',
                input: 'Forecast Q4 revenue.',
                expected: null,
                metadata: { source_trace: 'another-trace' },
              },
            ],
          },
          {
            name: 'unrelated-lookbook',
            corpus: '/tmp/corpus',
            example_count: 1,
            examples: [
              {
                example_id: 'look-100',
                dataset: 'unrelated-lookbook',
                input: 'unrelated',
                expected: null,
                metadata: { source_trace: 'xyz' },
              },
            ],
          },
        ])
      )
    );
    renderApp('/groups/emea-planning');

    const section = await screen.findByTestId('related-lookbooks-panel');
    const card = await within(section).findByTestId('related-lookbook-planning-lookbook');
    expect(within(card).getByText('planning-lookbook')).toBeInTheDocument();
    expect(card).toHaveTextContent('2');
    expect(
      within(section).queryByTestId('related-lookbook-unrelated-lookbook')
    ).not.toBeInTheDocument();
  });

  it('shows an empty state when no case came from a group run', async () => {
    server.use(groupDetailHandler(), emptyDatasetsHandler());
    renderApp('/groups/emea-planning');

    const section = await screen.findByTestId('related-lookbooks-panel');
    await waitFor(() =>
      expect(within(section).getByTestId('related-lookbooks-empty')).toBeInTheDocument()
    );
  });
});
