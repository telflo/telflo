import { useId, type RefObject } from "react";
import { CalendarPlus, Eye, ShieldOff } from "lucide-react";
import type { EnrollmentTokenListed, FleetType, QuickDeployLink, QuickDeployLinkChoices } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { formatDateTime, formatDateTimeToTheSecond, formatRelativeTime } from "~/lib/format.js";
import { KUBERNETES_ROLE_LABELS } from "~/lib/kubernetes-groups.js";
import { INSTALL_LINKS_FAILED_MESSAGE, installLinkExtendable, installLinkStatus, type InstallLinksRead } from "~/lib/tokens.js";

/*
 * Install Links: the fleet's quick-deploy links on the Tokens tab between the
 * tokens and the History, newest first, 50 a page with "Load more"
 * (`useTokensTab`'s `links`, polled with the tab). Every member sees them.
 * Its details:
 *
 * - "Install links" and its words; no own refresh (the tab's "Refresh
 *   tokens" reads them too); a later failed read toasts "Failed to load
 *   install links" (the hook's), never the server's message.
 * - Columns: Created by (the member's email as text, "—" for none), Group
 *   (its name as text; "A deleted group" once gone), Install ("All In One
 *   (amd64)", "Own otelcol-contrib (arm64)", with " · systemd"), Created,
 *   Expires ("Never" or the date, not a link to Extend), Status, Downloads,
 *   Last downloaded (relative, "—" for never). No Token column (the
 *   platform stores only the secret's hash) and no Copy (the command is
 *   shown once, at its making).
 * - Status (`installLinkStatus`): Revoked, Expired, "Token revoked" (the
 *   default token the link's command carries is no longer valid among the
 *   tab's tokens: the download refuses it), "Group deleted" (its group is
 *   gone: the download refuses it for good) and Active, in that
 *   precedence. An archived fleet's live links read Active (unarchiving
 *   restores them).
 * - Actions: View (always; a deleted group's link shows "A deleted group"),
 *   Extend (`installLinkExtendable`: not on a revoked link, nor on any link
 *   whose default token isn't valid or whose group is deleted, an expired
 *   one included: extending it can't make it work) and Revoke (not on a
 *   revoked link), each named through `aria-labelledby` pointing at hidden
 *   text by the link's creation only, to the second so two links made in
 *   one minute read apart ("Extend the install link created Oct 9, 2026,
 *   7:58:30 AM"), never a group's name, a path or an email.
 * - States: "Loading install links…"; a failed first read "Failed to load
 *   install links" with "Try again" (the tab's reload); the empty state.
 *
 * A Kubernetes-supervisor fleet's: the same section, its Helm values links'
 * Install "Helm values", their Group by the link's role (Agent, Cluster, or
 * the gateway's name: the Agent's group is the fleet's Default group, which
 * only its role names), its help and empty hint in its words (a downloaded
 * values.yaml keeps the fleet's default token: only a new default token takes
 * it back).
 *
 * Privacy: no link here holds a secret, a hash or a value; the group's name
 * and the email are text in the masked shell only, never in an attribute;
 * the paths and the variables' names show only in View, inside
 * `ph-no-capture`.
 */

export const INSTALL_LINKS_TITLE = "Install links";
export const INSTALL_LINKS_HELP =
  "Quick Deploy links made when installing collectors. Revoke a link to stop further downloads; collectors already installed are unaffected.";
export const INSTALL_LINKS_EMPTY = "No install links for this fleet yet.";
export const INSTALL_LINKS_EMPTY_HINT = "Links appear here when you make a Quick Deploy command in the install dialog.";
/** A Kubernetes-supervisor fleet's words. */
export const KUBERNETES_INSTALL_LINKS_HELP =
  "Helm values links made when installing groups. Revoke a link to stop further downloads; a values.yaml already downloaded keeps the fleet's default token: issue a new default token to take it back.";
export const KUBERNETES_INSTALL_LINKS_EMPTY_HINT = "Links appear here when you make a Quick Deploy command in the Helm install dialog.";
/** A link whose group has been deleted (the list's `groupName` null). */
export const DELETED_GROUP = "A deleted group";

/** What a row's button asks for: the tab opens the dialog. */
export type InstallLinkAction = "viewLink" | "extendLink" | "revokeLink";

/**
 * A link's install in words: "All In One (amd64)", "Own otelcol-contrib (arm64)", with " · systemd" when it installs the
 * service; "Helm values" for a Helm values link.
 */
export function installWords(choices: QuickDeployLinkChoices): string {
  if (choices.kind === "helm") return "Helm values";
  const method = choices.method === "all-in-one" ? "All In One" : "Own otelcol-contrib";
  return `${method} (${choices.arch})${choices.systemd ? " · systemd" : ""}`;
}

/** A link named by its creation alone, to the second: "the install link created {date and time}". */
export function installLinkName(link: Pick<QuickDeployLink, "createdAt">): string {
  return `the install link created ${formatDateTimeToTheSecond(link.createdAt)}`;
}

/**
 * A link's group as the rows and View show it: its name, or DELETED_GROUP; a Helm values link's Agent and Cluster by
 * their role, a gateway by its name.
 */
export function groupWords(link: Pick<QuickDeployLink, "groupName" | "choices">): string {
  if (link.groupName === null) return DELETED_GROUP;
  if (link.choices.kind === "helm" && link.choices.role !== "gateway") return KUBERNETES_ROLE_LABELS[link.choices.role];
  return link.groupName;
}

const HEAD_CLASS =
  "h-9 whitespace-nowrap px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

export interface InstallLinksSectionProps {
  links: InstallLinksRead;
  /** The tab's tokens, as the same read gave them (a link whose token is revoked reads "Token revoked"); null while unread. */
  tokens: readonly EnrollmentTokenListed[] | null;
  /** The time the statuses are reckoned at: the tab's render. */
  now: number;
  /** A row's View, Extend or Revoke; `from` the button pressed, where the focus goes back as its dialog closes. */
  onAction: (action: InstallLinkAction, link: QuickDeployLink, from: HTMLElement) => void;
  /** "Try again" after a failed first read: the tab's reload. */
  onRetry: () => void;
  /** Each row's View by its link's id: where the focus goes when a dialog's opener is gone. */
  viewButtons: Map<string, HTMLButtonElement>;
  /** The first row's View: the fallback when the row's own is gone. */
  firstViewRef?: RefObject<HTMLButtonElement | null> | undefined;
  /** The fleet's type: a Kubernetes-supervisor fleet's help and empty hint are its own. */
  fleetType?: FleetType | undefined;
}

export function InstallLinksSection({
  links: read,
  tokens,
  now,
  onAction,
  onRetry,
  viewButtons,
  firstViewRef,
  fleetType = "server",
}: InstallLinksSectionProps) {
  const kubernetes = fleetType === "kubernetes-supervisor";
  const idPrefix = useId();
  const { links } = read;
  return (
    <section className="space-y-2">
      <div>
        <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{INSTALL_LINKS_TITLE}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{kubernetes ? KUBERNETES_INSTALL_LINKS_HELP : INSTALL_LINKS_HELP}</p>
      </div>
      {read.failed ? (
        <div className="flex items-center gap-3">
          <p className="text-[13px] text-muted-foreground">{INSTALL_LINKS_FAILED_MESSAGE}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : links === null ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          Loading install links…
        </p>
      ) : links.length === 0 ? (
        <div>
          <p className="text-[13px] text-muted-foreground">{INSTALL_LINKS_EMPTY}</p>
          <p className="text-xs text-muted-foreground">{kubernetes ? KUBERNETES_INSTALL_LINKS_EMPTY_HINT : INSTALL_LINKS_EMPTY_HINT}</p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="relative w-full overflow-auto">
              <table className="w-full caption-bottom text-[13px]">
                <thead className="[&_tr]:border-b">
                  <tr className={ROW_CLASS}>
                    <th className={HEAD_CLASS}>Created by</th>
                    <th className={HEAD_CLASS}>Group</th>
                    <th className={HEAD_CLASS}>Install</th>
                    <th className={HEAD_CLASS}>Created</th>
                    <th className={HEAD_CLASS}>Expires</th>
                    <th className={HEAD_CLASS}>Status</th>
                    <th className={HEAD_CLASS}>Downloads</th>
                    <th className={HEAD_CLASS}>Last downloaded</th>
                    <th className={HEAD_CLASS}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {links.map((link, index) => {
                    const rowId = `${idPrefix}-link-${link.id}`;
                    const status = installLinkStatus(link, tokens, now);
                    const name = installLinkName(link);
                    const extendable = installLinkExtendable(link, tokens, now);
                    return (
                      <tr key={link.id} className={ROW_CLASS}>
                        <td className={CELL_CLASS}>{link.createdBy === null ? "—" : link.createdBy.email}</td>
                        <td className={CELL_CLASS}>{groupWords(link)}</td>
                        <td className={CELL_CLASS}>{installWords(link.choices)}</td>
                        <td className={`${CELL_CLASS} font-mono text-xs tabular-nums`}>{formatDateTime(link.createdAt)}</td>
                        <td className={`${CELL_CLASS} font-mono text-xs tabular-nums`}>
                          {link.expiresAt === null ? "Never" : formatDateTime(link.expiresAt)}
                        </td>
                        <td className={CELL_CLASS}>
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </td>
                        <td className={`${CELL_CLASS} font-mono text-xs tabular-nums`}>{link.downloadCount}</td>
                        <td className={`${CELL_CLASS} text-xs`}>{formatRelativeTime(link.lastDownloadedAt, now)}</td>
                        <td className={CELL_CLASS}>
                          <div className="flex justify-end gap-1">
                            <span id={`${rowId}-view`} className="sr-only" hidden>
                              View {name}
                            </span>
                            <Button
                              ref={(element) => {
                                if (element === null) viewButtons.delete(link.id);
                                else viewButtons.set(link.id, element);
                                if (index === 0 && firstViewRef !== undefined) firstViewRef.current = element;
                              }}
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-labelledby={`${rowId}-view`}
                              onClick={(event) => onAction("viewLink", link, event.currentTarget)}
                            >
                              <Eye className="h-4 w-4" aria-hidden="true" />
                              View
                            </Button>
                            {extendable && (
                              <>
                                <span id={`${rowId}-extend`} className="sr-only" hidden>
                                  Extend {name}
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  aria-labelledby={`${rowId}-extend`}
                                  onClick={(event) => onAction("extendLink", link, event.currentTarget)}
                                >
                                  <CalendarPlus className="h-4 w-4" aria-hidden="true" />
                                  Extend
                                </Button>
                              </>
                            )}
                            {status.label !== "Revoked" && (
                              <>
                                <span id={`${rowId}-revoke`} className="sr-only" hidden>
                                  Revoke {name}
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="text-fail hover:bg-fail-soft hover:text-fail"
                                  aria-labelledby={`${rowId}-revoke`}
                                  onClick={(event) => onAction("revokeLink", link, event.currentTarget)}
                                >
                                  <ShieldOff className="h-4 w-4" aria-hidden="true" />
                                  Revoke
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
          {read.hasMore && (
            <Button type="button" variant="outline" size="sm" disabled={read.loadingMore} onClick={read.loadMore}>
              {read.loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
