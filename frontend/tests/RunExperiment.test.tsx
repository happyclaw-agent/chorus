import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe('Run eval', () => {
  beforeEach(() => {
    mockClipboard();
  });

  it('opens from Runs and builds a provider-neutral command', async () => {
    renderApp('/runs');

    fireEvent.click(await screen.findByRole('button', { name: /Run eval/ }));
    const dialog = await screen.findByRole('dialog', { name: /Run eval/ });

    fireEvent.change(within(dialog).getByLabelText('Eval suite name'), {
      target: { value: 'flex-regression' },
    });
    fireEvent.change(within(dialog).getByLabelText('Baseline version'), {
      target: { value: 'v2' },
    });

    expect(within(dialog).getByTestId('run-experiment-prompt')).toHaveTextContent(
      'Run the configured evaluation harness for the flex-regression eval suite, comparing baseline v2 against a new candidate build, and export the result to Chorus.'
    );
    expect(within(dialog).getByTestId('run-experiment-cli')).toHaveTextContent(
      '<your-eval-command> --eval-suite flex-regression --baseline v2'
    );
  });

  it('copies the agent prompt to the clipboard', async () => {
    const writeText = mockClipboard();
    renderApp('/runs');

    fireEvent.click(await screen.findByRole('button', { name: /Run eval/ }));
    const dialog = await screen.findByRole('dialog', { name: /Run eval/ });
    const prompt = within(dialog).getByTestId('run-experiment-prompt');
    const copyButton = within(dialog).getAllByRole('button', { name: /Copy/ })[0];
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith(prompt.textContent);
    expect(await within(dialog).findByText('Copied')).toBeInTheDocument();
    await waitFor(() => expect(copyButton).toHaveTextContent('Copy'), { timeout: 2500 });
  });

  it('uses the selected eval suite when opened from Evals', async () => {
    renderApp('/evals');

    fireEvent.click(await screen.findByRole('button', { name: /Run eval/ }));
    const dialog = await screen.findByRole('dialog', { name: /Run eval/ });

    expect(within(dialog).queryByLabelText('Eval suite name')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('run-experiment-prompt')).toHaveTextContent(
      'Run the configured evaluation harness for the planning-lookbook eval suite, comparing its current baseline against a new candidate build, and export the result to Chorus.'
    );
  });
});
