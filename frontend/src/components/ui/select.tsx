import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<React.ComponentProps<'select'>, 'children'> {
  label: string;
  options: SelectOption[];
  /** Label shown for the empty value ("all") option. */
  allLabel?: string;
  /** Render the leading empty ("all") option (default true). */
  includeAll?: boolean;
}

/**
 * Compact labeled filter select (native `<select>` styled with dr-ui tokens).
 */
export function Select({
  label,
  options,
  allLabel = 'All',
  includeAll = true,
  className,
  ...props
}: SelectProps) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-secondary-foreground',
        className
      )}
    >
      <span className="text-muted-foreground">{label}:</span>
      <span className="relative inline-flex items-center">
        <select
          className="cursor-pointer appearance-none bg-transparent pr-5 font-medium text-foreground outline-none"
          {...props}
        >
          {includeAll ? <option value="">{allLabel}</option> : null}
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-0 size-3.5 text-muted-foreground" />
      </span>
    </label>
  );
}
