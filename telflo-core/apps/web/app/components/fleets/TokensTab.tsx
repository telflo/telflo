import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, KeyRound, RefreshCw } from "lucide-react";
import type { EnrollmentTokenListed, FleetDetail, QuickDeployLink } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { useReturnFocus } from "~/lib/hooks/use-return-focus.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { tokenValidAt, TOKENS_LOAD_FAILED_MESSAGE, useTokensTab } from "~/lib/tokens.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { ExtendInstallLinkDialog } from "./ExtendInstallLinkDialog.js";
import { InstallLinkDialog } from "./InstallLinkDialog.js";
import { InstallLinksSection, type InstallLinkAction } from "./InstallLinksSection.js";
import { NewDefaultTokenDialog } from "./NewDefaultTokenDialog.js";
import { RevealTokenDialog } from "./RevealTokenDialog.js";
import { RevokeInstallLinkDialog } from "./RevokeInstallLinkDialog.js";
import { RevokeTokenDialog } from "./RevokeTokenDialog.js";
import { RotateTokenDialog } from "./RotateTokenDialog.js";
import { TokenBanner } from "./TokenBanner.js";
import { TokenHistory } from "./TokenHistory.js";
import { TokensTable, type TokenRowAction } from "./TokensTable.js";

/*
 * A server fleet's Tokens tab (D17b-2 decisions 9–13, 22, 26–34; Preflight
 * rulings 4, 6, 8, 10 and 12–15): its heading, help, refresh and "Rotate
 * token" over its table, with the rotate-before-expiry banner above the
 * table, and the install links (D17c-2 decision 31) and the token history
 * beneath it, over `useTokensTab` (the fleet's tokens, the history's and the
 * links' first pages, polled every 15 s while the tab is visible and no
 * dialog is open). Mounted only while the tab is chosen (Radix Tabs unmounts
 * the others), keyed by the fleet. Per the D17b-2 Parity Notes:
 *
 * - "Fleet tokens" and its help in the spec's words (both kinds, the 10
 *   seconds); a refresh button ("Refresh tokens", spinning while a
 *   person's read is under way, reading the tokens, the history and the
 *   install links from the top).
 * - "Rotate token" is disabled on an archived fleet, with its reason as text
 *   beside it, describing it (`aria-describedby`; Preflight ruling 8: the
 *   only write an archived fleet refuses; reveal and revoke stay).
 * - "New default token" (D17c-1 decision 45; Preflight ruling 31) beside it,
 *   once the tokens are read and none of them is a valid default token (a
 *   revoked default token can be followed by a new one), opening
 *   `NewDefaultTokenDialog`; disabled on an archived fleet, whose one
 *   sentence then says both buttons' reason and describes both. It and the
 *   revoke are told the fleet's type: a Kubernetes-supervisor fleet's words
 *   name its groups' Helm releases, not hosts' install commands (D17d-1
 *   Ruling 55).
 * - States: "Loading tokens…"; a failed first load ("Failed to load
 *   tokens") with "Try again"; never empty (a fleet always has its default
 *   token). The history and the install links fail apart from the tokens.
 * - "Rotate token" (the header's or the banner's) opens the rotate dialog,
 *   "New default token" its dialog, a row's Reveal the reveal and its
 *   Revoke the revoke; an install link's View, Extend and Revoke their
 *   dialogs (D17c-2 Preflight rulings 23 and 24), each given the row's link
 *   as the opening found it. One dialog at a time, for the organization it
 *   was opened in: another organization closes it, and its late answer is
 *   dropped.
 * - After a write (a rotation, a new default token, any reveal, a revoke),
 *   a 404 or an unknown outcome the tab reads its tokens and history again
 *   and the route its fleet (`onFleetChanged`: the strip and the banner
 *   follow). An install link's write (an extend, a revoke, or their 404 or
 *   unknown outcome) reads the tab again only: the fleet is unchanged.
 *
 * Every dialog's close gives the focus back to the control that opened it
 * (`useReturnFocus`, Preflight ruling 14): the row's Reveal or Revoke, the
 * header's "Rotate token" or "New default token", or the banner's. When that
 * control is gone (a revoked token's row has no actions, a rotation takes
 * the banner away, a new default token takes its button away) or
 * disabled, the focus goes to the first row action, else to "Refresh
 * tokens". An install link's dialog gives it back to the row's View when
 * its opener is gone (a revoke takes the row's Extend and Revoke away; the
 * row stays), else the first row's View, else "Refresh tokens" (Preflight
 * ruling 23). A write's reload that removes the button the focus went back to
 * moves it on the same way; rows from a read begun before the write leave
 * that to the reload. The fleet the route gives is such a read too (D17b-1
 * Ruling 42's rule; Rulings 25 and 28): the banner and the header's "Rotate
 * token" follow the fleet's read, which may answer after the tokens' (and
 * after the close). A write records the route's latest fleet read begun
 * (`latestFleetRead`) before the fleet's reload begins; the first fleet
 * given from a read numbered above it (`fleetRead`) spends the write. If
 * the close has happened and that fleet has taken away, or disabled, the
 * button the focus went back to, while the focus is lost (on the body, gone,
 * or on that disabled button), it moves the focus on to the fallback; before
 * the close it only spends (the close's own return sees the page as it
 * is). A fleet from an older read (it may still hold the banner the write
 * takes away) moves nothing and spends nothing, and once spent no later
 * fleet (a poll's) moves anything.
 *
 * Privacy (decisions 12 and 34): bearers only in the reveal's, the
 * rotation's and the new default token's `SecretCopyBox`, inside
 * `ph-no-capture`, in dialog state only;
 * the history's emails text in the masked shell; no attribute holds a
 * bearer, a fleet's label or an email. Install links (D17c-2 decision 32):
 * no secret or value anywhere; a group's name and an email text in the
 * masked shell, the paths and the variables' names only in View, inside
 * `ph-no-capture`; no attribute holds any of them.
 *
 * A Kubernetes-supervisor fleet's tab (D17d-1 decision 26) is the same,
 * Install links included (D17d-2 decision 22: its Helm values links, in its
 * words).
 */

export const TOKENS_HELP =
  "Collectors enroll with the fleet's default token and, if they accept connection settings, are then handed its current rotate token. Rotate to replace the rotate token with a grace period; revoke a token to refuse it within 10 seconds.";

export const ARCHIVED_ROTATE = "An archived fleet's tokens can't be rotated: unarchive it first.";

/** ARCHIVED_ROTATE's place while "New default token" shows too (D17c-1 Preflight ruling 31). */
export const ARCHIVED_ROTATE_AND_DEFAULT =
  "An archived fleet's tokens can't be rotated, and it can't be given a new default token: unarchive it first.";

interface TokensTabProps {
  fleet: FleetDetail;
  /** The number of the route's read `fleet` came from (`useFleet().fleetRead`). */
  fleetRead: number;
  /** The route's latest fleet read begun (`useFleet().latestRead`): a write takes it before the fleet's reload begins. */
  latestFleetRead: () => number;
  /** The route's `useFleet().reload`: a tokens read that finds the fleet gone shows "Fleet not found". */
  onFleetGone: () => void;
  /** The route's `useFleet().reload` again: after a token's write, the strip and the banner follow. */
  onFleetChanged: () => void;
}

/**
 * The dialog asked for, its token (null for a rotation, a new default token
 * or an install link's dialog), its install link (null but for a link's
 * dialog: the row's, as the opening found it), and the organization it was
 * opened in.
 */
interface TokenAction {
  kind: TokenRowAction | "rotate" | "newDefault" | InstallLinkAction;
  token: EnrollmentTokenListed | null;
  link: QuickDeployLink | null;
  organizationId: string;
}

/**
 * The fleet's side of the latest dialog's write (Ruling 28): the route's
 * latest fleet read begun as the write's reload was about to begin (null
 * with no write, or once a fleet has spent it), whether the dialog has
 * closed since it opened, and where its close put the focus (null for
 * nowhere).
 */
interface FleetWrite {
  writtenAfter: number | null;
  closed: boolean;
  returnedTo: HTMLElement | null;
}

const NO_FLEET_WRITE: FleetWrite = { writtenAfter: null, closed: false, returnedTo: null };

/** The sign-up prompt's words for each token and install link action in the playground. */
export const TOKEN_LOCKED_WORDS: Record<Exclude<TokenAction["kind"], "viewLink">, string> = {
  rotate: "rotate a fleet's token",
  newDefault: "make a new default token",
  reveal: "reveal a fleet token",
  revoke: "revoke a fleet token",
  extendLink: "extend an install link",
  revokeLink: "revoke install links",
};

export function TokensTab({ fleet, fleetRead, latestFleetRead, onFleetGone, onFleetChanged }: TokensTabProps) {
  const tab = useTokensTab(fleet.id, { onFleetGone });
  const { tokens, rowsRead } = tab;
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const archived = fleet.status === "archived";
  // The archived fleet's reason, describing each disabled button it names (Ruling 61's nit).
  const archivedReasonId = useId();
  const now = Date.now();
  // "New default token" once the tokens are read and none is a valid default token.
  const offersNewDefault = tokens !== null && !tokens.some((token) => token.kind === "default" && tokenValidAt(token, now));

  // Focus back to each dialog's opener, else the first row action, else Refresh (Preflight ruling 14).
  const focus = useReturnFocus();
  const firstAction = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const fallback = () => firstAction.current ?? refreshButton.current;
  // Each install link's View by the link's id, and the first row's (Preflight ruling 23).
  const viewButtons = useRef(new Map<string, HTMLButtonElement>());
  const firstView = useRef<HTMLButtonElement>(null);
  /** An install link's dialog's fallback: the row's View, else the first row's, else Refresh. */
  const linkFallback = (linkId: string) => () =>
    [viewButtons.current.get(linkId), firstView.current, refreshButton.current].find(
      (each): each is HTMLButtonElement => each !== undefined && each !== null && each.isConnected && !each.matches(":disabled"),
    ) ?? null;
  // The rows with their read's number: rows from a read begun before a write never spend it before the close.
  useEffect(() => focus.rowsChanged(rowsRead), [tokens, tab.links.links, rowsRead, focus]);
  // The fleet's side of a write (Ruling 28): spent by the first fleet from a read begun after it.
  const fleetWrite = useRef<FleetWrite>(NO_FLEET_WRITE);
  const returnFocus = (event: Event) => {
    focus.returnFocus(event);
    const active = document.activeElement;
    fleetWrite.current = {
      ...fleetWrite.current,
      closed: true,
      returnedTo: active instanceof HTMLElement && active !== document.body ? active : null,
    };
  };
  useEffect(() => {
    const write = fleetWrite.current;
    // No write behind this fleet, or a fleet from a read begun before it (it may still hold the
    // banner the write takes away): nothing moved, and the write left for the fleet's reload.
    if (write.writtenAfter === null || fleetRead <= write.writtenAfter) return;
    // From a read begun after the write: spent here, so no later fleet (a poll's) acts on it.
    fleetWrite.current = { ...write, writtenAfter: null };
    // Before the close: the close's own return sees the page as this fleet left it.
    if (!write.closed) return;
    const { returnedTo } = write;
    if (returnedTo === null || (returnedTo.isConnected && !returnedTo.matches(":disabled"))) return;
    // Only a lost focus moves: on the body, gone, or still on the button this fleet disabled.
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected && active !== returnedTo) return;
    const to = fallback();
    if (to !== null && to.isConnected && !to.matches(":disabled")) to.focus();
    // Run for each fleet read given (`fallback` reads refs only).
  }, [fleetRead]);

  // The dialog open, in the organization it was opened in; another organization closes it.
  const [action, setAction] = useState<TokenAction | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  if (actionOpen && action !== null && action.organizationId !== organizationId) setActionOpen(false);
  const locked = useLockedAction();
  const openAction = (kind: TokenAction["kind"], token: EnrollmentTokenListed | null, from: HTMLElement, link: QuickDeployLink | null = null) => {
    if (organizationId === null) return;
    // In the playground (D31-1 decisions 24 and 35) an install link's View opens (a read, no request); every token
    // and link write is locked here, the banner's "Rotate token" with them.
    if (locked !== null && kind !== "viewLink") {
      locked(TOKEN_LOCKED_WORDS[kind], from);
      return;
    }
    focus.opened(from, link === null ? fallback : linkFallback(link.id));
    fleetWrite.current = NO_FLEET_WRITE;
    setAction({ kind, token, link, organizationId });
    setActionOpen(true);
  };

  // A write (or a 404, or an unknown outcome): its reloads (the tokens' and the fleet's) may take the button the
  // focus went back to. Each side's latest read is taken before its reload begins: the reload's, and any later
  // read's, are numbered above it.
  const changed = () => {
    focus.wrote(tab.latestRead());
    fleetWrite.current = { ...fleetWrite.current, writtenAfter: latestFleetRead() };
    tab.reload();
    onFleetChanged();
  };

  // An install link's write (or its 404, or an unknown outcome): the tab's reload only, the fleet unchanged (Preflight ruling 23).
  const linkChanged = () => {
    focus.wrote(tab.latestRead());
    tab.reload();
  };

  const kind = actionOpen ? action?.kind : undefined;
  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Fleet tokens</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{TOKENS_HELP}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {archived && (
            <p id={archivedReasonId} className="max-w-56 text-xs text-muted-foreground">
              {offersNewDefault ? ARCHIVED_ROTATE_AND_DEFAULT : ARCHIVED_ROTATE}
            </p>
          )}
          <Button
            ref={refreshButton}
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={tab.reload}
            aria-label="Refresh tokens"
          >
            <RefreshCw className={`h-4 w-4 ${tab.personsRead ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
          {offersNewDefault && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={archived}
              aria-describedby={archived ? archivedReasonId : undefined}
              onClick={(event) => openAction("newDefault", null, event.currentTarget)}
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              New default token
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={archived}
            aria-describedby={archived ? archivedReasonId : undefined}
            onClick={(event) => openAction("rotate", null, event.currentTarget)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Rotate token
          </Button>
        </div>
      </div>

      <TokenBanner
        fleet={fleet}
        now={now}
        defaultTokenValid={tokens === null ? null : !offersNewDefault}
        onRotate={(from) => openAction("rotate", null, from)}
      />

      {tab.failed ? (
        <div className="flex flex-col items-center gap-2.5 rounded-lg border border-border bg-card p-12 text-center">
          <AlertCircle className="h-5 w-5 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">{TOKENS_LOAD_FAILED_MESSAGE}</p>
          <Button variant="outline" onClick={tab.reload}>
            Try again
          </Button>
        </div>
      ) : tokens === null ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading tokens…
          </p>
        </div>
      ) : (
        <TokensTable tokens={tokens} now={now} firstActionRef={firstAction} onAction={(each, token, from) => openAction(each, token, from)} />
      )}

      <InstallLinksSection
        links={tab.links}
        tokens={tokens}
        now={now}
        viewButtons={viewButtons.current}
        firstViewRef={firstView}
        onRetry={tab.reload}
        onAction={(each, link, from) => openAction(each, null, from, link)}
        fleetType={fleet.type}
      />

      <TokenHistory history={tab.history} tokens={tokens} onRetry={tab.reload} />

      {/* Each dialog takes the current organization: an answer for an earlier one is dropped (useStillCurrent). */}
      <RotateTokenDialog
        open={kind === "rotate"}
        onOpenChange={setActionOpen}
        rotateToken={fleet.summary.rotateToken}
        tokens={tokens}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        onChanged={changed}
        onCloseAutoFocus={returnFocus}
      />
      <NewDefaultTokenDialog
        open={kind === "newDefault"}
        onOpenChange={setActionOpen}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        fleetType={fleet.type}
        onChanged={changed}
        onCloseAutoFocus={returnFocus}
      />
      <RevealTokenDialog
        open={kind === "reveal"}
        onOpenChange={setActionOpen}
        token={action?.kind === "reveal" ? action.token : null}
        archived={archived}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        onChanged={changed}
        onCloseAutoFocus={returnFocus}
      />
      <RevokeTokenDialog
        open={kind === "revoke"}
        onOpenChange={setActionOpen}
        token={action?.kind === "revoke" ? action.token : null}
        tokens={tokens ?? []}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        fleetType={fleet.type}
        onRevoked={changed}
        onCloseAutoFocus={returnFocus}
      />
      <InstallLinkDialog
        open={kind === "viewLink"}
        onOpenChange={setActionOpen}
        link={action?.kind === "viewLink" ? action.link : null}
        onCloseAutoFocus={returnFocus}
      />
      <ExtendInstallLinkDialog
        open={kind === "extendLink"}
        onOpenChange={setActionOpen}
        link={action?.kind === "extendLink" ? action.link : null}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        onChanged={linkChanged}
        onCloseAutoFocus={returnFocus}
      />
      <RevokeInstallLinkDialog
        open={kind === "revokeLink"}
        onOpenChange={setActionOpen}
        link={action?.kind === "revokeLink" ? action.link : null}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        onRevoked={linkChanged}
        onCloseAutoFocus={returnFocus}
      />
    </section>
  );
}
