import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/theme-provider';
import { server } from './__mocks__/node';

function renderApp(initialPath = '/') {
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
  run_count: 3,
  errors: 1,
  cost_usd: 3.02,
  first_seen: '2026-07-19T08:55:24-04:00',
  last_seen: '2026-07-19T13:55:24-04:00',
  modes: ['ci', 'dev', 'prod'],
  services: ['claude-code', 'llm-gateway'],
};

describe('top-bar honest agent/group/run counts', () => {
  it('shows the real group count alongside agents and runs (N-group state)', async () => {
    // Two groups present — the bar reflects the actual structure.
    server.use(
      http.get('*/api/groups', () =>
        HttpResponse.json([group, { ...group, group_id: 'na-planning', group_name: 'NA Planning' }])
      )
    );
    renderApp();

    const groups = await screen.findByTestId('header-groups');
    expect(groups).toHaveTextContent('2 groups');
    expect(screen.getByTestId('header-agents')).toHaveTextContent('1 agent');
    expect(screen.getByTestId('header-runs')).toHaveTextContent('1 runs');
    // The live pill must keep its stable testid.
    expect(screen.getByTestId('live-indicator')).toBeInTheDocument();
  });

  it('states "0 groups" honestly when none exist (0-group state)', async () => {
    // Groups are optional: with no groups the bar must not imply any structure.
    server.use(http.get('*/api/groups', () => HttpResponse.json([])));
    renderApp();

    const groups = await screen.findByTestId('header-groups');
    expect(groups).toHaveTextContent('0 groups');
    // Agents and runs still render coherently.
    expect(screen.getByTestId('header-agents')).toHaveTextContent('1 agent');
    expect(screen.getByTestId('header-runs')).toHaveTextContent('1 runs');
  });
});
