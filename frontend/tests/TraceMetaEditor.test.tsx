import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useTrace } from '../src/api/hooks';
import { TraceMetaEditor } from '../src/components/traces/TraceMetaEditor';
import { server } from './__mocks__/node';

function renderEditor(props: {
  traceId?: string;
  displayName?: string | null;
  notes?: string | null;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TraceMetaEditor
        traceId={props.traceId ?? 'trace-1'}
        displayName={props.displayName ?? null}
        notes={props.notes ?? null}
      />
    </QueryClientProvider>
  );
}

describe('TraceMetaEditor', () => {
  it('seeds the name and notes from the persisted values', () => {
    renderEditor({ displayName: 'Golden run', notes: 'keep as baseline' });
    expect(screen.getByTestId('trace-name-input')).toHaveValue('Golden run');
    expect(screen.getByTestId('trace-notes-input')).toHaveValue('keep as baseline');
  });

  it('saves an edited name + notes and confirms', async () => {
    renderEditor();
    // Save is disabled until something changes.
    expect(screen.getByTestId('trace-meta-save')).toBeDisabled();

    fireEvent.change(screen.getByTestId('trace-name-input'), {
      target: { value: 'Renamed trace' },
    });
    fireEvent.change(screen.getByTestId('trace-notes-input'), {
      target: { value: 'follow up on the tool error' },
    });
    expect(screen.getByTestId('trace-meta-save')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('trace-meta-save'));
    expect(await screen.findByTestId('trace-meta-saved')).toBeInTheDocument();
  });

  it('keeps the "Saved" indicator visible through the save\'s own refetch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Stateful GET/PUT pair so the refetch genuinely reflects what was just
      // saved (the default mocks are stateless and always return null,
      // which wouldn't exercise the real race: a persisted backend echoes
      // the saved value back on refetch, which is what re-fires the effect).
      let persisted = { name: null as string | null, notes: null as string | null };
      server.use(
        http.get('*/api/traces/:traceId', () =>
          HttpResponse.json({
            run: { trace_id: 'trace-1', display_name: persisted.name, notes: persisted.notes },
            spans: null,
            scores: [],
            logs: [],
          })
        ),
        http.put('*/api/traces/:traceId/meta', async ({ request }) => {
          const body = (await request.json()) as { name?: string; notes?: string };
          persisted = { name: body.name ?? null, notes: body.notes ?? null };
          return HttpResponse.json({ trace_id: 'trace-1', ...persisted });
        })
      );

      // Mirrors how TraceDetailPage actually wires this up: displayName/notes
      // come from useTrace(traceId), so a successful save's query
      // invalidation triggers a REAL refetch that re-renders TraceMetaEditor
      // with new props — this is what raced the "Saved" indicator away.
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      function Wrapper() {
        const { data } = useTrace('trace-1');
        if (!data) return null;
        return (
          <TraceMetaEditor
            traceId="trace-1"
            displayName={data.run.display_name}
            notes={data.run.notes}
          />
        );
      }
      render(
        <QueryClientProvider client={queryClient}>
          <Wrapper />
        </QueryClientProvider>
      );

      await screen.findByTestId('trace-meta-editor');
      fireEvent.change(screen.getByTestId('trace-name-input'), {
        target: { value: 'Renamed trace' },
      });
      fireEvent.click(screen.getByTestId('trace-meta-save'));

      // The mutation resolves AND the invalidated ['trace', traceId] query
      // refetches (re-seeding name/note from the "server" response) — both
      // within this act(). If `saved` were tied to that refetch, it would
      // already be gone here.
      await screen.findByTestId('trace-meta-saved');
      await waitFor(() => expect(screen.getByTestId('trace-name-input')).toHaveValue('Renamed trace'));
      expect(screen.getByTestId('trace-meta-saved')).toBeInTheDocument();

      // It still auto-dismisses eventually (not stuck forever).
      act(() => {
        vi.advanceTimersByTime(3100);
      });
      await waitFor(() =>
        expect(screen.queryByTestId('trace-meta-saved')).not.toBeInTheDocument()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a 404 as an error, not a crash', async () => {
    server.use(
      http.put('*/api/traces/:traceId/meta', () =>
        HttpResponse.json({ detail: 'trace not found' }, { status: 404 })
      )
    );
    renderEditor();
    fireEvent.change(screen.getByTestId('trace-name-input'), {
      target: { value: 'ghost' },
    });
    fireEvent.click(screen.getByTestId('trace-meta-save'));
    await waitFor(() =>
      expect(screen.getByTestId('trace-meta-error')).toHaveTextContent(/not found/i)
    );
    expect(screen.queryByTestId('trace-meta-saved')).not.toBeInTheDocument();
  });
});
