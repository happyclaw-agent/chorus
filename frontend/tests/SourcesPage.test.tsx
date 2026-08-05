import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SourcesPage } from '../src/pages/SourcesPage';
import { server } from './__mocks__/node';

function renderSources() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SourcesPage />
    </QueryClientProvider>
  );
}

describe('SourcesPage', () => {
  it('shows the standard OTLP receiver and canonical trace corpus', async () => {
    renderSources();

    expect(await screen.findByRole('heading', { name: 'Sources' })).toBeInTheDocument();
    expect(screen.getByText('Live OTLP receiver')).toBeInTheDocument();
    expect(screen.getByTestId('otlp-endpoint')).toHaveTextContent('/v1/traces');
    expect(screen.getByText('Import standard OTLP')).toBeInTheDocument();
    expect(await screen.findByText('/tmp/demo-corpus')).toBeInTheDocument();
    expect(screen.getByText('/Users/test/.chorus/inbox')).toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
  });

  it('includes the configured application prefix in the OTLP receiver URL', async () => {
    const previousEnvironment = window.ENV;
    try {
      window.ENV = { BASE_PATH: '/chorus/' };
      renderSources();

      expect(await screen.findByTestId('otlp-endpoint')).toHaveTextContent(
        `${window.location.origin}/chorus/v1/traces`
      );
    } finally {
      window.ENV = previousEnvironment;
    }
  });

  it('imports an OTLP file through the canonical corpus endpoint', async () => {
    renderSources();

    fireEvent.change(screen.getByLabelText('OTLP file or directory'), {
      target: { value: '/tmp/flex.otlp.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByTestId('sources-result')).toHaveTextContent(
      'Imported /tmp/flex.otlp.json'
    );
  });

  it('shows an import error returned by Chorus', async () => {
    server.use(
      http.post('*/api/corpora', () =>
        HttpResponse.json({ detail: 'Path is not readable' }, { status: 400 })
      )
    );
    renderSources();

    fireEvent.change(screen.getByLabelText('OTLP file or directory'), {
      target: { value: '/missing/traces.otlp.jsonl' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByTestId('sources-result')).toHaveTextContent('Path is not readable');
  });
});
