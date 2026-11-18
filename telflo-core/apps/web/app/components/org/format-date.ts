/**
 * A member's date, in en-US with the time, in the browser's own time
 * zone ("Mar 15, 2026, 09:30 AM"); "N/A" when there is none. Both member pages
 * had their own copy of it.
 */
export function formatDate(dateString: string | null): string {
  if (!dateString) return "N/A";
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
