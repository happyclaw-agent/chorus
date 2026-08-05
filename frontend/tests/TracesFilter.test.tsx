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

const groupRun = {
  trace_id: 'group00000000001',
  corpus: '/tmp/corpus',
  agent_id: 'emea-planner',
  agent_version: 'v1',
  experiment_id: null,
  example_id: null,
  group_id: 'emea-planning',
  group_name: 'EMEA Planning',
  mode: 'prod',
  input: 'Group-scoped forecast run',
  output: 'ok',
  status: 'ok',
  models: [],
  services: ['claude-code'],
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: null,
  cache_creation_input_tokens: null,
  cost_usd: 0.01,
  latency_ms: 100,
  started_at: '2026-07-19T09:00:00-04:00',
  ended_at: '2026-07-19T09:00:01-04:00',
};

const baseRun = {
  ...groupRun,
  trace_id: 'abc123def4567890',
  agent_id: 'test-agent',
  group_id: null,
  group_name: null,
  input: 'What is the forecast?',
};

describe('Traces unified Agent/Group filter', () => {
  it('lists both agents and groups, with groups in a distinct section', async () => {
    renderApp('/traces');

    const filter = await screen.findByTestId('traces-source-filter');

    // individual agent from the runs feed (options load once the queries resolve)
    expect(await within(filter).findByRole('option', { name: 'test-agent' })).toBeInTheDocument();
    // group from the useGroups hook
    const groupOption = await within(filter).findByRole('option', { name: 'EMEA Planning' });
    expect(groupOption).toBeInTheDocument();

    // groups are visually distinguished under their own "Groups" section header,
    // agents under an "Agents" section header
    const agentsSection = filter.querySelector('optgroup[label="Agents"]');
    const groupsSection = filter.querySelector('optgroup[label="Groups"]');
    expect(agentsSection).not.toBeNull();
    expect(groupsSection).not.toBeNull();
    expect(groupsSection).toContainElement(groupOption);
  });

  it('filters traces by group_id when a group is selected', async () => {
    // /api/runs now honors agent_id / group_id so we can prove the right param is sent
    server.use(
      http.get('*/api/runs', ({ request }) => {
        const url = new URL(request.url);
        const groupId = url.searchParams.get('group_id');
        const agentId = url.searchParams.get('agent_id');
        if (groupId === 'emea-planning') return HttpResponse.json([groupRun]);
        if (agentId) return HttpResponse.json([]);
        // unfiltered feed (drives the option lists) returns both agents' runs
        return HttpResponse.json([baseRun, groupRun]);
      })
    );

    renderApp('/traces');

    // unfiltered table shows the non-group run
    expect(await screen.findByText('What is the forecast?')).toBeInTheDocument();

    const filter = await screen.findByTestId('traces-source-filter');
    fireEvent.change(filter, { target: { value: 'group:emea-planning' } });

    // the group-filtered request drives the table to the group-scoped run only
    expect(await screen.findByText('Group-scoped forecast run')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('What is the forecast?')).not.toBeInTheDocument()
    );
  });

  it('paginates on the server so runs beyond the first page stay accessible', async () => {
    server.use(
      http.get('*/api/run-count', () => HttpResponse.json({ count: 101 })),
      http.get('*/api/runs', ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get('offset') ?? 0);
        return HttpResponse.json(offset === 100 ? [groupRun] : [baseRun]);
      })
    );

    renderApp('/traces');

    expect(await screen.findByText('What is the forecast?')).toBeInTheDocument();
    expect(screen.getAllByText('1–1 of 101 runs')).not.toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Older' }));

    expect(await screen.findByText('Group-scoped forecast run')).toBeInTheDocument();
    expect(screen.getByText('101–101 of 101')).toBeInTheDocument();
  });

  it('sends trace search to the server instead of filtering only the current page', async () => {
    let search = '';
    server.use(
      http.get('*/api/runs', ({ request }) => {
        search = new URL(request.url).searchParams.get('search') ?? '';
        return HttpResponse.json([baseRun]);
      })
    );

    renderApp('/traces');
    await screen.findByText('What is the forecast?');

    fireEvent.change(screen.getByPlaceholderText('Filter by input, output, or trace id…'), {
      target: { value: 'forecast' },
    });

    await waitFor(() => expect(search).toBe('forecast'));
  });
});

describe('Traces list custom name + Version column removal', () => {
  it('shows a custom display_name as the primary text when set', async () => {
    server.use(
      http.get('*/api/runs', () =>
        HttpResponse.json([{ ...baseRun, display_name: 'My Custom Name' }])
      )
    );

    renderApp('/traces');

    expect(await screen.findByText('My Custom Name')).toBeInTheDocument();
    // raw input is still present (secondary text), not replaced
    expect(screen.getByText('What is the forecast?')).toBeInTheDocument();
  });

  it('falls back to the raw input when display_name is not set (regression guard)', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json([baseRun])));

    renderApp('/traces');

    expect(await screen.findByText('What is the forecast?')).toBeInTheDocument();
  });

  it('no longer renders a Version column in the Traces table', async () => {
    server.use(http.get('*/api/runs', () => HttpResponse.json([baseRun])));

    renderApp('/traces');

    await screen.findByText('What is the forecast?');
    expect(screen.queryByText('Version')).not.toBeInTheDocument();
  });
});
