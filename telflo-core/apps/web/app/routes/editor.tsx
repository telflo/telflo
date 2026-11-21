import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { Code, FlaskConical, Settings } from "lucide-react";
import { toast } from "sonner";
import type { ConfigurationErrorCode } from "@telflo/contracts";
import type { Route } from "./+types/editor";
import type { AppLayoutData } from "./app-layout.js";
import { EditorLayout, type EditorPanelTab } from "~/components/editor/EditorLayout.js";
import { EditorToolbar } from "~/components/editor/EditorToolbar.js";
import { EditorUnavailable } from "~/components/editor/EditorUnavailable.js";
import { PublishedVersionBanner } from "~/components/editor/PublishedVersionBanner.js";
import { UnsavedChangesDialog } from "~/components/editor/UnsavedChangesDialog.js";
import { YamlEditor } from "~/components/editor/YamlEditor.js";
import { Canvas } from "~/components/editor/builder/Canvas.js";
import { CanvasActions } from "~/components/editor/builder/CanvasActions.js";
import { CollapsibleToolbox } from "~/components/editor/builder/CollapsibleToolbox.js";
import { ConfigurationPanel } from "~/components/editor/builder/ConfigurationPanel.js";
import { TestingTab } from "~/components/editor/test-runs/TestingTab.js";
import { isTourCompleted, startEditorTour } from "~/components/editor/builder/tour/start-editor-tour.js";
import {
  ApiError,
  getConfiguration,
  getConfigurationVersion,
  isSessionEnded,
  selectConfigurationVersion,
} from "~/lib/api-client.js";
import {
  LOAD_FAILED_MESSAGE,
  isConfigurationGone,
  isOrganizationGone,
  isTermsAcceptanceRequired,
} from "~/lib/configurations.js";
import { isSaveShortcut, useUnloadGuard } from "~/lib/editor/unsaved-guard.js";
import { useCollectorValidation } from "~/lib/editor/use-collector-validation.js";
import { useNavigationGuard } from "~/lib/editor/use-navigation-guard.js";
import { useSaveConfiguration } from "~/lib/editor/use-save-configuration.js";
import { isCanonicalUuid } from "~/lib/ids.js";
import { useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";
import { selectIsCanvasLocked, selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * `/editor/{id}/{versionId}`: the editor page, with its title, its loading
 * state and its composed layout. Its rules:
 * - the version is in the address, one route, so the page stays mounted
 *   while its version changes. `/editor/{id}` opens the version the API
 *   answers (the person's selection, else the newest) and replaces the
 *   address with that version's; the configurations list links there. Every
 *   version the page settles on is recorded as the person's selection, best
 *   effort: a failure says nothing and changes nothing;
 * - the builder: the toolbox, the canvas with its actions, and the panel's
 *   Configuration and YAML tabs, in that order. Selecting a node or a pipeline
 *   group switches to Configuration; the tab is disabled while the canvas is
 *   locked (manual edit mode, or text it can't show). The canvas, the tabs and
 *   the toolbar share the editor's store, not props;
 * - the configuration and its version are fetched through the browser client
 *   in an effect, never in a server loader, and Monaco renders only in the
 *   browser;
 * - an unknown configuration shows "Configuration not found", never the
 *   previous one left on screen; so does an id that isn't a UUID, with no
 *   request (React Router decodes the parameter, so `..` would reach another
 *   API path). An unknown version, or a version id that isn't a UUID (with
 *   no request), shows "Version not found" with "Open the latest version". A
 *   load that fails otherwise toasts "Failed to load configuration", says so
 *   in the page, and offers "Try again"; a 401 `unauthenticated` only says
 *   so in the page: the session-ended handler, or Logout, is taking the
 *   browser to `/login`;
 * - Cmd/Ctrl+S saves outside Monaco too, and the browser's own save dialog
 *   never opens here;
 * - unsaved text is guarded: leaving by navigation opens the Unsaved Changes
 *   dialog (useNavigationGuard), and closing or reloading the tab asks the
 *   browser's own question. The sidebar refuses switching organization and
 *   signing out meanwhile;
 * - the tour starts once, the first time, and only once the configuration
 *   has loaded, so it never picks the empty canvas's steps for a full one;
 * - a published version is read-only, with the banner above the canvas. Its
 *   Configuration tab still opens, its forms disabled, so a node can be
 *   inspected; the tab is disabled only by the canvas's own lock. A
 *   published version is never dirty, so the guards never ask, except over
 *   text a stale tab typed before a teammate published it, which is unsaved
 *   work: leaving still asks, and "Save & Continue" says the version is
 *   published and stays.
 * - the collector catalog is read once, when the page mounts, for the
 *   toolbar's collector picker; until it answers, or if it can't, the picker
 *   shows the pin as text.
 * - the open version's text is checked by the collector validator while the
 *   page is mounted (`useCollectorValidation`): at once when a version
 *   opens or the pin changes, 2 s after the text changes.
 * - the panel's third tab, Testing, kept mounted, is disabled with
 *   Configuration: in manual edit mode and while the canvas can't show
 *   the text.
 * The layout route supplies the shell. No attribute here carries the name,
 * the YAML, a label or an email: they are text, which replay masks.
 */

const CONFIGURATION_VERSION_NOT_FOUND: ConfigurationErrorCode = "configuration_version_not_found";

type LoadStatus = "loading" | "loaded" | "not_found" | "version_not_found" | "failed";

/**
 * The version the page has settled on: its configuration and itself, as the
 * API names them, and the organization it was loaded in.
 */
interface Settled {
  configurationId: string;
  versionId: string;
  organizationId: string;
}

/**
 * The layout revalidation a clean editor asks for before it reloads: the
 * organization the configuration was loaded in, the active organization it
 * saw (a different one), and the organization the answer gave, null until the
 * answer is here.
 */
interface OrganizationCheck {
  loadedIn: string;
  seen: string;
  answer: string | null;
}

/**
 * A created version the store took on while the address still named the
 * version settled on (`adoptCreatedVersion` runs before its push), and the
 * history entry the page was on then.
 */
interface Adoption {
  versionId: string;
  entry: string;
}

/** The same id, in either case: an address may spell a UUID in upper case, and the API answers in lower. */
function sameId(one: string | null | undefined, other: string | null | undefined): boolean {
  return one != null && other != null && one.toLowerCase() === other.toLowerCase();
}

/** Whether `adoption` records `versionId` adopted on the history entry `entry`. */
function adoptedOn(adoption: Adoption | null, versionId: string, entry: string): boolean {
  return adoption !== null && sameId(adoption.versionId, versionId) && adoption.entry === entry;
}

/** Whether a load found no such version of the configuration. */
function isVersionGone(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONFIGURATION_VERSION_NOT_FOUND;
}

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Edit Configuration - Telflo" },
    { name: "description", content: "Visual editor for OpenTelemetry Collector configurations" },
  ];
}

export default function EditorPage() {
  const { configurationId = "", versionId } = useParams();
  /** The history entry: a new one, even at the same address, is another navigation. */
  const { key: entry } = useLocation();
  const navigate = useNavigate();
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const layoutData = useRouteLoaderData<AppLayoutData>("routes/app-layout");
  const termsRequired = layoutData?.status === "signed_in" && layoutData.currentUser.termsAcceptanceRequired;
  const { revalidate } = useRevalidator();
  const save = useSaveConfiguration();
  const guard = useNavigationGuard(save);
  // The toolbar's collector picker reads it from its store.
  useCollectorDistributions();
  // The collector validator checks the open version's text, for the YAML
  // tab's bar and Apply and the canvas's chip.
  useCollectorValidation();
  const isDirty = useEditorStore(selectIsDirty);
  const isCanvasLocked = useEditorStore(selectIsCanvasLocked);
  const selectedNodeId = useEditorStore((state) => state.selectedNode?.id ?? null);
  const heldConfigurationId = useEditorStore((state) => state.configuration?.id ?? null);
  const heldVersionId = useEditorStore((state) => state.version?.id ?? null);
  const isWellFormed = isCanonicalUuid(configurationId);
  const isVersionWellFormed = versionId === undefined || isCanonicalUuid(versionId);
  /** The address as typed: what a load's outcome is for. */
  const address = `${configurationId}/${versionId ?? ""}`;

  /**
   * A load under way, or one that ended without a version to show, for the
   * address it was for; null once a load has put its version in the store,
   * whose holding the address then decides.
   */
  const [outcome, setOutcome] = useState<{ address: string; status: Exclude<LoadStatus, "loaded"> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  /**
   * The version the page has settled on, and the organization it was loaded
   * in; null while a load is under way. Only the latest load's answer is
   * used, as in the list. The ref is the load's to read and write; the state
   * mirrors it for rendering and for the selection.
   */
  const settled = useRef<Settled | null>(null);
  const [settledOn, setSettledOn] = useState<Settled | null>(null);
  const settle = useCallback((next: Settled | null) => {
    settled.current = next;
    setSettledOn(next);
  }, []);
  const latestLoad = useRef(0);
  /** The version `/editor/{id}` is being replaced with, until the address names one. */
  const replacingWith = useRef<string | null>(null);
  /** The selection last recorded, so each settled version is recorded once. */
  const recordedSelection = useRef<string | null>(null);
  /**
   * The created version adopted while the address names the version settled
   * on, and the history entry it was adopted on, recorded the first time the
   * page sees it. The ref is the load's; the state mirrors it for rendering.
   */
  const adoption = useRef<Adoption | null>(null);
  const [adoptionShown, setAdoptionShown] = useState<Adoption | null>(null);
  /** The revalidation asked for before reloading, if any; `checkAnswered` counts its answers, to load again. */
  const organizationCheck = useRef<OrganizationCheck | null>(null);
  const [checkAnswered, setCheckAnswered] = useState(0);

  // Leaving the page, or opening another configuration, forgets the one
  // open: nothing stale reaches the next page, or the next configuration's
  // first render, and a page elsewhere (the sidebar's switch and Logout)
  // never sees a dirty editor that isn't there. Declared before the load, so
  // on a new id it runs first. Another version of the same configuration is
  // the load's to forget (below): this would empty the store on the
  // address's replace.
  useEffect(
    () => () => {
      settle(null);
      replacingWith.current = null;
      organizationCheck.current = null;
      useEditorStore.getState().reset();
    },
    [configurationId, settle],
  );

  // The layout's first answer after the page asked for a revalidation before
  // reloading: the organization it gives decides (the load below). Declared
  // before the load, so an answer that lands as the page asks is older than
  // the question and never taken for its answer.
  useEffect(() => {
    const check = organizationCheck.current;
    if (check === null || check.answer !== null || layoutData?.status !== "signed_in") return;
    check.answer = layoutData.currentUser.organization.id;
    setCheckAnswered((count) => count + 1);
  }, [layoutData]);

  // A create's adoption, recorded with the history entry it happened on, the
  // first time the page sees the store hold a version other than the one
  // settled on (only an adoption does that: a load settles on its version).
  // Declared before the load, so the load sees it in the same commit.
  useEffect(() => {
    const before = settled.current;
    if (before === null || heldVersionId === null || sameId(heldVersionId, before.versionId)) return;
    if (adoption.current !== null && sameId(adoption.current.versionId, heldVersionId)) return;
    adoption.current = { versionId: heldVersionId, entry };
    setAdoptionShown(adoption.current);
  }, [heldVersionId, entry]);

  /*
   * Loads the version the address names, for the active organization
   * (`useCurrentUser()`'s, since a switch or removal elsewhere changes it
   * without a remount): `getConfigurationVersion` for
   * `/editor/{id}/{versionId}`; for `/editor/{id}`, `getConfiguration`, whose
   * version then replaces the address, keeping the configuration's id as typed
   * (a change of its case would be another configuration to the effect above).
   *
   * The layout revalidates on every navigation (`shouldRevalidate`), so the
   * address changes with renders between, and the page never fetches what
   * it already holds. It holds the address when it has settled on that
   * configuration and:
   * - the address names no version while its own replace is under way;
   * - the address names the version settled on: the one loaded, or the one
   *   a create left behind (`adoptCreatedVersion` runs before its push, so
   *   for a while the store holds the created version and the address
   *   still names the source; that is never fetched). The second holds only
   *   on the history entry the create was adopted on: a later entry naming
   *   the source (the picker's choice of it while the push waits, which
   *   abandons the push) fetches the source;
   * - the address names the version the store holds, in the same
   *   configuration and organization: a create's push has landed, and the
   *   page settles on the created version.
   * Anything else is fetched, and a version held until then goes first, as
   * another configuration's does above: the undo history, manual edit mode
   * and the selection with it.
   *
   * It loads again what it holds only when the active organization isn't the
   * one it was loaded in and the editor is clean: a loaded version with
   * unsaved text is never reloaded over, and its saves still name the
   * organization it was loaded in, which the API then refuses, keeping the
   * text. The check runs again when the editor becomes clean (`isDirty` is a
   * dependency for that, and for a create's adoption), so an organization
   * changed while it was dirty loads then; one switched back to meanwhile
   * loads nothing.
   *
   * Before reloading, the page asks the layout for the session's organization
   * again, once for each difference it sees while clean, keeping the editor
   * on screen: this tab's `/me` can be older than a switch made in another
   * tab since (a save refused as another organization's, then a switch back
   * there, and the save that follows succeeds). It reloads only when the
   * answer still differs from the organization the configuration was loaded
   * in, and in the answer's organization; an answer that the session is back
   * there loads nothing. Text typed meanwhile forgets the question, and
   * nothing loads over it; once clean again, the page asks again.
   *
   * Nothing is asked for while the layout's `/me` says the current terms need
   * accepting; the load goes once the dialog's revalidation says they are.
   * The flag never reloads a version already settled on. A 404
   * `organization_not_found` or a 403 `terms_acceptance_required` revalidates
   * the layout, with no toast, and the page loads again for its answer.
   */
  useEffect(() => {
    if (!isWellFormed || organizationId === null) return;
    if (!isVersionWellFormed) {
      // Nothing to ask for: what was open goes, as for an unknown version.
      replacingWith.current = null;
      settle(null);
      useEditorStore.getState().reset();
      return;
    }
    if (versionId !== undefined) replacingWith.current = null;
    const before = settled.current;
    const held = useEditorStore.getState();
    const holds =
      before !== null &&
      sameId(before.configurationId, configurationId) &&
      (versionId === undefined
        ? replacingWith.current !== null
        : (sameId(versionId, before.versionId) &&
            (sameId(held.version?.id, before.versionId) ||
              (held.version !== null && adoptedOn(adoption.current, held.version.id, entry)))) ||
          (sameId(versionId, held.version?.id) &&
            sameId(held.configuration?.id, configurationId) &&
            held.organizationId === before.organizationId));
    if (holds) {
      // A create's push has landed: the created version is the one settled on now.
      if (held.version !== null && sameId(versionId, held.version.id) && !sameId(versionId, before.versionId)) {
        settle({ ...before, versionId: held.version.id });
      }
      const check = organizationCheck.current;
      if (before.organizationId === organizationId) {
        organizationCheck.current = null;
        return;
      }
      // The store's, not the render's: never load over text typed since.
      if (selectIsDirty(held)) {
        organizationCheck.current = null;
        return;
      }
      const asked =
        check?.loadedIn === before.organizationId && (check.seen === organizationId || check.answer === organizationId);
      if (!asked) {
        organizationCheck.current = { loadedIn: before.organizationId, seen: organizationId, answer: null };
        void revalidate();
        return;
      }
      // Waiting for the answer, or for the store to hold the organization it gave.
      if (check.answer !== organizationId) return;
    }
    if (termsRequired) return;

    const thisLoad = ++latestLoad.current;
    const loading = `${configurationId}/${versionId ?? ""}`;
    organizationCheck.current = null;
    // Another version than the one held: it goes now.
    if (!holds) useEditorStore.getState().reset();
    settle(null);
    setOutcome({ address: loading, status: "loading" });
    const request =
      versionId === undefined
        ? getConfiguration(organizationId, configurationId)
        : getConfigurationVersion(organizationId, configurationId, versionId);
    request.then(
      ({ configuration, version, versions }) => {
        if (thisLoad !== latestLoad.current) return;
        useEditorStore.getState().load({ organizationId, configuration, version, versions });
        settle({ configurationId: configuration.id, versionId: version.id, organizationId });
        setOutcome(null);
        if (versionId === undefined) {
          replacingWith.current = version.id;
          void navigate(`/editor/${configurationId}/${version.id}`, { replace: true });
        }
      },
      (error: unknown) => {
        if (thisLoad !== latestLoad.current) return;
        if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
          void revalidate();
          return;
        }
        useEditorStore.getState().reset();
        if (isConfigurationGone(error)) {
          setOutcome({ address: loading, status: "not_found" });
          return;
        }
        if (isVersionGone(error)) {
          setOutcome({ address: loading, status: "version_not_found" });
          return;
        }
        if (!isSessionEnded(error)) toast.error(LOAD_FAILED_MESSAGE);
        setOutcome({ address: loading, status: "failed" });
      },
    );
    return () => {
      latestLoad.current++;
    };
  }, [
    configurationId,
    versionId,
    entry,
    organizationId,
    isDirty,
    isWellFormed,
    isVersionWellFormed,
    termsRequired,
    attempt,
    checkAnswered,
    revalidate,
    navigate,
    settle,
  ]);

  // Every version the page settles on becomes the person's selection, which
  // `/editor/{id}` opens next: best effort, so a failure says nothing and
  // changes nothing. Once per settled version (StrictMode runs effects
  // twice).
  useEffect(() => {
    if (settledOn === null) return;
    const { organizationId: loadedIn, configurationId: ofConfiguration, versionId: selected } = settledOn;
    const selection = `${loadedIn}/${ofConfiguration}/${selected}`.toLowerCase();
    if (recordedSelection.current === selection) return;
    recordedSelection.current = selection;
    selectConfigurationVersion(loadedIn, ofConfiguration, { versionId: selected }).catch(() => undefined);
  }, [settledOn]);

  // Cmd/Ctrl+S anywhere on the page saves, and never opens the browser's save
  // dialog, even with nothing to save. Inside Monaco its own command saves,
  // and this never sees the key (YamlEditor). The save writes every edit a
  // field holds first (held-edits).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isSaveShortcut(event)) {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [save]);

  // Warn before closing or reloading the tab with unsaved changes: the
  // browser asks its own question.
  useUnloadGuard(isDirty);

  // Selecting a node (or a group) switches to the Configuration tab. By id:
  // a change to the selected node replaces
  // its object, and shouldn't pull the panel back from the YAML tab.
  useEffect(() => {
    if (selectedNodeId !== null) useEditorStore.getState().setActiveTab("config");
  }, [selectedNodeId]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  /*
   * Whether the store holds what the address names, in either case: that
   * version of that configuration; any version of it for `/editor/{id}`,
   * until the replace lands; or, while a create's push is on its way, the
   * created version under the source's address, on the history entry it
   * was adopted on (until the page has recorded the adoption, the entry is
   * this one). A version still to be fetched is loading, so the one before
   * is never editable meanwhile.
   */
  const holdsAddress =
    sameId(heldConfigurationId, configurationId) &&
    heldVersionId !== null &&
    (versionId === undefined ||
      sameId(heldVersionId, versionId) ||
      (settledOn !== null &&
        sameId(settledOn.configurationId, configurationId) &&
        sameId(settledOn.versionId, versionId) &&
        (adoptionShown === null || !sameId(adoptionShown.versionId, heldVersionId) || adoptionShown.entry === entry)));

  const status: LoadStatus = !isWellFormed
    ? "not_found"
    : !isVersionWellFormed
      ? "version_not_found"
      : outcome?.address === address
        ? outcome.status
        : holdsAddress
          ? "loaded"
          : "loading";

  // The tour, once per page, when the configuration has loaded and the
  // person hasn't been through it (effects never run on the server).
  // Leaving the page stops it, unfinished.
  const stopTour = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (status !== "loaded" || stopTour.current !== null || isTourCompleted()) return;
    stopTour.current = startEditorTour();
  }, [status]);
  useEffect(
    () => () => {
      stopTour.current?.();
      stopTour.current = null;
    },
    [],
  );

  if (status === "not_found") return <EditorUnavailable reason="not_found" />;
  if (status === "version_not_found") return <EditorUnavailable reason="version_not_found" configurationId={configurationId} />;
  if (status === "failed") return <EditorUnavailable reason="failed" onRetry={retry} />;
  if (status === "loading") {
    return (
      // The canvas loading state, alone: there is no toolbar or
      // panel to show until the configuration is here.
      <div className="h-full flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-muted-foreground/25 border-t-muted-foreground mx-auto mb-2.5" />
          <p className="text-[13px] text-muted-foreground">
            Loading configuration…
          </p>
        </div>
      </div>
    );
  }

  const panelTabs: EditorPanelTab[] = [
    {
      id: "config",
      label: "Configuration",
      icon: Settings,
      content: <ConfigurationPanel />,
      disabled: isCanvasLocked,
      // Its sections, cards, held rows and scroll survive a look at the YAML.
      keepMounted: true,
    },
    {
      id: "yaml",
      label: "YAML",
      icon: Code,
      content: (
        <div className="flex-1 min-h-0 overflow-hidden">
          <YamlEditor onSave={save} />
        </div>
      ),
    },
    {
      // The third tab, kept mounted, and disabled whenever Configuration is
      // (manual edit mode, text the canvas can't show).
      id: "testing",
      label: "Testing",
      icon: FlaskConical,
      content: <TestingTab />,
      disabled: isCanvasLocked,
      keepMounted: true,
    },
  ];

  return (
    <EditorLayout
      toolbar={<EditorToolbar onSave={save} />}
      toolbox={<CollapsibleToolbox />}
      main={
        <>
          <PublishedVersionBanner />
          {/* The canvas actions are pinned to the canvas's corner, below the banner. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <Canvas />
            <CanvasActions />
          </div>
        </>
      }
      panelTabs={panelTabs}
      dialogs={
        <UnsavedChangesDialog
          open={guard.isBlocked}
          onOpenChange={(open) => !open && guard.handleCancel()}
          onSaveAndContinue={guard.handleSaveAndProceed}
          onDiscard={guard.handleDiscardAndProceed}
          onCancel={guard.handleCancel}
          isSaving={guard.isSaving}
        />
      }
    />
  );
}
