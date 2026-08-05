import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/** Build the ready-to-paste natural-language instruction for a coding agent
 * to run the application's evaluation flow, filling in whichever of
 * lookbook/baseline are actually known from page context and falling back to
 * plain-English placeholders (never fabricated values) for the rest. */
export function buildAgentPrompt(lookbook: string, baseline: string): string {
  if (lookbook && baseline) {
    return `Run the configured evaluation harness for the ${lookbook} eval suite, comparing baseline ${baseline} against a new candidate build, and export the result to Chorus.`;
  }
  if (lookbook) {
    return `Run the configured evaluation harness for the ${lookbook} eval suite, comparing its current baseline against a new candidate build, and export the result to Chorus.`;
  }
  if (baseline) {
    return `Run the configured evaluation harness for the eval suite you want to evaluate, comparing baseline ${baseline} against a new candidate build, and export the result to Chorus.`;
  }
  return 'Run the configured evaluation harness for the eval suite and baseline you want to evaluate, compare it with a new candidate build, and export the result to Chorus.';
}

/** Build an explicit placeholder command without inventing an evaluator CLI. */
export function buildCliCommand(lookbook: string, baseline: string): string {
  const lb = lookbook || '<eval-suite>';
  const bl = baseline || '<baseline>';
  return `<your-eval-command> --eval-suite ${lb} --baseline ${bl}`;
}

/** A block of copyable text with its own copy-to-clipboard button — mirrors
 * OtlpCard's copy interaction on SourcesPage (writeText + a `copied` flag
 * that flips the icon/label for 1.5s). */
function CopyBlock({ label, text, testId }: { label: string; text: string; testId: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {label}
        </span>
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        data-testid={testId}
        className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap text-foreground"
      >
        {text}
      </pre>
    </div>
  );
}

export interface RunExperimentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Known lookbook name from page context (e.g. the selected dataset on
   * LookbooksPage). When absent, RunwayPage doesn't track a lookbook per
   * experiment, so the user fills it in themselves. */
  lookbook?: string | null;
  /** Known baseline version from page context (e.g. RunwayPage's
   * `gate.baseline` for the selected A/B experiment). When absent (e.g.
   * LookbooksPage's panel spans many past experiments/baselines), the user
   * fills it in themselves. */
  baseline?: string | null;
}

/** "Run experiment..." dialog: Chorus does not assume one evaluator runner,
 * process itself, so this is a "tell the user exactly how" stopgap rather
 * than a real trigger — it offers a ready-to-paste agent prompt (primary)
 * and an explicit command placeholder, both
 * reflecting whatever real lookbook/baseline context the calling page
 * already knows. */
export function RunExperimentDialog({
  open,
  onOpenChange,
  lookbook,
  baseline,
}: RunExperimentDialogProps) {
  const [lookbookInput, setLookbookInput] = useState(lookbook ?? '');
  const [baselineInput, setBaselineInput] = useState(baseline ?? '');

  // Reset the form each time the dialog (re)opens, picking up whatever the
  // page currently knows (the selected experiment may have changed since it
  // was last opened) — mirrors AddLookDialog's "reset only on open" effect,
  // so an in-flight query resolving *while* the dialog is already open
  // doesn't clobber whatever the user has typed.
  useEffect(() => {
    if (open) {
      setLookbookInput(lookbook ?? '');
      setBaselineInput(baseline ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const lb = lookbookInput.trim();
  const bl = baselineInput.trim();
  const prompt = buildAgentPrompt(lb, bl);
  const cliCommand = buildCliCommand(lb, bl);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Run eval…</DialogTitle>
          <DialogDescription>
            Chorus accepts evaluation results without requiring a particular framework. Use your
            application's configured harness, then export the run to Chorus.
          </DialogDescription>
        </DialogHeader>

        {lookbook ? null : (
          <label className="block text-xs">
            <span className="mb-1 block font-semibold text-muted-foreground">Eval suite name</span>
            <Input
              aria-label="Eval suite name"
              data-testid="run-experiment-lookbook-input"
              value={lookbookInput}
              onChange={event => setLookbookInput(event.target.value)}
              placeholder="e.g. flex-regression"
            />
          </label>
        )}
        {baseline ? null : (
          <label className="block text-xs">
            <span className="mb-1 block font-semibold text-muted-foreground">
              Baseline version (optional)
            </span>
            <Input
              aria-label="Baseline version"
              data-testid="run-experiment-baseline-input"
              value={baselineInput}
              onChange={event => setBaselineInput(event.target.value)}
              placeholder="e.g. v1"
            />
          </label>
        )}

        <CopyBlock label="Prompt your agent" text={prompt} testId="run-experiment-prompt" />
        <CopyBlock label="Or run it yourself" text={cliCommand} testId="run-experiment-cli" />

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
