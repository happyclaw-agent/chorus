import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/theme-provider';

/**
 * Ticket #2 — clickable drill-downs across views. Covers the Groups/
 * GroupDetail run/error stat tiles, which navigate into a filtered Traces
 * view. (Lookbooks' own pass/fail/total stats used to drill down into Traces
 * too, but ticket #28 changed that: Traces has no trace_ids/example_id filter
 * primitive, so that link usually landed on an empty result. Lookbooks' stats
 * now filter the Look table in place instead — see LookbooksFilter.test.tsx.)
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

describe('Groups list drill-down', () => {
  it('clicking the Runs stat navigates to Traces pre-filtered to that group (not the group detail page)', async () => {
    renderApp('/groups');

    const runsStat = await screen.findByTestId('group-stat-runs');
    fireEvent.click(runsStat);

    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();
    // Didn't fall through to the card's own onClick (group detail page).
    expect(screen.queryByText('Production deep-dive')).not.toBeInTheDocument();

    const sourceFilter = screen.getByTestId('traces-source-filter') as HTMLSelectElement;
    await waitFor(() => expect(sourceFilter.value).toBe('group:emea-planning'));

    // Runs stat doesn't also constrain status.
    const statusSelect = screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement;
    expect(statusSelect.value).toBe('');
  });

  it('clicking the Errors stat navigates to Traces filtered by group and status=error', async () => {
    renderApp('/groups');

    const errorsStat = await screen.findByTestId('group-stat-errors');
    fireEvent.click(errorsStat);

    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();

    const sourceFilter = screen.getByTestId('traces-source-filter') as HTMLSelectElement;
    await waitFor(() => expect(sourceFilter.value).toBe('group:emea-planning'));

    const statusSelect = screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement;
    await waitFor(() => expect(statusSelect.value).toBe('error'));
  });
});

describe('Group detail drill-down', () => {
  it('clicking the header Runs stat navigates to Traces pre-filtered to the group', async () => {
    renderApp('/groups/emea-planning');

    const runsStat = await screen.findByTestId('group-detail-stat-runs');
    fireEvent.click(runsStat);

    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();

    const sourceFilter = screen.getByTestId('traces-source-filter') as HTMLSelectElement;
    await waitFor(() => expect(sourceFilter.value).toBe('group:emea-planning'));

    const statusSelect = screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement;
    expect(statusSelect.value).toBe('');
  });

  it('clicking the header Errors stat navigates to Traces filtered by group and status=error', async () => {
    renderApp('/groups/emea-planning');

    const errorsStat = await screen.findByTestId('group-detail-stat-errors');
    fireEvent.click(errorsStat);

    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();

    const sourceFilter = screen.getByTestId('traces-source-filter') as HTMLSelectElement;
    await waitFor(() => expect(sourceFilter.value).toBe('group:emea-planning'));

    const statusSelect = screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement;
    await waitFor(() => expect(statusSelect.value).toBe('error'));
  });
});
