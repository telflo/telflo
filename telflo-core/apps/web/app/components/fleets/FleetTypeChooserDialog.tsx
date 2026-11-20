import { Boxes, Server } from "lucide-react";
import type { FleetType } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";

/*
 * "Create a new fleet":
 * - two cards, "Linux servers & VMs" (`server`) and "Kubernetes (Helm)"
 *   (`kubernetes-supervisor`); there is no Operator bridge card; the Helm
 *   card has no "Recommended" badge;
 * - no "Private Preview" flags (every member gets both types), so no card is
 *   ever disabled, and none carries a disabled card's `aria-label` or
 *   `title`;
 * - the footer note leaves out the bridge.
 * Picking a card hands its type to the caller, which closes this dialog and
 * opens that type's create dialog.
 */

interface FleetChoice {
  type: FleetType;
  title: string;
  description: string;
  Icon: typeof Server;
}

// Grouped by where the collectors run, the question a first-time user can
// answer; each description says what it does, then who it's for.
const HOST_CHOICES: FleetChoice[] = [
  {
    type: "server",
    title: "Linux servers & VMs",
    description:
      "One managed collector per host, installed with a copy-paste command. Choose this for anything that isn't Kubernetes: bare metal, VMs, Docker hosts.",
    Icon: Server,
  },
];

const KUBERNETES_CHOICES: FleetChoice[] = [
  {
    type: "kubernetes-supervisor",
    title: "Kubernetes (Helm)",
    description:
      "Installs node, cluster, and gateway collectors with Helm. Nothing else to set up — the right start for most clusters.",
    Icon: Boxes,
  },
];

/** The footer's guidance, rewritten without the Operator bridge. */
export const CHOOSER_FOOTER_NOTE =
  "Not sure? On Kubernetes, start with Helm. You can run several fleets side by side, one per environment or cluster.";

function FleetCard({ choice, onSelect }: { choice: FleetChoice; onSelect: (type: FleetType) => void }) {
  const { type, title, description, Icon } = choice;
  return (
    <div className="relative">
      {/* Left-aligned row, not a centered icon tile. */}
      <button
        type="button"
        onClick={() => onSelect(type)}
        className="group flex h-full w-full items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-brand/40 hover:bg-accent focus:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground group-hover:text-brand" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-foreground">{title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
        </span>
      </button>
    </div>
  );
}

function FleetGroup({
  heading,
  choices,
  onSelect,
}: {
  heading: string;
  choices: FleetChoice[];
  onSelect: (type: FleetType) => void;
}) {
  return (
    <section className="flex flex-1 flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h3>
      <div className="flex flex-col gap-4">
        {choices.map((choice) => (
          <FleetCard key={choice.type} choice={choice} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

export function FleetTypeChooserDialog({
  open,
  onOpenChange,
  onSelect,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the type picked; the caller closes this dialog and opens that type's create dialog. */
  onSelect: (type: FleetType) => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the page gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Create a new fleet</DialogTitle>
          <DialogDescription>
            A fleet is a set of collectors you manage together. Where will these collectors run?
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4 py-4">
          <FleetGroup heading="Hosts & VMs" choices={HOST_CHOICES} onSelect={onSelect} />

          <div className="w-px self-stretch bg-muted-foreground/40" aria-hidden="true" />

          <FleetGroup heading="Kubernetes" choices={KUBERNETES_CHOICES} onSelect={onSelect} />
        </div>

        <p className="text-xs text-muted-foreground">{CHOOSER_FOOTER_NOTE}</p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
