import { useId, type Ref } from "react";
import { TerminalSquare } from "lucide-react";
import { COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE, type CollectorGroup } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import { DELETED_VERSION_WORDS } from "./CollectorDetailsDialog.js";
import { PublishedVersionLink } from "./PublishedVersionLink.js";
import { VariableGroupLink } from "./VariableGroupLink.js";

/*
 * A server fleet's groups as plain table markup with the fleet screens'
 * classes (`CollectorsTable`; no table component). Its details:
 *
 * - "Published version": "{configuration} @v{n}" linked to the editor's
 *   version (`PublishedVersionLink`: the name truncated at 16rem, the full
 *   text in a tooltip), with no `title`; "Nothing assigned" (muted) for any
 *   group with none, its meaning as tooltip text on a focusable trigger and
 *   as screen-reader text (a tooltip never shows on touch); "A deleted
 *   configuration's version" (muted) for an assignment whose version the
 *   platform no longer holds. No "Missing configuration" and no import hint.
 * - "Variable group": the group's variable group by name, else "Organization
 *   values", a button opening each variable's value and where it comes from
 *   (`VariableGroupLink`).
 * - "Install" (outline, TerminalSquare icon as the page's other install
 *   buttons) before Assign or Edit, opening the install dialog for the group,
 *   named "Install into {name}" through `aria-labelledby`; disabled on a
 *   group without a published version: a focusable wrapper (`role="button"`,
 *   `aria-disabled`, named the same way; the inner button hidden from
 *   assistive technology) with its reason as a tooltip and as screen-reader
 *   text: "Assign a published version first." with nothing assigned, the
 *   facts' "…belongs to a deleted configuration. Assign another first." for a
 *   deleted configuration's version (no `title` holds the reason or the
 *   name). An archived fleet's rows have none (`onInstall` absent).
 * - The Default group carries a "Default" badge and has no Delete (the API
 *   refuses it too).
 * - "More" (a link-styled button, with no `title`) is named "More about
 *   {name}", and each row's Assign or Edit and Delete "Assign {name}", "Edit
 *   {name}" and "Delete {name}", through `aria-labelledby` pointing at
 *   hidden text (`FleetRowActions`'s pattern): the ids hold the table's
 *   `useId` and the group's id, never its name, which is text in the masked
 *   shell only: no button has a `title`.
 * - Assign (primary, nothing assigned) and Edit (outline, otherwise) are one
 *   button whose words and style follow the assignment, so the focus stays
 *   on it across an assignment's reload.
 * The rows are the API's order: Default first, then by name.
 */

/** What "Nothing assigned" means for a group's collectors: its tooltip (the group dialog's "Nothing assigned" hint has its own words). */
export const NOTHING_ASSIGNED_MEANING = "The group's collectors that aren't pinned show Nothing assigned and keep running what they have.";

export const NOTHING_ASSIGNED_WORDS = "Nothing assigned";

/** Why a group's Install is disabled. */
export const INSTALL_NEEDS_VERSION = "Assign a published version first.";
/** Why it is disabled for a deleted configuration's version (no published version): the facts' words. */
export const INSTALL_NEEDS_LIVE_VERSION = COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE;

/** Why a group's Install is disabled, or null when it isn't: it needs a published version. */
export function installDisabledReason(group: CollectorGroup): string | null {
  if (isUnassigned(group)) return INSTALL_NEEDS_VERSION;
  return group.assignedVersion === null ? INSTALL_NEEDS_LIVE_VERSION : null;
}

const HEAD_BASE_CLASS =
  "h-9 whitespace-nowrap px-3 align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const HEAD_CLASS = `${HEAD_BASE_CLASS} text-left`;
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";
const TRIGGER_FOCUS_CLASS = "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

/** Whether a group has nothing assigned: its button reads "Assign", its dialog assigns. */
export function isUnassigned(group: CollectorGroup): boolean {
  return group.assignedPublishedVersionId === null;
}

/**
 * A group's published version: the link, "Nothing assigned" with its
 * meaning as a tooltip and screen-reader text, or the deleted
 * configuration's words. `withTooltip` false (the details) puts the meaning
 * under it as text instead, and shows the version's whole name with no
 * tooltip. A null group (a Kubernetes fleet's Cluster before its first
 * Assign) has nothing assigned.
 */
export function PublishedVersionCell({ group, withTooltip = true }: { group: CollectorGroup | null; withTooltip?: boolean }) {
  const version = group?.assignedVersion ?? null;
  if (version !== null) return <PublishedVersionLink version={version} variant={withTooltip ? "table" : "dialog"} />;
  if (group !== null && !isUnassigned(group)) return <span className="text-[13px] text-muted-foreground">{DELETED_VERSION_WORDS}</span>;
  if (!withTooltip) {
    return (
      <>
        <span className="text-[13px] text-muted-foreground">{NOTHING_ASSIGNED_WORDS}</span>
        <p className="mt-0.5 text-xs text-muted-foreground">{NOTHING_ASSIGNED_MEANING}</p>
      </>
    );
  }
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className={`text-[13px] text-muted-foreground ${TRIGGER_FOCUS_CLASS}`}>
            {NOTHING_ASSIGNED_WORDS}
            <span className="sr-only"> ({NOTHING_ASSIGNED_MEANING})</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          {NOTHING_ASSIGNED_MEANING}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * A row's "Install" (a Kubernetes fleet's rows too), named `label`
 * ("Install into {name}", "Install {name}") through `aria-labelledby`
 * pointing at hidden text whose id is `{rowId}-install` (never a name in an
 * attribute). Disabled (`reason` not null): a focusable wrapper
 * (`role="button"`, `aria-disabled`, named the same way; the inner button
 * hidden from assistive technology) with the reason as a tooltip and as
 * screen-reader text.
 */
export function RowInstallButton({
  rowId,
  label,
  reason,
  onInstall,
}: {
  rowId: string;
  label: string;
  reason: string | null;
  onInstall: (from: HTMLElement) => void;
}) {
  return (
    <>
      <span id={`${rowId}-install`} className="sr-only" hidden>
        {label}
      </span>
      {reason !== null ? (
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="button"
                aria-disabled="true"
                tabIndex={0}
                aria-labelledby={`${rowId}-install`}
                aria-describedby={`${rowId}-install-reason`}
                className={`inline-flex ${TRIGGER_FOCUS_CLASS}`}
              >
                <Button type="button" size="sm" variant="outline" disabled tabIndex={-1} aria-hidden="true">
                  <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
                  Install
                </Button>
                <span id={`${rowId}-install-reason`} className="sr-only">
                  {" "}
                  ({reason})
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-72">
              {reason}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <Button type="button" size="sm" variant="outline" aria-labelledby={`${rowId}-install`} onClick={(event) => onInstall(event.currentTarget)}>
          <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
          Install
        </Button>
      )}
    </>
  );
}

/** What a row's button asks for: the tab opens the dialog. */
export type GroupRowAction = "more" | "edit" | "delete";

export interface GroupsTableProps {
  groups: CollectorGroup[];
  /** A row's More, Assign or Edit, or Delete; `from` the button pressed, where the focus goes back as its dialog closes. */
  onAction: (action: GroupRowAction, group: CollectorGroup, from: HTMLElement) => void;
  /** The first row's Assign or Edit: where the focus goes when a dialog's opener is gone. */
  firstActionRef?: Ref<HTMLButtonElement> | undefined;
  /** A row's Install (an active fleet only): the route's install dialog for the group; `from` the button pressed. */
  onInstall?: ((group: CollectorGroup, from: HTMLElement) => void) | undefined;
}

export function GroupsTable({ groups, onAction, firstActionRef, onInstall }: GroupsTableProps) {
  const idPrefix = useId();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-[13px]">
          <thead className="[&_tr]:border-b">
            <tr className={ROW_CLASS}>
              <th className={HEAD_CLASS}>Name</th>
              <th className={HEAD_CLASS}>Published version</th>
              <th className={HEAD_CLASS}>Variable group</th>
              <th className={`${HEAD_BASE_CLASS} text-center`}>More</th>
              <th className={HEAD_CLASS}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {groups.map((group, index) => {
              const rowId = `${idPrefix}-group-${group.id}`;
              const unassigned = isUnassigned(group);
              const installReason = installDisabledReason(group);
              return (
                <tr key={group.id} className={ROW_CLASS}>
                  <td className={CELL_CLASS}>
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground">{group.name}</span>
                      {group.isDefault && <Badge variant="secondary">Default</Badge>}
                    </div>
                  </td>
                  <td className={CELL_CLASS}>
                    <PublishedVersionCell group={group} />
                  </td>
                  <td className={CELL_CLASS}>
                    <VariableGroupLink groupVariableGroupId={group.variableGroupId} />
                  </td>
                  <td className={`${CELL_CLASS} text-center`}>
                    <span id={`${rowId}-more`} className="sr-only" hidden>
                      More about {group.name}
                    </span>
                    <button
                      type="button"
                      aria-labelledby={`${rowId}-more`}
                      onClick={(event) => onAction("more", group, event.currentTarget)}
                      className="text-[13px] font-medium text-brand hover:underline focus:underline focus:outline-none"
                    >
                      More
                    </button>
                  </td>
                  <td className={CELL_CLASS}>
                    <div className="flex justify-end gap-2">
                      {onInstall !== undefined && (
                        <RowInstallButton
                          rowId={rowId}
                          label={`Install into ${group.name}`}
                          reason={installReason}
                          onInstall={(from) => onInstall(group, from)}
                        />
                      )}
                      <span id={`${rowId}-edit`} className="sr-only" hidden>
                        {unassigned ? "Assign" : "Edit"} {group.name}
                      </span>
                      <Button
                        ref={index === 0 ? firstActionRef : undefined}
                        type="button"
                        size="sm"
                        variant={unassigned ? "default" : "outline"}
                        aria-labelledby={`${rowId}-edit`}
                        onClick={(event) => onAction("edit", group, event.currentTarget)}
                      >
                        {unassigned ? "Assign" : "Edit"}
                      </Button>
                      {!group.isDefault && (
                        <>
                          <span id={`${rowId}-delete`} className="sr-only" hidden>
                            Delete {group.name}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:bg-destructive hover:text-destructive-foreground"
                            aria-labelledby={`${rowId}-delete`}
                            onClick={(event) => onAction("delete", group, event.currentTarget)}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
