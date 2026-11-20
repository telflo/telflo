import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { AlertCircle } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type { FleetDetail } from "@telflo/contracts";
import type { Route } from "./+types/fleet-management.$fleetId";
import { CollectorsTab } from "~/components/fleets/CollectorsTab.js";
import { FleetActionDialogs, useFleetActionDialogs } from "~/components/fleets/FleetActionDialogs.js";
import { FleetHeader, FleetNotFound, FleetsBackLink } from "~/components/fleets/FleetHeader.js";
import { GroupsTab } from "~/components/fleets/GroupsTab.js";
import { HelmInstallDialog } from "~/components/fleets/HelmInstallDialog.js";
import { InstallDialog } from "~/components/fleets/InstallDialog.js";
import { KubernetesGroupsTab } from "~/components/fleets/KubernetesGroupsTab.js";
import { SetupChecklist } from "~/components/fleets/SetupChecklist.js";
import { StatsStrip } from "~/components/fleets/StatsStrip.js";
import { TokensTab } from "~/components/fleets/TokensTab.js";
import { Button } from "~/components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs.js";
import { FLEET_LOAD_FAILED_MESSAGE, useFleet, type FleetRead } from "~/lib/fleets.js";
import { useReturnFocus } from "~/lib/hooks/use-return-focus.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * `/fleet-management/{fleetId}`, a fleet's page: one route for every type of
 * fleet.
 *
 * - The fleet is read through the browser client in an effect (`useFleet`,
 *   as the list), and read again every 15 s while the tab is visible and no
 *   dialog is open, so the header follows a rename or an archive made
 *   elsewhere. Nothing loads while the layout says the terms need
 *   accepting.
 * - "Fleet not found" (`FleetNotFound`) for a fleet the API answers 404, a
 *   fleet deleted while the page is open (a poll's 404), and an id that isn't
 *   a canonical UUID, which makes no request at all (it also keeps a decoded
 *   `..` off the API's paths).
 * - The header (`FleetHeader`): the back link, the label, its status and type,
 *   "Created {date}", and Rename, Archive or Unarchive, and Delete, an
 *   archived fleet's included. A rename or an archive reads the fleet again; a
 *   delete goes to the list, replacing the entry so Back doesn't land on
 *   "Fleet not found" (a 404 too, the fleet already gone); a delete whose
 *   outcome is unknown (a 503, its hang guard) reads the fleet again, "Fleet
 *   not found" once it finished. Each dialog's close gives the focus back to
 *   the header's button that opened it. When the page turns to "Fleet not
 *   found" (a rename's 404, a delete's unknown outcome then gone, a tab's
 *   fleet gone, a poll's 404) the focus lost with its content goes to the back
 *   link "Fleets", as does a dialog's close once its button is gone.
 * - The tabs Collectors (the default), Groups and Tokens, the chosen one in
 *   `?tab=` (`parseTab`): choosing Collectors deletes the param, the others
 *   set it, each pushed so Back moves between tabs; an unknown one is deleted
 *   once, replacing the entry. The tabs activate manually (arrow keys move the
 *   focus, Enter or Space chooses): Radix's automatic activation chose again
 *   on the focus a click gives, before the URL had changed, so one click
 *   navigated twice (two layout revalidations). A server fleet's Collectors
 *   tab is its collectors (`CollectorsTab`), its Groups tab its groups
 *   (`GroupsTab`) and its Tokens tab its tokens, their banner and history
 *   (`TokensTab`), each mounted only while chosen (Radix Tabs unmounts the
 *   others) and keyed by the fleet, which reads the fleet again after a write.
 *   A Kubernetes-supervisor fleet's are the same Collectors and Tokens tabs,
 *   told the fleet's type, and its own Groups tab (`KubernetesGroupsTab`: the
 *   Agent, the Cluster and the gateway pools).
 * - The stats strip (`StatsStrip`, every type's) between the header and the
 *   tabs, from the fleet's summary, which the page's poll keeps current; its
 *   Token tile links to the Tokens tab.
 * - Installing, an active fleet's only: the page owns one install dialog
 *   (`InstallDialog`; a Kubernetes-supervisor fleet's `HelmInstallDialog`:
 *   "Install with Helm" in the header and the empty tab, a row's Install, the
 *   Kubernetes checklist whose Assign chooses the Groups tab) and its focus,
 *   "install started" and the setup guide's state, all reset for another fleet
 *   (`FleetPage` is keyed by the fleet; nothing stored: "install started"
 *   lasts the visit), since Radix unmounts the tabs not chosen. The dialog
 *   opens from the header's "Install collector", the empty Collectors tab's
 *   and the checklist's "Install" (the Default group), and a group's row (its
 *   group); "install started" turns true on a reveal's or a download's
 *   success. The setup checklist (`SetupChecklist`) shows between the strip
 *   and the tabs while the fleet has no collectors, else while "Setup guide"
 *   has it open; hiding it puts the focus on "Setup guide". An assignment made
 *   in the dialog or the checklist has the Groups tab read its groups again,
 *   and a Groups tab's write the checklist. Each opener gets the focus back as
 *   the dialog closes, else the header's "Install collector", else the back
 *   link. An organization switch, or the fleet archived, closes the dialog.
 *
 * The title is fixed, never the fleet's label (posthog-js sends
 * `document.title` with every page view, and replay records `<head>`,
 * outside `ph-mask`). No attribute and no URL carries the label, the open
 * rename dialog's Name `value` excepted. The layout route supplies the
 * shell, and its terms dialog.
 *
 * The playground's fleet page (`playground.fleet-management.$fleetId.tsx`)
 * is this page on the sample: every install entry (the header's, the empty
 * tab's, the checklist's, a group row's) is locked at `openInstall`, the
 * sign-up prompt opening in place of the dialog.
 */

/** The sign-up prompt's words for installing, by the fleet's type, in the playground. */
export const INSTALL_LOCKED_WORDS: Record<FleetDetail["type"], string> = {
  server: "install collectors into your own fleet",
  "kubernetes-supervisor": "install collectors into your own cluster",
};

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Fleet - Telflo" }];
}

export const FLEET_TABS = ["collectors", "groups", "tokens"] as const;
export type FleetTab = (typeof FLEET_TABS)[number];

const TAB_LABELS: Record<FleetTab, string> = {
  collectors: "Collectors",
  groups: "Groups",
  tokens: "Tokens",
};

const TAB_PARAM = "tab";

function isFleetTab(value: string): value is FleetTab {
  return (FLEET_TABS as readonly string[]).includes(value);
}

/** The tab `?tab=` names: Groups or Tokens, else Collectors (absent, or a value no tab has). */
export function parseTab(raw: string | null): FleetTab {
  return raw !== null && isFleetTab(raw) ? raw : "collectors";
}

/** The page's tab, kept in `?tab=`. */
function useFleetTab(): [FleetTab, (tab: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(TAB_PARAM);

  // An unknown tab is dropped once, replacing the entry (Back doesn't return to it).
  useEffect(() => {
    if (raw === null || isFleetTab(raw)) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(TAB_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [raw, setSearchParams]);

  const choose = useCallback(
    (tab: string) => {
      if (!isFleetTab(tab)) return;
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        if (tab === "collectors") next.delete(TAB_PARAM);
        else next.set(TAB_PARAM, tab);
        return next;
      });
    },
    [setSearchParams],
  );

  return [parseTab(raw), choose];
}

export default function FleetRoute() {
  const { fleetId = "" } = useParams();
  const navigate = useNavigate();
  const organizationId = useCurrentUser()?.organization.id ?? "";
  const read = useFleet(fleetId);
  // The back link shown ("Fleets", the page's or "Fleet not found"'s): where the focus goes when what held it is gone.
  const backLink = useRef<HTMLAnchorElement>(null);
  const dialogs = useFleetActionDialogs(organizationId, () => backLink.current);

  // The fleet shown, then gone ("Fleet not found": a rename's 404, a delete's
  // unknown outcome then gone, a tab's onFleetGone, a poll's
  // 404): the focus, lost with the page's content, goes to the back link,
  // never left on the page; never from where the person has put it.
  const notFound = read.state === "not_found";
  const wasShown = useRef(false);
  useEffect(() => {
    if (notFound && wasShown.current) {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) backLink.current?.focus();
    }
    wasShown.current = read.fleet !== null;
  }, [notFound, read.fleet]);

  // Replacing the deleted fleet's entry: Back doesn't return to "Fleet not found".
  const toList = useCallback(() => void navigate("/fleet-management", { replace: true }), [navigate]);

  if (notFound) return <FleetNotFound backLinkRef={backLink} />;

  if (read.state === "failed") {
    return (
      <div className="px-5 py-4 space-y-5">
        <div>
          <FleetsBackLink />
        </div>
        <div className="flex flex-col items-center gap-2.5 rounded-lg border border-border bg-card p-12 text-center">
          <AlertCircle className="h-5 w-5 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">{FLEET_LOAD_FAILED_MESSAGE}</p>
          <Button variant="outline" onClick={read.reload}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (read.fleet === null) {
    // The fleet's loading state.
    return (
      <div className="p-6 flex items-center justify-center">
        <div
          role="status"
          aria-label="Loading fleet"
          className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground"
        />
      </div>
    );
  }

  return (
    <FleetPage
      key={read.fleet.id}
      fleet={read.fleet}
      read={read}
      organizationId={organizationId}
      dialogs={dialogs}
      backLink={backLink}
      onDeleted={toList}
    />
  );
}

/** The install dialog asked for: its group (null: the Default group), and the organization it was opened in. */
interface InstallTarget {
  groupId: string | null;
  organizationId: string;
}

interface FleetPageProps {
  fleet: FleetDetail;
  read: FleetRead;
  organizationId: string;
  dialogs: ReturnType<typeof useFleetActionDialogs>;
  backLink: RefObject<HTMLAnchorElement | null>;
  onDeleted: () => void;
}

/** One fleet's page, keyed by the fleet: its install state starts afresh for another. */
function FleetPage({ fleet, read, organizationId, dialogs, backLink, onDeleted }: FleetPageProps) {
  const [tab, chooseTab] = useFleetTab();
  const installable = fleet.status === "active";
  const hasCollectors = fleet.summary.collectors > 0;

  // "Install started" (this visit only) and the setup guide reopened.
  const [installStarted, setInstallStarted] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // Moved when the groups changed outside the Groups tab (the tab reads them again), or outside the checklist.
  const [groupsTabChanged, setGroupsTabChanged] = useState(0);
  const [checklistChanged, setChecklistChanged] = useState(0);

  // The install dialog, for the organization it was opened in: another organization, or the fleet archived, closes it.
  const installFocus = useReturnFocus();
  const headerInstall = useRef<HTMLButtonElement>(null);
  const guideToggle = useRef<HTMLButtonElement>(null);
  const [install, setInstall] = useState<InstallTarget | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  if (installOpen && (!installable || install?.organizationId !== organizationId)) setInstallOpen(false);
  const installFallback = () => headerInstall.current ?? backLink.current;
  const locked = useLockedAction();
  const openInstall = (groupId: string | null, from: HTMLElement) => {
    if (!installable || organizationId === "") return;
    if (locked !== null) {
      locked(INSTALL_LOCKED_WORDS[fleet.type], from);
      return;
    }
    installFocus.opened(from, installFallback);
    setInstall({ groupId, organizationId });
    setInstallOpen(true);
  };
  const installDefault = installable ? (from: HTMLElement) => openInstall(null, from) : undefined;

  const showChecklist = installable && (!hasCollectors || guideOpen);

  return (
    <div className="px-5 py-4 space-y-5">
      <div>
        <FleetsBackLink ref={backLink} />
      </div>

      <FleetHeader
        fleet={fleet}
        onAction={dialogs.openFor}
        onInstall={installDefault}
        installRef={headerInstall}
        setupGuide={installable && hasCollectors ? { open: guideOpen, onToggle: () => setGuideOpen((value) => !value), ref: guideToggle } : null}
      />

      <StatsStrip fleet={fleet} now={Date.now()} />

      {showChecklist && (
        <SetupChecklist
          fleet={fleet}
          installStarted={installStarted}
          onInstall={(from) => openInstall(null, from)}
          onGroupsTab={() => chooseTab("groups")}
          onDismiss={
            hasCollectors
              ? () => {
                  setGuideOpen(false);
                  guideToggle.current?.focus();
                }
              : undefined
          }
          groupsChanged={checklistChanged}
          onGroupsChanged={() => setGroupsTabChanged((value) => value + 1)}
          onFleetChanged={read.reload}
          fallback={installFallback}
        />
      )}

      <Tabs value={tab} onValueChange={chooseTab} activationMode="manual">
        <TabsList>
          {FLEET_TABS.map((each) => (
            <TabsTrigger key={each} value={each}>
              {TAB_LABELS[each]}
            </TabsTrigger>
          ))}
        </TabsList>
        {FLEET_TABS.map((each) => (
          <TabsContent key={each} value={each}>
            {each === "collectors" ? (
              <CollectorsTab
                key={fleet.id}
                fleet={fleet}
                installStarted={installStarted}
                onInstall={(from) => openInstall(null, from)}
                onFleetGone={read.reload}
                onFleetChanged={read.reload}
              />
            ) : each === "groups" && fleet.type === "kubernetes-supervisor" ? (
              <KubernetesGroupsTab
                key={fleet.id}
                fleet={fleet}
                onFleetGone={read.reload}
                onFleetChanged={() => {
                  read.reload();
                  setChecklistChanged((value) => value + 1);
                }}
                onInstall={installable ? (row, from) => openInstall(row.group?.id ?? null, from) : undefined}
                groupsChanged={groupsTabChanged}
              />
            ) : each === "groups" ? (
              <GroupsTab
                key={fleet.id}
                fleet={fleet}
                onFleetGone={read.reload}
                onFleetChanged={() => {
                  read.reload();
                  setChecklistChanged((value) => value + 1);
                }}
                onInstall={installable ? (group, from) => openInstall(group.id, from) : undefined}
                groupsChanged={groupsTabChanged}
              />
            ) : (
              <TokensTab
                key={fleet.id}
                fleet={fleet}
                fleetRead={read.fleetRead}
                latestFleetRead={read.latestRead}
                onFleetGone={read.reload}
                onFleetChanged={read.reload}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>

      <FleetActionDialogs
        target={dialogs.target}
        open={dialogs.open}
        onOpenChange={dialogs.setOpen}
        organizationId={organizationId}
        onChanged={read.reload}
        onDeleted={onDeleted}
        onDeleteUnknown={read.reload}
        onCloseAutoFocus={dialogs.returnFocus}
      />
      {fleet.type === "kubernetes-supervisor" && (
        <HelmInstallDialog
          open={installOpen}
          onOpenChange={setInstallOpen}
          organizationId={install?.organizationId ?? ""}
          fleetId={fleet.id}
          groupId={install?.groupId ?? null}
          onInstallStarted={() => setInstallStarted(true)}
          onFleetChanged={read.reload}
          onGroupsChanged={() => {
            setGroupsTabChanged((value) => value + 1);
            setChecklistChanged((value) => value + 1);
            read.reload();
          }}
          onCloseAutoFocus={installFocus.returnFocus}
        />
      )}
      {fleet.type === "server" && (
        <InstallDialog
          open={installOpen}
          onOpenChange={setInstallOpen}
          organizationId={install?.organizationId ?? ""}
          fleetId={fleet.id}
          groupId={install?.groupId ?? null}
          onInstallStarted={() => setInstallStarted(true)}
          onFleetChanged={read.reload}
          onGroupsChanged={() => {
            setGroupsTabChanged((value) => value + 1);
            setChecklistChanged((value) => value + 1);
            read.reload();
          }}
          onCloseAutoFocus={installFocus.returnFocus}
        />
      )}
    </div>
  );
}
