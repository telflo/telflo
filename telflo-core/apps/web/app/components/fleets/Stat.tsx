import type { ReactNode } from "react";

/*
 * One tile of a fleet's stats strip: its label, value and hint, with no dot,
 * value tooltip or footer. The value is a node, so the Token tile can hold
 * the Token badge and its tooltip. The label's rules are written out here
 * (there is no `tf-label` class).
 */

export type StatEmphasis = "neutral" | "warn" | "danger";

/** The value's colour, by emphasis. */
export function emphasisClassName(emphasis: StatEmphasis): string {
  switch (emphasis) {
    case "danger":
      return "text-fail";
    case "warn":
      return "text-warn";
    case "neutral":
      return "text-foreground";
  }
}

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  emphasis?: StatEmphasis;
}

export function Stat({ label, value, hint, emphasis = "neutral" }: StatProps) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className={`mt-1.5 font-mono text-lg font-semibold tabular-nums ${emphasisClassName(emphasis)}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
