/**
 * Stable service → dr-ui chart-token assignment.
 *
 * Colors come exclusively from the reserved --chart-1..5 tokens. Class strings
 * are written out in full (no interpolation) so Tailwind can statically detect
 * them. A service is mapped to a slot by its position in the sorted, de-duped
 * set of services in the current view, so the assignment is deterministic
 * (stable) for a given set and distinct for up to five services.
 */

export interface ServiceColor {
  /** 1-based chart slot (1..5). */
  slot: number;
  /** Solid fill for bars / accents: `bg-chart-N`. */
  bar: string;
  /** Text color: `text-chart-N`. */
  text: string;
  /** Legend / status dot fill: `bg-chart-N`. */
  dot: string;
  /** Left accent border color: `border-l-chart-N`. */
  leftBorder: string;
  /** Node outline color: `border-chart-N/50`. */
  chipBorder: string;
  /** Soft node fill: `bg-chart-N/10`. */
  softBg: string;
}

const SLOTS: ServiceColor[] = [
  {
    slot: 1,
    bar: 'bg-chart-1',
    text: 'text-chart-1',
    dot: 'bg-chart-1',
    leftBorder: 'border-l-chart-1',
    chipBorder: 'border-chart-1/50',
    softBg: 'bg-chart-1/10',
  },
  {
    slot: 2,
    bar: 'bg-chart-2',
    text: 'text-chart-2',
    dot: 'bg-chart-2',
    leftBorder: 'border-l-chart-2',
    chipBorder: 'border-chart-2/50',
    softBg: 'bg-chart-2/10',
  },
  {
    slot: 3,
    bar: 'bg-chart-3',
    text: 'text-chart-3',
    dot: 'bg-chart-3',
    leftBorder: 'border-l-chart-3',
    chipBorder: 'border-chart-3/50',
    softBg: 'bg-chart-3/10',
  },
  {
    slot: 4,
    bar: 'bg-chart-4',
    text: 'text-chart-4',
    dot: 'bg-chart-4',
    leftBorder: 'border-l-chart-4',
    chipBorder: 'border-chart-4/50',
    softBg: 'bg-chart-4/10',
  },
  {
    slot: 5,
    bar: 'bg-chart-5',
    text: 'text-chart-5',
    dot: 'bg-chart-5',
    leftBorder: 'border-l-chart-5',
    chipBorder: 'border-chart-5/50',
    softBg: 'bg-chart-5/10',
  },
];

/** Assign each distinct service a stable chart color (cycling past five). */
export function assignServiceColors(
  services: Array<string | null | undefined>
): Map<string, ServiceColor> {
  const unique = [...new Set(services.filter((s): s is string => Boolean(s)))].sort();
  const map = new Map<string, ServiceColor>();
  unique.forEach((service, index) => map.set(service, SLOTS[index % SLOTS.length]));
  return map;
}
