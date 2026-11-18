import type { TestRunStatus, TestRunSummary } from "@telflo/contracts";
import { CheckCircle2, Clock, Loader2, ShieldX, XCircle } from "lucide-react";

/*
 * A run's status in words and as a badge (D14a decisions 1, 11 and 18; D15a
 * decision 3), "Validation Failed" included, in the platform's tokens.
 */

interface BadgeSpec {
  icon: typeof CheckCircle2;
  label: string;
  className: string;
  spin?: boolean;
}

/** The badges. */
const BY_STATUS: Record<TestRunStatus, BadgeSpec> = {
  queued: { icon: Clock, label: "Queued", className: "border-border text-muted-foreground" },
  running: { icon: Loader2, label: "Running", className: "border-brand/25 bg-brand-soft text-brand", spin: true },
  succeeded: { icon: CheckCircle2, label: "Success", className: "border-ok/25 bg-ok-soft text-ok" },
  validation_failed: { icon: ShieldX, label: "Validation Failed", className: "border-warn/25 bg-warn-soft text-warn" },
  failed: { icon: XCircle, label: "Error", className: "border-fail/25 bg-fail-soft text-fail" },
};

/** A run's status in words: "Queued (n ahead)" while it waits with its place known (decisions 1 and 11). */
export function statusLabel(run: Pick<TestRunSummary, "status" | "ahead">): string {
  const { label } = BY_STATUS[run.status];
  return run.status === "queued" && run.ahead !== null ? `${label} (${run.ahead} ahead)` : label;
}

export function StatusBadge({ run }: { run: Pick<TestRunSummary, "status" | "ahead"> }) {
  const spec = BY_STATUS[run.status];
  const Icon = spec.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-[0.07em] ${spec.className}`}
    >
      <Icon className={`w-3 h-3 ${spec.spin ? "animate-spin" : ""}`} />
      {statusLabel(run)}
    </span>
  );
}
