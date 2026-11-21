import type { FlowSignal, FlowSource } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";

/*
 * The flow's badges: a flow's signals and its provenance, as badges. Every
 * string is the flow's, shown as text (nothing in an attribute).
 */

// One color per signal, everywhere a flow is shown, so the gallery can be
// scanned for "the logs ones" without reading labels.
const SIGNAL_VARIANT: Record<FlowSignal, "info" | "success" | "warning"> = {
  traces: "info",
  metrics: "success",
  logs: "warning",
};

export function SignalBadges({ signals }: { signals: readonly FlowSignal[] }) {
  return (
    <>
      {signals.map((signal) => (
        <Badge key={signal} variant={SIGNAL_VARIANT[signal]}>
          {signal}
        </Badge>
      ))}
    </>
  );
}

/**
 * Who made a flow: its author when one is named ("Built by ClickStack"),
 * "Community" for a community flow, and "Built by Telflo" otherwise.
 */
export function SourceBadge({ source, authorName }: { source: FlowSource; authorName: string | null }) {
  if (authorName) {
    return (
      <Badge variant="outline" className="shrink-0">
        Built by {authorName}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0">
      {source === "community" ? "Community" : "Built by Telflo"}
    </Badge>
  );
}
