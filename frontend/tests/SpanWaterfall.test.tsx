import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { SpanWaterfall } from '../src/components/traces/SpanWaterfall';
import { formatNsClock } from '../src/lib/format';
import type { Span } from '../src/api/types';

const NS_PER_MS = 1_000_000;

function makeSpan(overrides: Partial<Span> & { span_id: string; start_ns: number }): Span {
  return {
    name: 'step',
    service: 'worker',
    duration_ms: 5,
    status: 'ok',
    error_message: null,
    attributes: {},
    children: [],
    ...overrides,
  };
}

/**
 * Builds a deep (80+ span) flat-ish trace: a root plus `count` sequential
 * children. One child's *name* mentions "sandbox", one's *service* mentions
 * it, and one mentions it only inside an *attribute value* — this exercises
 * every matching surface the search box promises to cover.
 */
function buildDeepTrace(count = 85): Span {
  const children: Span[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * 10 * NS_PER_MS;
    if (i === 10) {
      children.push(
        makeSpan({ span_id: `span-${i}`, start_ns: start, name: 'sandbox-exec', service: 'worker-a' })
      );
    } else if (i === 20) {
      children.push(
        makeSpan({
          span_id: `span-${i}`,
          start_ns: start,
          name: 'run-tool',
          service: 'sandbox-svc',
        })
      );
    } else if (i === 30) {
      children.push(
        makeSpan({
          span_id: `span-${i}`,
          start_ns: start,
          name: 'cache-lookup',
          service: 'worker-b',
          attributes: { 'cache.tier': 'sandbox-warm-pool' },
        })
      );
    } else {
      children.push(
        makeSpan({
          span_id: `span-${i}`,
          start_ns: start,
          name: `step-${i}`,
          service: i % 2 === 0 ? 'worker-a' : 'worker-b',
        })
      );
    }
  }

  return makeSpan({
    span_id: 'root',
    start_ns: 0,
    name: 'agent.run',
    service: 'claude-code',
    duration_ms: (count + 1) * 10,
    children,
  });
}

describe('SpanWaterfall — per-span timestamps', () => {
  it('renders an absolute HH:MM:SS.mmm start time for every span row', () => {
    const root = makeSpan({
      span_id: 'root',
      start_ns: 0,
      name: 'agent.run',
      duration_ms: 100,
      children: [
        makeSpan({ span_id: 'child-1', start_ns: 42 * NS_PER_MS, name: 'chat.completion' }),
      ],
    });
    render(<SpanWaterfall root={root} />);

    const rows = screen.getAllByTestId('span-row');
    expect(rows).toHaveLength(2);

    const timestamps = screen.getAllByTestId('span-timestamp');
    expect(timestamps).toHaveLength(2);
    expect(timestamps[0]).toHaveTextContent(formatNsClock(0));
    expect(timestamps[1]).toHaveTextContent(formatNsClock(42 * NS_PER_MS));
    // sanity: format looks like HH:MM:SS.mmm
    expect(timestamps[0].textContent).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe('SpanWaterfall — in-trace search', () => {
  it('surfaces spans matching by name, service, or attribute value and dims the rest', () => {
    const root = buildDeepTrace(85);
    render(<SpanWaterfall root={root} />);

    // Deep trace: root + 85 children.
    expect(screen.getAllByTestId('span-row')).toHaveLength(86);

    const search = screen.getByTestId('waterfall-search');
    fireEvent.change(search, { target: { value: 'sandbox' } });

    // 3 spans mention "sandbox" (by name, by service, by attribute value).
    expect(screen.getByTestId('waterfall-search-count')).toHaveTextContent('3 / 86 spans match');

    const rows = screen.getAllByTestId('span-row');
    const matched = rows.filter(row => row.getAttribute('data-matched') === 'true');
    const dimmed = rows.filter(row => row.getAttribute('data-dimmed') === 'true');
    expect(matched).toHaveLength(3);
    expect(dimmed).toHaveLength(83);

    // Name match: "sandbox-exec" is highlighted in place, row not dimmed.
    const nameMatchRow = screen.getByText('run-tool').closest('[data-testid="span-row"]')!;
    expect(nameMatchRow.getAttribute('data-matched')).toBe('true');

    // Attribute-only match: name/service don't mention "sandbox", but the row
    // still surfaces as matched and flags that the hit is inside attributes.
    const attrMatchRow = screen.getByText('cache-lookup').closest('[data-testid="span-row"]')!;
    expect(attrMatchRow.getAttribute('data-matched')).toBe('true');
    expect(within(attrMatchRow).getByText('attr match')).toBeInTheDocument();

    // Clearing the search restores every row to the neutral (non-dimmed) state.
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.queryByTestId('waterfall-search-count')).not.toBeInTheDocument();
    for (const row of screen.getAllByTestId('span-row')) {
      expect(row.getAttribute('data-dimmed')).toBe('false');
    }
  });

  it('shows a no-match message when the search term matches nothing', () => {
    const root = buildDeepTrace(85);
    render(<SpanWaterfall root={root} />);

    fireEvent.change(screen.getByTestId('waterfall-search'), {
      target: { value: 'nonexistent-term-xyz' },
    });

    expect(screen.getByText(/No spans match/)).toBeInTheDocument();
    expect(screen.getByTestId('waterfall-search-count')).toHaveTextContent('0 / 86 spans match');
  });
});
