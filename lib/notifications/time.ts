/**
 * Times and ages as a person reads them in a notification.
 *
 * Shared by the in-app renderer and the Telegram formatter so the same event
 * reads the same on both. Both take their inputs from the event — never from a
 * clock — so re-rendering a stored event later produces the identical text.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `3 Oct, 19:45 UTC`. Built from the UTC parts rather than `toLocaleString`, so
 * the same instant renders the same on every machine.
 */
export function utcClock(at: number): string {
  const d = new Date(at);
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month}, ${hh}:${mm} UTC`;
}

/**
 * A duration in the two largest units that matter: `42 min`, `3 h 10 min`,
 * `2 d 4 h`. Negative or non-finite input reads as `0 min` rather than as
 * nonsense; the callers have already refused anything that is not a time.
 */
export function formatAge(ms: number): string {
  const minutes = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  return `${mins} min`;
}
