/** Formats a Date as the value a `datetime-local` input expects, in the viewer's local time. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/**
 * Converts a local `datetime-local` value to an unambiguous UTC ISO instant ending in Z.
 * Returns null when the input is incomplete or not a real date.
 */
export function localInputToUtcIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function formatUtc(iso: string | null): string {
  if (!iso) return '—';
  return `${iso.replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC`;
}

export function formatLocal(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
