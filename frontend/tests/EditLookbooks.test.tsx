/**
 * Ticket #4 — edit Lookbooks in the UI: rename a dataset, edit a Look's
 * expected value, remove a Look. Each flow drives the real dialog/inline
 * controls added to LookbooksPage against stateful mock handlers (mirroring
 * how TraceMetaEditor.test.tsx exercises a save-then-refetch round trip),
 * so these assert the actual persisted value reappears, not just that a
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

interface MockExample {
  example_id: string;
  dataset: string;
  input: string;
  expected: string | null;
  metadata: Record<string, unknown> | null;
}

function example1(dataset = 'planning-lookbook'): MockExample {
  return {
    example_id: 'look-001',
    dataset,
    input: 'What if spend +15%?',
    expected: 'Grounded scenario result.',
    metadata: {
      source_trace: 'abc123def4567890',
      promoted_by: 'jj',
      graders: ['ground_truth_tests'],
      assertions: 2,
    },
  };
}

function example2(dataset = 'planning-lookbook'): MockExample {
  return {
    example_id: 'look-002',
    dataset,
    input: 'Forecast Q4 revenue.',
    expected: null,
    metadata: null,
  };
}

function datasetsPayload(name: string, examples: MockExample[]) {
  return [{ name, corpus: '/tmp/corpus', example_count: examples.length, examples }];
}

describe('Rename a Lookbook', () => {
  it('renames the dataset in place and the header/card follow the new name', async () => {
    let name = 'planning-lookbook';
    server.use(
      http.get('*/api/datasets', () =>
        HttpResponse.json(datasetsPayload(name, [example1(name), example2(name)]))
      ),
      http.put('*/api/datasets/:name', async ({ request }) => {
        const body = (await request.json()) as { name: string };
        name = body.name;
        return HttpResponse.json({ name, example_count: 2 });
      })
    );
    renderApp();

    expect(await screen.findByText('planning-lookbook')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lookbook-rename-button'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('lookbook-rename-input'), {
      target: { value: 'renamed-lookbook' },
    });
    fireEvent.click(within(dialog).getByTestId('lookbook-rename-save'));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // both the dataset card and the table header follow the new name
    expect(await screen.findAllByText(/renamed-lookbook/)).not.toHaveLength(0);
    expect(screen.queryByText('planning-lookbook')).not.toBeInTheDocument();
  });

  it('surfaces a read-only-corpus 400 as an inline dialog error, not a crash', async () => {
    server.use(
      http.put('*/api/datasets/:name', () =>
        HttpResponse.json(
          {
            detail: "dataset 'planning-lookbook' lives in a read-only corpus and can't be renamed",
          },
          { status: 400 }
        )
      )
    );
    renderApp();

    fireEvent.click(await screen.findByTestId('lookbook-rename-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('lookbook-rename-input'), {
      target: { value: 'renamed-lookbook' },
    });
    fireEvent.click(within(dialog).getByTestId('lookbook-rename-save'));

    expect(await screen.findByTestId('lookbook-rename-error')).toHaveTextContent(
      /read-only corpus/
    );
    // the dialog stays open and the dataset keeps its original name
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe("Edit a Look's expected value", () => {
  it('saves an edited expected value and preserves the metadata alongside it', async () => {
    const examples = [example1(), example2()];
    server.use(
      http.get('*/api/datasets', () =>
        HttpResponse.json(datasetsPayload('planning-lookbook', examples))
      ),
      http.put('*/api/datasets/:name/examples/:exampleId', async ({ request, params }) => {
        const body = (await request.json()) as { expected?: string };
        const ex = examples.find(e => e.example_id === params.exampleId);
        if (!ex) return HttpResponse.json({ detail: 'not found' }, { status: 404 });
        ex.expected = body.expected ?? null;
        return HttpResponse.json(ex);
      })
    );
    renderApp();

    fireEvent.click(await screen.findByText('What if spend +15%?'));
    fireEvent.click(await screen.findByTestId('look-edit-expected-button-look-001'));

    const input = screen.getByTestId('look-expected-input-look-001');
    fireEvent.change(input, { target: { value: 'Updated ground truth.' } });
    fireEvent.click(screen.getByTestId('look-expected-save-look-001'));

    // Wait for the textarea to be replaced by the read-only view first — a
    // plain findByText('Updated ground truth.') would false-positive against
    // the still-live textarea's own value while the save is in flight.
    await waitFor(() => {
      expect(screen.queryByTestId('look-expected-input-look-001')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Updated ground truth.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Grounded scenario result.')).not.toBeInTheDocument();
    // metadata (promoted_by, graders) survives the edit — it's still on the row
    expect(screen.getByText(/promoted by jj/)).toBeInTheDocument();
  });

  it('cancel discards an in-progress edit without saving', async () => {
    renderApp();

    fireEvent.click(await screen.findByText('What if spend +15%?'));
    fireEvent.click(await screen.findByTestId('look-edit-expected-button-look-001'));
    fireEvent.change(screen.getByTestId('look-expected-input-look-001'), {
      target: { value: 'this should not persist' },
    });
    fireEvent.click(screen.getByTestId('look-expected-cancel-look-001'));

    expect(await screen.findByText('Grounded scenario result.')).toBeInTheDocument();
    expect(screen.queryByText('this should not persist')).not.toBeInTheDocument();
  });
});

describe('Remove a Look', () => {
  it('removes only the confirmed Look; the rest of the dataset is untouched', async () => {
    let examples = [example1(), example2()];
    server.use(
      http.get('*/api/datasets', () =>
        HttpResponse.json(datasetsPayload('planning-lookbook', examples))
      ),
      http.delete('*/api/datasets/:name/examples/:exampleId', ({ params }) => {
        examples = examples.filter(e => e.example_id !== params.exampleId);
        return HttpResponse.json({ removed: params.exampleId, dataset: 'planning-lookbook' });
      })
    );
    renderApp();

    expect(await screen.findByText('What if spend +15%?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('look-remove-button-look-001'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('look-remove-confirm-look-001'));

    await waitFor(() => expect(screen.queryByText('What if spend +15%?')).not.toBeInTheDocument());
    expect(screen.getByText('Forecast Q4 revenue.')).toBeInTheDocument();
  });

  it('surfaces a remove failure as an inline dialog error', async () => {
    server.use(
      http.delete('*/api/datasets/:name/examples/:exampleId', () =>
        HttpResponse.json({ detail: 'dataset or example not found' }, { status: 404 })
      )
    );
    renderApp();

    fireEvent.click(await screen.findByTestId('look-remove-button-look-001'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('look-remove-confirm-look-001'));

    expect(await screen.findByTestId('look-remove-error-look-001')).toHaveTextContent(/not found/);
    // still present — the failed remove didn't optimistically drop it
    expect(screen.getByText('What if spend +15%?')).toBeInTheDocument();
  });
});
