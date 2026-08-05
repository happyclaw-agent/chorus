import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';

interface DrilldownStatProps {
  /** Traces path (with query params) this stat should navigate to on click. */
  to: string;
  /** Accessible name for the stat, since children are usually bare numbers. */
  label: string;
  testId?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Wraps a summary stat (a Look count, a run count, an error count, …) so it
 * becomes a clickable drill-down into a filtered Traces view. Renders as a
 * real `<button>` so it's independently focusable/keyboard-operable — when
 * nesting this inside another clickable card, make the *outer* card a
 * `role="button"` `<div>` rather than a `<button>`, since `<button>` elements
 * must not contain interactive descendants.
 */
export function DrilldownStat({ to, label, testId, className, children }: DrilldownStatProps) {
  const navigate = useNavigate();

  const go = (event: MouseEvent | KeyboardEvent) => {
    // Stop propagation so this doesn't also trigger a parent card's onClick
    // (e.g. navigating to a group/dataset detail page instead).
    event.stopPropagation();
    navigate(to);
  };

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={go}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          go(event);
        }
      }}
      className={cn(
        'cursor-pointer rounded-sm text-left transition-colors',
        'hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
        className
      )}
    >
      {children}
    </button>
  );
}
