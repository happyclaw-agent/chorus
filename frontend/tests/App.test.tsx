import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/theme-provider';

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

describe('Chorus app shell', () => {
  it('renders the shell and redirects to the Traces view', async () => {
    renderApp();

    expect(screen.getAllByText('CHORUS').length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { name: 'Traces' })).toBeInTheDocument();
    // The complete Runway information architecture remains available.
    for (const label of ['Agent Groups', 'Traces', 'Lookbooks', 'Runway', 'Monitor', 'Sources']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
    // a run row from the mocked API shows up
    expect(await screen.findByText('abc123de')).toBeInTheDocument();
  });

  it('renders the trace detail waterfall', async () => {
    renderApp('/traces/abc123def4567890');

    expect(await screen.findByRole('heading', { name: /Trace abc123de/ })).toBeInTheDocument();
    expect(await screen.findByText('agent.run')).toBeInTheDocument();
    expect(screen.getByText('Promote to Look')).toBeInTheDocument();
    expect(await screen.findByText('accuracy')).toBeInTheDocument();
  });
});

describe('Promote to Look (real)', () => {
  it('promotes a trace and shows the confirmation with a Lookbooks link', async () => {
    renderApp('/traces/abc123def4567890');

    // header action opens the confirm dialog
    fireEvent.click(await screen.findByRole('button', { name: 'Promote to Look' }));
    const dialog = await screen.findByRole('dialog');

    // confirm/submit inside the dialog calls the real endpoint
    fireEvent.click(within(dialog).getByRole('button', { name: /Promote to Look/ }));

    expect(await screen.findByText(/Promoted to Look/)).toBeInTheDocument();
    expect(screen.getByText('look-001')).toBeInTheDocument();
    expect(screen.getByText('promoted-looks')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View in Lookbooks/ })).toBeInTheDocument();
  });
});
