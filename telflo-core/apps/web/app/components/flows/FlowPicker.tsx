import { Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { Flow, FlowSignal, FlowSource } from "@telflo/contracts";
import { Input } from "~/components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { FlowCard, type FlowCardFlow } from "./FlowCard.js";

/*
 * The flow picker (ADR 0018; D12): search, filters and the grid over the
 * flows, shared by the gallery (`/app/flows`) and the create dialog's "Start
 * from a flow", so the two can't show different flows or filter them
 * differently. It filters what it is given, in the browser. Its callers pass
 * the published flows only (D12 Ruling 42), but for a product admin's gallery
 * with "Show hidden flows" switched on, and the playground's gallery the open
 * read's published flows (D31-1 decision 33): it reads only the fields it
 * filters and shows, so either fits, and `onSelect` hands back the flow as it
 * was given.
 */

/** The fields the picker filters and shows: a card's, its slug and its tags. */
export type FlowPickerFlow = FlowCardFlow & Pick<Flow, "slug" | "tags">;

type SourceFilter = "all" | FlowSource;
type SignalFilter = "all" | FlowSignal;

interface FlowPickerProps<PickerFlow extends FlowPickerFlow> {
  flows: readonly PickerFlow[];
  onSelect: (flow: PickerFlow) => void;
  /** Compact cards and a tighter grid, inside the create dialog. */
  compact?: boolean;
  selectedSlug?: string | null;
  /** A control at the end of the filter row (the gallery's "Show hidden flows" switch, for a product admin). */
  toolbar?: ReactNode;
}

export function FlowPicker<PickerFlow extends FlowPickerFlow>({
  flows,
  onSelect,
  compact = false,
  selectedSlug = null,
  toolbar,
}: FlowPickerProps<PickerFlow>) {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [signal, setSignal] = useState<SignalFilter>("all");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return flows.filter((flow) => {
      if (source !== "all" && flow.source !== source) return false;
      if (signal !== "all" && !flow.signals.includes(signal)) return false;
      if (query) {
        const haystack = `${flow.name} ${flow.summary} ${flow.tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [flows, search, source, signal]);

  // The source filter is dead weight until a community flow exists.
  const hasCommunity = useMemo(() => flows.some((flow) => flow.source === "community"), [flows]);

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* What a visitor types never reaches replay (D31-1 decision 39, Ruling 303; the signed-in gallery's too). */}
        <div className="relative w-full sm:max-w-xs ph-no-capture">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search flows…"
            className="pl-8"
          />
        </div>
        <Select value={signal} onValueChange={(value) => setSignal(value as SignalFilter)}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Signal" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All signals</SelectItem>
            <SelectItem value="traces">Traces</SelectItem>
            <SelectItem value="metrics">Metrics</SelectItem>
            <SelectItem value="logs">Logs</SelectItem>
          </SelectContent>
        </Select>
        {hasCommunity && (
          <Select value={source} onValueChange={(value) => setSource(value as SourceFilter)}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="telflo">Built by Telflo</SelectItem>
              <SelectItem value="community">Community</SelectItem>
            </SelectContent>
          </Select>
        )}
        {toolbar}
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
          <Search className="h-5 w-5 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">No flows match your search or filter.</p>
        </div>
      ) : (
        <div
          className={
            compact
              ? "grid grid-cols-1 gap-2.5 sm:grid-cols-2"
              : "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          }
        >
          {filtered.map((flow) => (
            <FlowCard
              key={flow.slug}
              flow={flow}
              onSelect={onSelect}
              compact={compact}
              selected={compact && selectedSlug === flow.slug}
            />
          ))}
        </div>
      )}
    </div>
  );
}
