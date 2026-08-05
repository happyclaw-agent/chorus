/**
 * Ticket #33 — editable Agent Groups: hide a group, add/remove members. Each
 * flow drives the real dialog/picker controls added to GroupsPage and
 * GroupDetailPage against stateful mock handlers (mirroring how
 * EditLookbooks.test.tsx exercises rename/edit/remove-Look round trips), so
 * these assert the actually-persisted state reappears, not just that a
 * request fired.
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

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    group_id: 'emea-planning',
    group_name: 'EMEA Planning',
    run_count: 3,
    errors: 1,
    cost_usd: 3.02,
    first_seen: '2026-07-19T08:55:24-04:00',
    last_seen: '2026-07-19T13:55:24-04:00',
    modes: ['dev', 'ci', 'prod'],
    services: ['claude-code', 'llm-gateway'],
    agent_ids: ['claude-code'],
    ...overrides,
  };
}

const emptyLanes = { dev: [], ci: [], prod: [] };

const statsPayload = {
  agents: [
    {
      agent_id: 'claude-code',
      runs: 2,
      errors: 0,
      cost_usd: 0.01,
      input_tokens: 100,
      output_tokens: 50,
      p50_ms: 100,
      p90_ms: 100,
      p95_ms: 100,
    },
    {
      agent_id: 'daria',
      runs: 2,
      errors: 1,
      cost_usd: 0.02,
      input_tokens: 200,
      output_tokens: 80,
      p50_ms: 200,
      p90_ms: 200,
      p95_ms: 200,
    },
  ],
  totals: { runs: 4, cost_usd: 0.03, input_tokens: 300, output_tokens: 130 },
};

describe('Group routing', () => {
  it('opens an OTLP group whose identifier contains a path separator', async () => {
    const group = makeGroup({ group_id: 'team/agent', group_name: 'Team Agent' });
    server.use(
      http.get('*/api/groups', () => HttpResponse.json([group])),
      http.get('*/api/group-by-id', () =>
        HttpResponse.json({ group, lanes: emptyLanes })
      ),
      http.get('*/api/group-by-id/graph', () =>
        HttpResponse.json({ group, nodes: [], edges: [] })
      ),
      http.get('*/api/stats', () => HttpResponse.json(statsPayload))
    );
    renderApp('/groups');

    const card = (await screen.findByText('Team Agent')).closest('[role="button"]');
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    expect(await screen.findByRole('heading', { name: 'Team Agent' })).toBeInTheDocument();
  });
});

describe('Hide an Agent Group', () => {
  it('hides the group via the confirm dialog and it disappears from the list', async () => {
    let hidden = false;
    server.use(
      http.get('*/api/groups', () => HttpResponse.json(hidden ? [] : [makeGroup()])),
      http.delete('*/api/groups/:groupId', () => {
        hidden = true;
        return HttpResponse.json({ group_id: 'emea-planning', hidden: true });
      })
    );
    renderApp('/groups');

    expect(await screen.findByText('EMEA Planning')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('group-delete-button-emea-planning'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('group-delete-confirm-emea-planning'));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('EMEA Planning')).not.toBeInTheDocument());
  });

  it('surfaces a hide failure as an inline dialog error', async () => {
    server.use(
      http.get('*/api/groups', () => HttpResponse.json([makeGroup()])),
      http.delete('*/api/groups/:groupId', () =>
        HttpResponse.json({ detail: 'group not found' }, { status: 404 })
      )
    );
    renderApp('/groups');

    fireEvent.click(await screen.findByTestId('group-delete-button-emea-planning'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('group-delete-confirm-emea-planning'));

    expect(await screen.findByTestId('group-delete-error-emea-planning')).toHaveTextContent(
      /not found/
    );
    // still present — the failed hide didn't optimistically drop it (the
    // group card AND the dialog's own description both say the name, hence
    // getAllByText).
    expect(screen.getAllByText('EMEA Planning').length).toBeGreaterThan(0);
  });
});

describe('Manage group members', () => {
  it('adding an agent via the picker shows it in the Members panel and the rollup', async () => {
    let agentIds = ['claude-code'];
    let runCount = 3;
    server.use(
      http.get('*/api/groups/:groupId', () =>
        HttpResponse.json({
          group: makeGroup({ agent_ids: agentIds, run_count: runCount }),
          lanes: emptyLanes,
        })
      ),
      http.get('*/api/stats', () => HttpResponse.json(statsPayload)),
      http.post('*/api/groups/:groupId/agents', async ({ request }) => {
        const body = (await request.json()) as { agent_id: string };
        if (!agentIds.includes(body.agent_id)) {
          agentIds = [...agentIds, body.agent_id];
          runCount += 2; // daria contributes 2 runs in the stats fixture
        }
        return HttpResponse.json({
          group: makeGroup({ agent_ids: agentIds, run_count: runCount }),
          lanes: emptyLanes,
        });
      })
    );
    renderApp('/groups/emea-planning');

    expect(await screen.findByTestId('group-member-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('group-member-daria')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('group-add-agent-input'), {
      target: { value: 'daria' },
    });
    // onMouseDown (not onClick) so the selection lands before input blur
    // closes the panel — fireEvent.click alone never triggers it.
    fireEvent.mouseDown(await screen.findByTestId('group-add-agent-option-daria'));

    expect(await screen.findByTestId('group-member-daria')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('group-detail-stat-runs')).toHaveTextContent('5')
    );
  });

  it('removing a member removes it from the panel', async () => {
    let agentIds = ['claude-code', 'daria'];
    server.use(
      http.get('*/api/groups/:groupId', () =>
        HttpResponse.json({
          group: makeGroup({ agent_ids: agentIds, run_count: 4 }),
          lanes: emptyLanes,
        })
      ),
      http.get('*/api/stats', () => HttpResponse.json(statsPayload)),
      http.delete('*/api/groups/:groupId/agents/:agentId', ({ params }) => {
        agentIds = agentIds.filter(id => id !== params.agentId);
        return HttpResponse.json({
          group: makeGroup({ agent_ids: agentIds, run_count: 2 }),
          lanes: emptyLanes,
        });
      })
    );
    renderApp('/groups/emea-planning');

    expect(await screen.findByTestId('group-member-daria')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('group-member-remove-button-daria'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('group-member-remove-confirm-daria'));

    await waitFor(() => expect(screen.queryByTestId('group-member-daria')).not.toBeInTheDocument());
    expect(screen.getByTestId('group-member-claude-code')).toBeInTheDocument();
  });

  it('does not clip the add-agent dropdown inside an overflow-hidden ancestor (regression for #40)', async () => {
    server.use(
      http.get('*/api/groups/:groupId', () =>
        HttpResponse.json({ group: makeGroup({ agent_ids: ['claude-code'] }), lanes: emptyLanes })
      ),
      http.get('*/api/stats', () => HttpResponse.json(statsPayload))
    );
    renderApp('/groups/emea-planning');

    fireEvent.focus(await screen.findByTestId('group-add-agent-input'));
    await screen.findByTestId('group-add-agent-list');

    // JSDOM doesn't implement real CSS overflow-clipping, so "the dropdown
    // list is in the document" would pass even with the bug present (it did,
    // before this fix). The honest regression check is structural: walk
    // every ancestor from the dropdown up to <body> and assert none carries
    // an overflow-hidden class — before the fix, GroupDetailPage's Members
    // Panel wrapper carried exactly this class and clipped the popup
    // invisible in a real browser.
    let node: HTMLElement | null = screen.getByTestId('group-add-agent-list');
    const clippingAncestors: string[] = [];
    while (node && node !== document.body) {
      if (node.classList.contains('overflow-hidden')) {
        clippingAncestors.push(node.className);
      }
      node = node.parentElement;
    }
    expect(clippingAncestors).toEqual([]);
  });

  it('focusing the input with an empty query lists every non-member agent', async () => {
    server.use(
      http.get('*/api/groups/:groupId', () =>
        HttpResponse.json({ group: makeGroup({ agent_ids: ['claude-code'] }), lanes: emptyLanes })
      ),
      http.get('*/api/stats', () => HttpResponse.json(statsPayload))
    );
    renderApp('/groups/emea-planning');

    fireEvent.focus(await screen.findByTestId('group-add-agent-input'));

    expect(await screen.findByTestId('group-add-agent-option-daria')).toBeInTheDocument();
  });

  it('does not offer to create an agent whose typed name exactly matches an existing candidate', async () => {
    server.use(
      http.get('*/api/groups/:groupId', () =>
        HttpResponse.json({ group: makeGroup({ agent_ids: ['claude-code'] }), lanes: emptyLanes })
      ),
      http.get('*/api/stats', () => HttpResponse.json(statsPayload))
    );
    renderApp('/groups/emea-planning');

    fireEvent.change(await screen.findByTestId('group-add-agent-input'), {
      target: { value: 'daria' },
    });

    await screen.findByTestId('group-add-agent-option-daria');
    expect(screen.queryByTestId('group-add-agent-create-option')).not.toBeInTheDocument();
  });

  it('does not offer agents that have no traced runs', async () => {
    server.use(
      http.get('*/api/groups/:groupId', () =>
        HttpResponse.json({ group: makeGroup({ agent_ids: ['claude-code'] }), lanes: emptyLanes })
      ),
      http.get('*/api/stats', () => HttpResponse.json(statsPayload))
    );
    renderApp('/groups/emea-planning');

    fireEvent.change(await screen.findByTestId('group-add-agent-input'), {
      target: { value: 'brand-new-agent' },
    });

    expect(screen.queryByTestId('group-add-agent-option-brand-new-agent')).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-add-agent-create-option')).not.toBeInTheDocument();
    expect(screen.getByText('No matching agents')).toBeInTheDocument();
  });
});
