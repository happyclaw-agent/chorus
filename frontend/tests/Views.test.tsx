import { fireEvent, render, screen } from '@testing-library/react';
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
    expect(await screen.findByText('Add to eval suite')).toBeInTheDocument();
    expect(screen.getByText('Open in Traces')).toBeInTheDocument();
    expect(screen.queryByText('Replay locally in coding session')).not.toBeInTheDocument();
  });
});

describe('Runs view', () => {
  it('shows example rows and drills into their data, feedback, cost, and trace', async () => {
    renderApp('/runs');

    expect(await screen.findByRole('heading', { name: 'Runs' })).toBeInTheDocument();
    expect(await screen.findByText('181')).toBeInTheDocument();
    expect(await screen.findByText('fitness-tired-01')).toBeInTheDocument();
    expect(screen.getByText('workout-plan-01')).toBeInTheDocument();
    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getByText('$0.01000')).toBeInTheDocument();
    expect(screen.getByTestId('eval-run-status')).toHaveTextContent('Needs attention');

    fireEvent.click(screen.getByText('fitness-tired-01'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('I am too tired');
    expect(screen.getByRole('dialog')).toHaveTextContent('Supportive accountability');
    expect(screen.getByRole('dialog')).toHaveTextContent('The response was not empathetic.');
    expect(screen.getByRole('link', { name: /Open execution trace/ })).toHaveAttribute(
      'href',
      '/traces/abc123def4567890?root_span_id=exported-root'
    );
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

describe('Evals view', () => {
  it('renders eval suites and cases with lineage', async () => {
    renderApp('/evals');

    expect(await screen.findByRole('heading', { name: 'Evals' })).toBeInTheDocument();
    expect(await screen.findByText('Registered evals')).toBeInTheDocument();
    expect(screen.getByText('3 evaluator definitions · 2 exercised by the latest run')).toBeInTheDocument();
    expect(screen.getByText('Duplicate Response')).toBeInTheDocument();
    expect(screen.getByText('Not in latest run')).toBeInTheDocument();
    expect(await screen.findByText('planning-lookbook')).toBeInTheDocument();
    expect(await screen.findByText(/promoted by jj/)).toBeInTheDocument();
    expect(screen.getByText('New eval suite')).toBeInTheDocument();
  });

  it('expands an example to show input and expected', async () => {
    renderApp('/evals');

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
