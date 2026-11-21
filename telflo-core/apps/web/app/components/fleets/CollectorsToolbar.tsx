import { useRef, useState, type FormEvent, type RefObject } from "react";
import { RefreshCw, Search } from "lucide-react";
import type { CollectorGroup, FleetType } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Input } from "~/components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { groupLabel, groupsInFleetOrder } from "~/lib/kubernetes-groups.js";

/*
 * The Collectors tab's toolbar: a search box and a refresh button, and a Group
 * filter beside them.
 * - The search box is uncontrolled (`defaultValue` and a ref read on
 *   Enter), so its text never becomes a `value` attribute, which replay
 *   records and can't mask; the `<form>` holds it alone. At most 100
 *   characters; the hook trims what is sent, and an empty box searches
 *   nothing. It searches collectors' names and addresses, not group or
 *   configuration names.
 * - The Group filter, outside the form (inside one, Radix's Select adds a
 *   hidden native `<select>` whose options carry the items' values): "All
 *   groups", then the fleet's groups in the API's order, the Default group
 *   first. Its item values are the groups' ids and the sentinel "all", never a
 *   name. On a Kubernetes-supervisor fleet "Agent", "Cluster", then the
 *   gateways by name (`groupLabel`, `groupsInFleetOrder`). Disabled until the
 *   groups have been read. A group chosen shows at once, while its read is
 *   under way (the rows still shown are the earlier filter's); once the read
 *   settles the filter shows the rows' own, so a failed read returns it to
 *   theirs.
 * - Refresh reads the page again as a person's read, spinning meanwhile; it
 *   stays enabled, so the focus stays on it, and a press during a person's
 *   read reads the same page again.
 */

/** The search box's bound. */
export const COLLECTORS_SEARCH_MAX_LENGTH = 100;

/** The Group filter's value for "All groups": no group's id. */
const ALL_GROUPS = "all";

interface CollectorsToolbarProps {
  /** The search box, for the tab: where the focus goes when a dialog's opener is gone. */
  searchBoxRef?: RefObject<HTMLInputElement | null> | undefined;
  groups: CollectorGroup[] | null;
  /** The rows' filter: a group's id, or null for "All groups". */
  groupId: string | null;
  /** A person's read is under way: Refresh spins (and stays enabled, so the focus stays). */
  busy: boolean;
  onSearch: (text: string) => void;
  onFilter: (groupId: string | null) => void;
  onRefresh: () => void;
  /** The fleet's type: a Kubernetes fleet's filter names the Agent and the Cluster by their roles. */
  fleetType?: FleetType;
}

export function CollectorsToolbar({ searchBoxRef, groups, groupId, busy, onSearch, onFilter, onRefresh, fleetType = "server" }: CollectorsToolbarProps) {
  const ownBox = useRef<HTMLInputElement>(null);
  const box = searchBoxRef ?? ownBox;
  // The filter chosen while its read is under way (`busy`); dropped once no read is, for the rows' own.
  const [chosen, setChosen] = useState<string | null>(null);
  if (chosen !== null && !busy) setChosen(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(box.current?.value ?? "");
  };
  return (
    <div className="mb-3 flex items-center gap-2">
      {/* A search's term is configuration text (a collector's name): replay never records the box. */}
      <form onSubmit={submit} className="relative flex-1 ph-no-capture">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={box}
          type="search"
          defaultValue=""
          maxLength={COLLECTORS_SEARCH_MAX_LENGTH}
          placeholder="Search collectors by name or IP…"
          className="pl-9"
          aria-label="Search collectors"
        />
      </form>
      <Select
        value={chosen ?? groupId ?? ALL_GROUPS}
        onValueChange={(value) => {
          setChosen(value);
          onFilter(value === ALL_GROUPS ? null : value);
        }}
        disabled={groups === null}
      >
        <SelectTrigger className="w-48" aria-label="Filter by group">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_GROUPS}>All groups</SelectItem>
          {groupsInFleetOrder(groups ?? [], fleetType).map((group) => (
            <SelectItem key={group.id} value={group.id}>
              {groupLabel(group, fleetType)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={onRefresh}
        aria-label="Refresh collectors"
      >
        <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );
}
