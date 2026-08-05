import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { api } from '../src/api/client';
import { ThemeProvider } from '../src/theme/theme-provider';
import { server } from './__mocks__/node';
import { getBaseUrl } from '../src/lib/utils';

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
    for (const label of ['Agent Groups', 'Traces', 'Evals', 'Runs', 'Monitor', 'Sources']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
    // a run row from the mocked API shows up
    expect(await screen.findByText('abc123de')).toBeInTheDocument();
  });

  it('renders the trace detail waterfall', async () => {
    renderApp('/traces/abc123def4567890');

    expect(await screen.findByRole('heading', { name: /Trace abc123de/ })).toBeInTheDocument();
    expect(await screen.findByText('agent.run')).toBeInTheDocument();
    expect(screen.getByText('Promote to eval case')).toBeInTheDocument();
    expect(await screen.findByText('accuracy')).toBeInTheDocument();
  });
});

describe('Promote to eval case', () => {
  it('promotes a trace and shows the confirmation with an Evals link', async () => {
    renderApp('/traces/abc123def4567890');

    // header action opens the confirm dialog
    fireEvent.click(await screen.findByRole('button', { name: 'Promote to eval case' }));
    const dialog = await screen.findByRole('dialog');

    // confirm/submit inside the dialog calls the real endpoint
    fireEvent.click(within(dialog).getByRole('button', { name: /Promote to eval case/ }));

    expect(await screen.findByText(/Promoted eval case/)).toBeInTheDocument();
    expect(screen.getByText('look-001')).toBeInTheDocument();
    expect(screen.getByText('promoted-evals')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View in Evals/ })).toBeInTheDocument();
  });
});

describe('Protected Chorus sessions', () => {
  it('prompts once for a token after a 401 and retries with bearer auth', async () => {
    window.sessionStorage.removeItem('chorus.apiToken');
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('session-secret');
    const authorizations: Array<string | null> = [];
    server.use(
      http.get('*/api/eval-runs', ({ request }) => {
        const authorization = request.headers.get('authorization');
        authorizations.push(authorization);
        return authorization === 'Bearer session-secret'
          ? HttpResponse.json([])
          : HttpResponse.json({ detail: 'unauthorized' }, { status: 401 });
      })
    );

    await expect(api.getEvalRuns()).resolves.toEqual([]);

    expect(prompt).toHaveBeenCalledOnce();
    expect(authorizations).toEqual([null, 'Bearer session-secret']);
    expect(window.sessionStorage.getItem('chorus.apiToken')).toBe('session-secret');
    prompt.mockRestore();
    window.sessionStorage.removeItem('chorus.apiToken');
  });
});

describe('Corpus-wide run loading', () => {
  it('retrieves every backend page instead of stopping at the newest 500 runs', async () => {
    const offsets: number[] = [];
    server.use(
      http.get('*/api/runs', ({ request }) => {
        const params = new URL(request.url).searchParams;
        const offset = Number(params.get('offset') ?? 0);
        offsets.push(offset);
        const count = offset === 0 ? 1000 : 1;
        return HttpResponse.json(
          Array.from({ length: count }, (_, index) => ({
            trace_id: `trace-${offset + index}`,
          }))
        );
      })
    );

    await expect(api.getAllRuns()).resolves.toHaveLength(1001);
    expect(offsets).toEqual([0, 1000]);
  });
});

describe('Application base paths', () => {
  it('keeps the full notebook proxy prefix without overriding an injected base path', () => {
    expect(getBaseUrl('/notebook-sessions/session-1/ports/5173/traces', undefined)).toBe(
      '/notebook-sessions/session-1/ports/5173/'
    );
    expect(getBaseUrl('/notebook-sessions/session-1/ports/5173/traces', '/chorus/')).toBe(
      '/chorus/'
    );
  });
});
