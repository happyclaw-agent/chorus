/** Pure score parsing and display helpers for eval run results.
 *
 * Grid/gate score values arrive stringified from the backend ("True"/"False"
 * for booleans, "0.92" for floats). The verdict/regression logic itself now
 * lives in the backend promotion gate (GET /api/experiments/{id}/gate); these
 * helpers only parse and format the raw values for display.
 */

export type ParsedScore =
  | { kind: 'bool'; value: boolean }
  | { kind: 'num'; value: number }
  | { kind: 'text'; value: string };

export function parseScore(raw: string | undefined | null): ParsedScore | null {
  if (raw == null) return null;
  if (raw === 'True' || raw === 'true') return { kind: 'bool', value: true };
  if (raw === 'False' || raw === 'false') return { kind: 'bool', value: false };
  const num = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(num)) return { kind: 'num', value: num };
  return { kind: 'text', value: raw };
}

/** Compact display form: booleans as glyphs, numbers as given. */
export function formatScore(parsed: ParsedScore | null): string {
  if (parsed == null) return '–';
  if (parsed.kind === 'bool') return parsed.value ? '✓' : '✕';
  if (parsed.kind === 'num') return String(parsed.value);
  return parsed.value;
}
