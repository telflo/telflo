import { ArrowRight } from "lucide-react";
import type { Flow } from "@telflo/contracts";
import { SignalBadges, SourceBadge } from "./FlowBadges.js";

/*
 * A flow's card (ADR 0018; D12): a flow in the gallery, or (compact) in the
 * create dialog's picker. The whole card is a button, as the configurations'
 * cards are. Its name and summary are text, never an attribute (ADR 0024).
 *
 * It reads only a card's fields, so a signed-in read's flow and the open
 * read's `PublishedFlow` (the playground's gallery, D31-1 decision 33) both
 * fit; `onSelect` hands back the flow it was given, as it was given.
 */

/** The fields the card shows. */
export type FlowCardFlow = Pick<Flow, "name" | "summary" | "source" | "authorName" | "signals">;

interface FlowCardProps<CardFlow extends FlowCardFlow> {
  flow: CardFlow;
  onSelect: (flow: CardFlow) => void;
  /** The compact variant, inside the create dialog. */
  compact?: boolean;
  selected?: boolean;
}

export function FlowCard<CardFlow extends FlowCardFlow>({
  flow,
  onSelect,
  compact = false,
  selected = false,
}: FlowCardProps<CardFlow>) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={compact ? selected : undefined}
      onClick={() => onSelect(flow)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(flow);
        }
      }}
      className={`group flex h-full cursor-pointer flex-col rounded-lg border bg-card p-4 text-left transition-colors ${
        selected ? "border-brand ring-1 ring-brand" : "border-border hover:border-gray-300 dark:hover:border-gray-600"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium text-foreground">{flow.name}</h3>
        <SourceBadge source={flow.source} authorName={flow.authorName} />
      </div>

      <p
        className={`mt-2 flex-1 text-[13px] leading-[1.45] text-muted-foreground ${
          compact ? "line-clamp-2" : "line-clamp-3"
        }`}
      >
        {flow.summary}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <div className="flex flex-wrap items-center gap-1">
          <SignalBadges signals={flow.signals} />
        </div>
        {!compact && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
            View
            <ArrowRight className="h-3 w-3" />
          </span>
        )}
      </div>
    </div>
  );
}
