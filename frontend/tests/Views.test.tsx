import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/theme-provider';

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

describe('Agent Groups view', () => {
  it('lists group cards with mode and service chips', async () => {
    renderApp('/groups');

    expect(await screen.findByRole('heading', { name: 'Agent Groups' })).toBeInTheDocument();
    expect(await screen.findByText('EMEA Planning')).toBeInTheDocument();
    // mode chips (dev/ci/prod) and a service chip render
    expect(screen.getAllByText('dev').length).toBeGreaterThan(0);
    expect(screen.getAllByText('llm-gateway').length).toBeGreaterThan(0);
  });

  it('renders the lifecycle lane tabs (with counts) and opens the promote menu on the default (prod) lane', async () => {
    renderApp('/groups/emea-planning');

    // header + all three lane tabs, each showing a count (#44 redesign — a
    // single wide list filtered by lane, rather than three cramped columns).
    expect(await screen.findByRole('heading', { name: 'EMEA Planning' })).toBeInTheDocument();
    expect(await screen.findByText('Development')).toBeInTheDocument();
    expect(screen.getByText('Integration (CI)')).toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument();
    // prod-lane placeholder for the next builder
    expect(screen.getByText('Production deep-dive')).toBeInTheDocument();

    // promote menu opens on a promotable run (defaults to the prod lane) —
    // "Replay locally in coding session" was a non-functional stub, removed
    // per #44; only the two real actions remain.
    const promoteButtons = screen.getAllByRole('button', { name: /Promote/ });
    expect(promoteButtons.length).toBeGreaterThan(0);
    fireEvent.click(promoteButtons[0]);
    expect(await screen.findByText('Add to CI suite (→ Look)')).toBeInTheDocument();
    expect(screen.getByText('Open in Traces')).toBeInTheDocument();
    expect(screen.queryByText('Replay locally in coding session')).not.toBeInTheDocument();
  });
});

describe('Runway view', () => {
  it('shows the gate banner with regression count and the verdict grid', async () => {
    renderApp('/runway');

    expect(await screen.findByRole('heading', { name: 'Runway' })).toBeInTheDocument();
    // look-001 regresses (error + ground truth flip); look-002 passes
    expect(await screen.findByText('Runway blocked — 1 regression vs v1')).toBeInTheDocument();
    expect(screen.getByText('look-001')).toBeInTheDocument();
    expect(screen.getByText('look-002')).toBeInTheDocument();
  });

  it('re-verdicts live: raising the max-regressions tolerance clears the gate', async () => {
    renderApp('/runway');

    // starts blocked at the default policy (max_regressions 0)
    expect(await screen.findByText('Runway blocked — 1 regression vs v1')).toBeInTheDocument();
    expect(screen.getByTestId('gate-pill')).toHaveTextContent('blocked');

    // the tolerance control renders and drives the gate query
    expect(screen.getByLabelText('Max regressions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Increase max regressions' }));

    // gate re-verdicts to pass and the banner clears
    expect(
      await screen.findByText('Cleared for takeoff — candidate v2 ready to promote')
    ).toBeInTheDocument();
    expect(screen.getByTestId('gate-pill')).toHaveTextContent('passed');
  });

  it('opens the side-by-side comparison drawer on row click', async () => {
    renderApp('/runway');

    fireEvent.click(await screen.findByText('look-001'));
    const drawer = await screen.findByRole('dialog', { name: /look-001/ });
    expect(drawer).toBeInTheDocument();
    expect(screen.getByText('Open baseline trace')).toBeInTheDocument();
    expect(screen.getByText('Open candidate trace')).toBeInTheDocument();
    // both waterfalls load the mocked trace's root span
    await waitFor(() => expect(screen.getAllByText('agent.run').length).toBe(2));
  });

  it('switches to the matrix grid for an experiment with no A/B arms', async () => {
    renderApp('/runway');

    // default is the A/B gate (exp-1); wait for options, then pick the verdict matrix
    await screen.findByRole('option', { name: 'Reviewer model verdicts vs ground truth' });
    const experimentSelect = screen.getByRole('combobox', { name: /Experiment/ });
    fireEvent.change(experimentSelect, { target: { value: 'reviewer-matrix' } });

    // mode indicator flips to the matrix mode
    expect(await screen.findByText('Model matrix')).toBeInTheDocument();

    // verdict accuracy cells render (opus 100% correct, gpt-oss 20%)
    expect(await screen.findByText('100%')).toBeInTheDocument();
    expect(await screen.findByText('20%')).toBeInTheDocument();
    // per-cell correct/wrong breakdown for the low-accuracy gpt-oss reviewer
    expect(screen.getByText('1✓/4✗')).toBeInTheDocument();

    // axis + score dropdowns appear (Experiment + Rows/Cols/Score = 4 selects)
    expect(screen.getByRole('combobox', { name: /Rows/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Cols/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Score/ })).toBeInTheDocument();

    // model column names are shortened (anthropic. namespace stripped)
    expect(screen.getByText('claude-opus-4-8')).toBeInTheDocument();
  });

  it('renders a numeric matrix with value_mean cells', async () => {
    renderApp('/runway');

    await screen.findByRole('option', { name: 'Latency by model x module' });
    const experimentSelect = screen.getByRole('combobox', { name: /Experiment/ });
    fireEvent.change(experimentSelect, { target: { value: 'latency-matrix' } });

    expect(await screen.findByText('Model matrix')).toBeInTheDocument();
    // value_mean is shown formatted to a few sig figs
    expect(await screen.findByText('12.34')).toBeInTheDocument();
    expect(screen.getByText('4.2')).toBeInTheDocument();
    expect(screen.getByText('8.8')).toBeInTheDocument();
    // avg × opus has no run -> an empty cell is rendered
    expect(screen.getAllByTestId('matrix-cell-empty').length).toBeGreaterThan(0);
  });

  it('shows a bool pass/fail matrix with ✓/✕ for single runs and empty cells', async () => {
    renderApp('/runway');

    await screen.findByRole('option', { name: 'Coder model x module matrix' });
    const experimentSelect = screen.getByRole('combobox', { name: /Experiment/ });
    fireEvent.change(experimentSelect, { target: { value: 'coder-matrix' } });

    expect(await screen.findByText('Model matrix')).toBeInTheDocument();
    // binning × opus is a single passing run -> ✓; deepseek 0/2 -> 0%
    expect((await screen.findAllByText('✓')).length).toBeGreaterThan(0);
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('0/2 pass')).toBeInTheDocument();
    // avg × opus has no run -> an empty cell is rendered
    expect(screen.getAllByTestId('matrix-cell-empty').length).toBeGreaterThan(0);
  });
});

describe('Sources view', () => {
  it('lists loaded corpora and the standard OTLP endpoint', async () => {
    renderApp('/sources');

    expect(await screen.findByRole('heading', { name: 'Sources' })).toBeInTheDocument();

    // corpora rows render (dir + inbox)
    expect(await screen.findByText('/tmp/demo-corpus')).toBeInTheDocument();
    expect(screen.getByText('/Users/test/.chorus/inbox')).toBeInTheDocument();

    // OTLP endpoint URL is shown and ends in the receiver path
    expect(screen.getByTestId('otlp-endpoint')).toHaveTextContent('/v1/traces');

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('imports a canonical OTLP file from the source card', async () => {
    renderApp('/sources');

    fireEvent.change(await screen.findByLabelText('OTLP file or directory'), {
      target: { value: '/tmp/flex.otlp.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByTestId('sources-result')).toHaveTextContent(
      'Imported /tmp/flex.otlp.json'
    );
  });
});

describe('Lookbooks view', () => {
  it('renders dataset cards and the Looks table with lineage', async () => {
    renderApp('/lookbooks');

    expect(await screen.findByRole('heading', { name: 'Lookbooks' })).toBeInTheDocument();
    expect(await screen.findByText('planning-lookbook')).toBeInTheDocument();
    expect(await screen.findByText(/promoted by jj/)).toBeInTheDocument();
    expect(screen.getByText('New Lookbook')).toBeInTheDocument();
  });

  it('expands an example to show input and expected', async () => {
    renderApp('/lookbooks');

    fireEvent.click(await screen.findByText('What if spend +15%?'));
    expect(await screen.findByText('Grounded scenario result.')).toBeInTheDocument();
  });
});

describe('Monitor view', () => {
  it('renders stat tiles, charts, and the per-agent table', async () => {
    renderApp('/monitor');

    expect(await screen.findByRole('heading', { name: 'Monitor' })).toBeInTheDocument();
    expect(await screen.findByText('Total runs')).toBeInTheDocument();
    expect(screen.getByText('Error rate')).toBeInTheDocument();
    expect(await screen.findByText('Runs over time')).toBeInTheDocument();
    expect(screen.getByText('Latency percentiles')).toBeInTheDocument();
    expect(screen.getByText('Cost per agent')).toBeInTheDocument();
    expect(await screen.findByText('Per-agent breakdown')).toBeInTheDocument();
    expect(screen.getAllByText('test-agent').length).toBeGreaterThan(0);
  });
});
