/** Shared display formatters for runs, spans, and stats. */

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`;
}

export function formatTokens(count: number | null | undefined): string {
  if (count == null || !Number.isFinite(count)) return '—';
  return count.toLocaleString('en-US');
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Wall-clock time (HH:MM:SS.mmm) from an epoch-nanoseconds value. */
export function formatNsClock(ns: number | null | undefined): string {
  if (ns == null || !Number.isFinite(ns)) return '—';
  const date = new Date(ns / 1_000_000);
  if (Number.isNaN(date.getTime())) return '—';
  const clock = date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const millis = date.getMilliseconds().toString().padStart(3, '0');
  return `${clock}.${millis}`;
}

/** Signed millisecond offset (e.g. "+180ms") of one ns timestamp from another. */
export function formatNsOffset(ns: number, startNs: number): string {
  const ms = (ns - startNs) / 1_000_000;
  const rounded = Math.round(ms);
  return `${rounded >= 0 ? '+' : ''}${rounded}ms`;
}

export function shortTraceId(traceId: string): string {
  return traceId.slice(0, 8);
}

/**
 * Trim a gateway model id to a readable name:
 * "provider/anthropic.claude-opus-4-8" → "claude-opus-4-8".
 * Keeps vendor families that are the meaningful name (deepseek.r1, gpt-oss);
 * only the redundant "anthropic." namespace is dropped. Bare names ("opus")
 * pass through unchanged.
 */
/** Human label for a matrix axis key, e.g. "coder_model" -> "Coder Model". */
export function axisLabel(key: string): string {
  return key
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function shortModelName(name: string | null | undefined): string {
  if (!name) return '—';
  const segment = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return segment.startsWith('anthropic.') ? segment.slice('anthropic.'.length) : segment;
}

/**
 * Compact numeric display for matrix metric means: a few significant figures,
 * with thousands separators for large magnitudes. "1234.5" -> "1,235",
 * "0.8421" -> "0.842", "12.5" -> "12.5".
 */
export function formatMetricValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return Number(value.toFixed(2)).toString();
  return Number(value.toPrecision(3)).toString();
}

export function truncate(text: string | null, max = 96): string {
  if (!text) return '—';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
