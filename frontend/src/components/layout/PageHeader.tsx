import type { ReactNode } from 'react';

/**
 * Shared view header: an optional uppercase eyebrow tag, the title, a short
 * description, and optional right-aligned actions. The eyebrow encodes what
 * kind of surface this is (e.g. "MODEL EVALUATION") — a HUD-style section tag.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-1.5 flex items-center gap-2">
            <span className="neon-rule h-px w-6 rounded-full" aria-hidden />
            <span className="neon-eyebrow">{eyebrow}</span>
          </div>
        ) : null}
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="ml-auto flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}
