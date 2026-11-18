/*
 * A published version as the pin picker's Version options show it (D17b-1
 * decision 26, Preflight ruling 12; ADR 0018): "@v{n}", the version's label
 * when it has one, an optional marker (" (group default)"), then its
 * published date. Per the D17b-1 Parity Notes: the date in an explicit en-US
 * format (not the browser's locale), and the label shown only when the
 * version is named (`lib/editor/version-label.ts`'s "Version N" would repeat
 * the number beside "@v{n}"). Text only: the label is the person's, never put
 * in an attribute (ADR 0024).
 */

/** A published date as the pickers show it: "Oct 12, 2026". */
export function pickerDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export interface VersionOptionLabelProps {
  versionNumber: number | null;
  /** The version's label; null or blank for an unnamed version, which shows none. */
  label?: string | null | undefined;
  /** The published date (ISO); none shows no date. */
  publishedAt?: string | null | undefined;
  /** An inline marker, " (group default)". */
  marker?: string | null | undefined;
}

/** Returns a fragment, so it drops straight into a `SelectItem`. */
export function VersionOptionLabel({ versionNumber, label, publishedAt, marker }: VersionOptionLabelProps) {
  const named = label?.trim() ? label.trim() : null;
  return (
    <>
      @v{versionNumber ?? "?"}
      {named !== null ? <span className="ml-2 text-foreground">{named}</span> : null}
      {marker ? ` (${marker})` : null}
      {publishedAt ? <span className="ml-2 text-xs text-muted-foreground">{pickerDate(publishedAt)}</span> : null}
    </>
  );
}
