/**
 * Ticket #51 — a real "Run experiment..." action replacing the "does
 * nothing" state on RunwayPage (and LookbooksPage's "Runs & Gates" panel,
 * #45): RUNWAY can't spawn/manage an eval process itself, so this opens a
 * dialog that tells the user exactly how to kick one off with their harness —
 * a copyable agent prompt (primary) and the equivalent CLI command
 * (fallback) — reflecting whatever lookbook/baseline context the page
 * already has in scope.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';

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

/** navigator.clipboard is undefined in jsdom by default (mirrors OtlpCard's
 * `navigator.clipboard?.writeText` optional-chaining guard) — define a
 * mocked clipboard so the copy buttons have something real to call. */
function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe('Run experiment... (RunwayPage)', () => {
  beforeEach(() => {
    mockClipboard();
  });

  it('opens the dialog from the Runway header and reflects the real baseline in scope', async () => {
    renderApp('/runway');

    // the default mocked experiment gates v1 -> v2 (see Views.test.tsx)
    expect(await screen.findByText('Runway blocked — 1 regression vs v1')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /Run experiment/ }));
    const dialog = await screen.findByRole('dialog', { name: /Run experiment/ });

    // RunwayPage knows the baseline (v1) but not a lookbook name, so the
    // baseline is baked into the copy directly and only a lookbook input
    // is offered.
    expect(within(dialog).getByTestId('run-experiment-prompt')).toHaveTextContent(
      'Run the configured evaluation harness for the Lookbook you want to evaluate, comparing baseline v1 against a new candidate build, and export the result to Chorus.'
    );
    expect(within(dialog).getByTestId('run-experiment-cli')).toHaveTextContent(
      '<your-eval-command> --lookbook <lookbook> --baseline v1'
    );
    expect(within(dialog).queryByLabelText('Baseline version')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Lookbook name')).toBeInTheDocument();
  });

  it('fills in a typed lookbook name across both the prompt and the CLI command', async () => {
    renderApp('/runway');

    // wait for the gate (and its baseline) to load before opening the
    // dialog, so the form doesn't snapshot an empty baseline mid-fetch.
    await screen.findByText('Runway blocked — 1 regression vs v1');
    fireEvent.click(screen.getByRole('button', { name: /Run experiment/ }));
    const dialog = await screen.findByRole('dialog', { name: /Run experiment/ });

    fireEvent.change(within(dialog).getByLabelText('Lookbook name'), {
      target: { value: 'planning-lookbook' },
    });

    expect(within(dialog).getByTestId('run-experiment-prompt')).toHaveTextContent(
      'Run the configured evaluation harness for the planning-lookbook Lookbook, comparing baseline v1 against a new candidate build, and export the result to Chorus.'
    );
    expect(within(dialog).getByTestId('run-experiment-cli')).toHaveTextContent(
      '<your-eval-command> --lookbook planning-lookbook --baseline v1'
    );
  });

  it('copies the agent prompt to the clipboard and shows a transient "Copied" state', async () => {
    const writeText = mockClipboard();
    renderApp('/runway');

    fireEvent.click(await screen.findByRole('button', { name: /Run experiment/ }));
    const dialog = await screen.findByRole('dialog', { name: /Run experiment/ });

    const promptBlock = within(dialog).getByTestId('run-experiment-prompt');
    const copyButtons = within(dialog).getAllByRole('button', { name: /Copy/ });
    fireEvent.click(copyButtons[0]);

    expect(writeText).toHaveBeenCalledWith(promptBlock.textContent);
    expect(await within(dialog).findByText('Copied')).toBeInTheDocument();
    // let the transient 1.5s "Copied" state revert within the test itself,
    // rather than leaving its setTimeout dangling past teardown.
    await waitFor(() => expect(copyButtons[0]).toHaveTextContent('Copy'), { timeout: 2500 });
  });

  it('copies the CLI command to the clipboard independently of the prompt copy button', async () => {
    const writeText = mockClipboard();
    renderApp('/runway');

    fireEvent.click(await screen.findByRole('button', { name: /Run experiment/ }));
    const dialog = await screen.findByRole('dialog', { name: /Run experiment/ });

    const cliBlock = within(dialog).getByTestId('run-experiment-cli');
    const copyButtons = within(dialog).getAllByRole('button', { name: /Copy/ });
    fireEvent.click(copyButtons[1]);

    expect(writeText).toHaveBeenCalledWith(cliBlock.textContent);
    await within(dialog).findByText('Copied');
    // let the transient 1.5s "Copied" state revert within the test itself,
    // rather than leaving its setTimeout dangling past teardown.
    await waitFor(() => expect(copyButtons[1]).toHaveTextContent('Copy'), { timeout: 2500 });
  });

  it('has no experiment-running affordance on the matrix (non-A/B) view baked into the wrong context', async () => {
    renderApp('/runway');

    await screen.findByRole('option', { name: 'Coder model x module matrix' });
    const experimentSelect = screen.getByRole('combobox', { name: /Experiment/ });
    fireEvent.change(experimentSelect, { target: { value: 'coder-matrix' } });
    expect(await screen.findByText('Model matrix')).toBeInTheDocument();

    // "Run experiment..." is still available (kicking off a new experiment
    // doesn't require an existing A/B gate to be selected) but now has no
    // baseline in scope.
    fireEvent.click(screen.getByRole('button', { name: /Run experiment/ }));
    const dialog = await screen.findByRole('dialog', { name: /Run experiment/ });
    expect(within(dialog).getByLabelText('Baseline version')).toBeInTheDocument();
  });
});

const planningExperiment = {
  experiment_id: 'exp-1',
  name: 'model swap v1 vs v2',
  description: '',
  baseline: 'v1',
  candidate: 'v2',
  trace_ids: ['abc123def4567890', 'cand123def4567890'],
  run_count: 4,
};

function datasetsPayload() {
  return [
    {
      name: 'planning-lookbook',
      corpus: '/tmp/corpus',
      example_count: 1,
      examples: [
        {
          example_id: 'look-001',
          dataset: 'planning-lookbook',
          input: 'What if spend +15%?',
          expected: null,
          metadata: null,
        },
      ],
    },
  ];
}

describe('Run experiment... (LookbooksPage Runs & Gates panel)', () => {
  beforeEach(() => {
    mockClipboard();
    server.use(http.get('*/api/datasets', () => HttpResponse.json(datasetsPayload())));
    server.use(
      http.get('*/api/experiments', ({ request }) => {
        const url = new URL(request.url);
        const lookbook = url.searchParams.get('lookbook');
        return HttpResponse.json(lookbook === 'planning-lookbook' ? [planningExperiment] : []);
      })
    );
  });

  it('opens the dialog pre-filled with the Lookbook already being viewed, with no baseline assumed', async () => {
    renderApp('/lookbooks');

    // the button lives on LookbooksPage next to the panel (not inside it —
    // RunsAndGatesPanel itself is untouched, #45's component), but both are
    // scoped to the same selected Lookbook.
    await screen.findByTestId('runs-and-gates-panel');
    fireEvent.click(screen.getByRole('button', { name: /Run experiment/ }));

    const dialog = await screen.findByRole('dialog', { name: /Run experiment/ });
    // the lookbook is already known (the dataset being viewed) so no
    // lookbook input is offered, but no single baseline can be assumed
    // across this Lookbook's whole run history, so that input remains.
    expect(within(dialog).queryByLabelText('Lookbook name')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Baseline version')).toBeInTheDocument();

    expect(within(dialog).getByTestId('run-experiment-prompt')).toHaveTextContent(
      'Run the configured evaluation harness for the planning-lookbook Lookbook, comparing its current baseline against a new candidate build, and export the result to Chorus.'
    );
    expect(within(dialog).getByTestId('run-experiment-cli')).toHaveTextContent(
      '<your-eval-command> --lookbook planning-lookbook --baseline <baseline>'
    );
  });

  it('fills in a typed baseline across both the prompt and the CLI command', async () => {
    renderApp('/lookbooks');

    await screen.findByTestId('runs-and-gates-panel');
    fireEvent.click(screen.getByRole('button', { name: /Run experiment/ }));
    const dialog = await screen.findByRole('dialog', { name: /Run experiment/ });

    fireEvent.change(within(dialog).getByLabelText('Baseline version'), {
      target: { value: 'v2' },
    });

    expect(within(dialog).getByTestId('run-experiment-prompt')).toHaveTextContent(
      'Run the configured evaluation harness for the planning-lookbook Lookbook, comparing baseline v2 against a new candidate build, and export the result to Chorus.'
    );
    expect(within(dialog).getByTestId('run-experiment-cli')).toHaveTextContent(
      '<your-eval-command> --lookbook planning-lookbook --baseline v2'
    );
  });
});
