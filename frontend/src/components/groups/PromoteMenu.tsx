import { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronDown, Waypoints } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { PromoteToLookDialog } from '@/components/traces/PromoteToLookDialog';
import { Button } from '@/components/ui/button';
import { traceDetailPath } from '@/constants/path';
import { cn } from '@/lib/utils';

/**
 * The promotion targets a captured run can be pushed toward: a real trace
 * becomes CI coverage (→ Look), or gets opened in the trace explorer. (A
 * third "Replay locally in coding session" option used to live here as a
 * non-functional "coming at the hackathon" stub — removed per #44 rather than
 * leaving something that looked real but wasn't.)
 */
export type PromoteTarget = 'ci-lookbook' | 'open-traces';

/**
 * SEAM for the next builder. Provide `onPromote` to wire real promotion
 * behavior; when supplied it fully owns every target. Signature intentionally
 * matches the requested `promoteTrace(traceId, target)` shape.
 */
export type PromoteHandler = (traceId: string, target: PromoteTarget) => void;

interface PromoteOption {
  target: PromoteTarget;
  label: string;
  icon: typeof BookOpen;
}

const OPTIONS: PromoteOption[] = [
  {
    target: 'ci-lookbook',
    label: 'Add to CI suite (→ Look)',
    icon: BookOpen,
  },
  {
    target: 'open-traces',
    label: 'Open in Traces',
    icon: Waypoints,
  },
];

/**
 * Action menu on a captured run offering the lifecycle promotion targets.
 * Both options are real: "Add to CI suite" opens the promote-to-Look dialog,
 * "Open in Traces" navigates to the trace explorer.
 */
export function PromoteMenu({
  traceId,
  onPromote,
}: {
  traceId: string;
  onPromote?: PromoteHandler;
}) {
  const [open, setOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handle(option: PromoteOption) {
    setOpen(false);
    // Seam: if the next builder wired real behavior, defer to it entirely.
    if (onPromote) {
      onPromote(traceId, option.target);
      return;
    }
    if (option.target === 'open-traces') {
      navigate(traceDetailPath(traceId));
      return;
    }
    // "Add to CI suite (→ Look)" is now real: promote the trace into a Look.
    setPromoteOpen(true);
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen(value => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Promote…
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </Button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-lg"
        >
          {OPTIONS.map(option => (
            <button
              key={option.target}
              type="button"
              role="menuitem"
              onClick={() => handle(option)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-secondary-foreground hover:bg-muted/60 hover:text-foreground"
            >
              <option.icon className="size-3.5 opacity-70" />
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      <PromoteToLookDialog traceId={traceId} open={promoteOpen} onOpenChange={setPromoteOpen} />
    </div>
  );
}
