import type { RunMode } from '@/api/types';

/**
 * Presentation metadata for the three lifecycle lanes. Class strings are
 * written out in full so Tailwind can statically detect them (no interpolation).
 * Colors use dr-ui reserved chart tokens only.
 */
export const MODE_META: Record<
  RunMode,
  { label: string; laneLabel: string; dot: string; chip: string; text: string }
> = {
  dev: {
    label: 'dev',
    laneLabel: 'Development',
    dot: 'bg-chart-1',
    chip: 'border-chart-1/40 text-chart-1',
    text: 'text-chart-1',
  },
  ci: {
    label: 'ci',
    laneLabel: 'Integration (CI)',
    dot: 'bg-chart-4',
    chip: 'border-chart-4/40 text-chart-4',
    text: 'text-chart-4',
  },
  prod: {
    label: 'prod',
    laneLabel: 'Production',
    dot: 'bg-chart-2',
    chip: 'border-chart-2/40 text-chart-2',
    text: 'text-chart-2',
  },
};

/** dev → ci → prod, the left-to-right lane progression. */
export const LANE_ORDER: RunMode[] = ['dev', 'ci', 'prod'];

export function isRunMode(value: string): value is RunMode {
  return value === 'dev' || value === 'ci' || value === 'prod';
}
