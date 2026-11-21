import type { Ref } from "react";
import { Archive, ArchiveRestore, ArrowLeft, ListChecks, Pencil, TerminalSquare, Trash2 } from "lucide-react";
import { Link } from "react-router";
import type { FleetDetail } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { formatDateTime } from "~/lib/format.js";
import type { FleetRowAction } from "./FleetRowActions.js";
import { FLEET_TYPE_LABELS } from "./FleetsTable.js";

/*
 * A fleet's page's header: the back link "Fleets", the label as the
 * heading, the "Active"/"Archived" badge and the "Created {date}" line. Its
 * details:
 * - the fleet's type beside the badge ("Supervisor", "K8s Supervisor", the
 *   list's words), as the one route serves every type;
 * - the actions are the list's: Rename, Archive or Unarchive, and Delete,
 *   shown for an archived fleet too (Unarchive and Delete). They read as
 *   words, so their names hold no label;
 * - an active server fleet's "Install collector" (outline, TerminalSquare,
 *   before Rename), opening the install dialog for the Default group; and,
 *   once the fleet has collectors, "Setup guide" (ghost, ListChecks, a
 *   toggle with `aria-pressed`, no `title`), which shows and hides the setup
 *   checklist. The route passes them only for an active fleet: a
 *   Kubernetes-supervisor fleet's reads "Install with Helm", opening the
 *   Helm install dialog;
 * - the date by `formatDateTime` (en-US, the same in every browser), never
 *   the browser's `toLocaleString()`;
 * - "Fleet not found" says "It may have been deleted, or you may not have
 *   access." (never "archived": an archived fleet opens).
 * The label is text, in the masked shell; the links hold no label.
 */

/** The back link to the list; `ref` for the page's focus, when what held it is gone. */
export function FleetsBackLink({ ref }: { ref?: Ref<HTMLAnchorElement> | undefined }) {
  return (
    <Link
      ref={ref}
      to="/fleet-management"
      className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Fleets
    </Link>
  );
}

/** "Fleet not found", with the back link (`backLinkRef` its `ref`). */
export function FleetNotFound({ backLinkRef }: { backLinkRef?: Ref<HTMLAnchorElement> | undefined }) {
  return (
    <div className="px-5 py-4">
      <FleetsBackLink ref={backLinkRef} />
      <div className="mt-5 rounded-lg border border-border bg-card p-8 text-center">
        <h3 className="text-sm font-medium text-foreground">Fleet not found</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">It may have been deleted, or you may not have access.</p>
      </div>
    </div>
  );
}

/** "Setup guide": whether the checklist is shown, its toggle, and the button's ref (the focus goes back to it as the checklist is hidden). */
export interface SetupGuideToggle {
  open: boolean;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement> | undefined;
}

interface FleetHeaderProps {
  fleet: FleetDetail;
  /** `from` the button pressed: where the focus goes back as its dialog closes. */
  onAction: (action: FleetRowAction, fleet: FleetDetail, from: HTMLElement) => void;
  /** "Install collector", or a Kubernetes fleet's "Install with Helm" (an active fleet only): `from` the button pressed. */
  onInstall?: ((from: HTMLElement) => void) | undefined;
  /** The button's ref: the route's focus fallback. */
  installRef?: Ref<HTMLButtonElement> | undefined;
  /** "Setup guide" (an active fleet with collectors only); null for none. */
  setupGuide?: SetupGuideToggle | null | undefined;
}

export function FleetHeader({ fleet, onAction, onInstall, installRef, setupGuide = null }: FleetHeaderProps) {
  const archived = fleet.status === "archived";
  return (
    <header className="flex items-start justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 text-lg font-semibold tracking-[-0.01em] text-foreground truncate">{fleet.label}</h1>
          {archived ? <Badge variant="secondary">Archived</Badge> : <Badge variant="success">Active</Badge>}
          <span className="whitespace-nowrap text-xs text-muted-foreground">{FLEET_TYPE_LABELS[fleet.type]}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground/80">
          Created <span className="font-mono">{formatDateTime(fleet.createdAt)}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {setupGuide !== null && (
          <Button ref={setupGuide.ref} variant="ghost" size="sm" aria-pressed={setupGuide.open} onClick={setupGuide.onToggle}>
            <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
            Setup guide
          </Button>
        )}
        {onInstall !== undefined && (
          <Button ref={installRef} variant="outline" size="sm" onClick={(event) => onInstall(event.currentTarget)}>
            <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
            {fleet.type === "kubernetes-supervisor" ? "Install with Helm" : "Install collector"}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={(event) => onAction("rename", fleet, event.currentTarget)}>
          <Pencil className="h-3.5 w-3.5" />
          Rename
        </Button>
        <Button variant="outline" size="sm" onClick={(event) => onAction(archived ? "unarchive" : "archive", fleet, event.currentTarget)}>
          {archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          {archived ? "Unarchive" : "Archive"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-fail hover:bg-fail-soft hover:text-fail"
          onClick={(event) => onAction("delete", fleet, event.currentTarget)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </header>
  );
}
