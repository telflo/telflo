import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Download, Loader2, Rocket } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
  FLEETS_UNAVAILABLE_MESSAGE,
  helmInstallCommand,
  helmQuickDeployCommand,
  helmValuesInputOf,
  helmValuesYaml,
  helmDownloadFragment,
  helmValuesFileName,
  INSTALL_ENV_MAXIMUM,
  INSTALL_ENV_NAME_PATTERN,
  type EnrollmentTokenListed,
  type HelmInstallFacts,
  type HelmInstallParts,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { abortAfter } from "~/lib/abort-after.js";
import {
  ApiError,
  createQuickDeployLink,
  getCollectorGroups,
  getEnrollmentTokens,
  getHelmInstallFacts,
  getOrganizationSettings,
} from "~/lib/api-client.js";
import { downloadBlob } from "~/lib/download.js";
import { FLEET_WRITE_TIMEOUT_MS, bundleFieldProblemsOf, fleetRefusalMessage, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { envValueProblem, type IncludedEnvVar } from "~/lib/install.js";
import { gatewayAddress, kubernetesGroupRows, kubernetesRowKey, kubernetesRowName, type KubernetesGroupRow } from "~/lib/kubernetes-groups.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import { EnvVarInputs, type EnvVarChoice, type EnvVarChoices } from "./EnvVarInputs.js";
import {
  ASSIGN_REFUSALS,
  CLOSED,
  FactsRefused,
  FINAL_REFUSALS,
  NO_DEFAULT_TOKEN,
  PUBLIC_INSTALL_LINKS_OFF_WORDS,
  revealDefaultBearer,
  TOKEN_REFUSALS,
  useInstallOpening,
  validDefaultToken,
} from "./install-opening.js";
import { NoDefaultToken } from "./InstallContainerSection.js";
import { kubernetesInstallDisabledReason } from "./KubernetesGroupsTable.js";
import { QuickDeployScreen } from "./QuickDeployScreen.js";
import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";

/*
 * The Helm install dialog (D17d-2 decisions 9, 12, 19 and 21; Preflight
 * rulings 23 to 27 and 33): a Kubernetes-supervisor fleet's group installed
 * with Helm (ADR 0018), with D17c-1's `InstallDialog` patterns and
 * its opening's shared parts (`install-opening.ts`). One Dialog, keyed per
 * opening, its title fixed ("Install with Helm": never a name).
 *
 * - **Its reads** (a person's, at the opening, each under the 10 s hang
 *   guard): the fleet's groups, the organization's settings (whether public
 *   install links are on: a failed read counts as on) and the fleet's tokens
 *   (whether a default token is valid) together, then the chosen group's
 *   Helm facts (`getHelmInstallFacts`). The dialog's own reads, never the
 *   tab's polled groups (D17c-1 Ruling 66: a snapshot at the opening).
 * - **The Group select** (Preflight ruling 26): the Agent, the Cluster, then
 *   the gateways (`kubernetesGroupRows`), values their keys (ids, or the
 *   Cluster's role), text their names; a row with no Helm install listed
 *   disabled with its reason (`kubernetesInstallDisabledReason`). Opened on
 *   the row's group, or, from the header, the first installable row; with
 *   none, "Pick a group", the footer disabled and "Assign a published version
 *   to a group first" with a Groups tab link. A group change is a fresh
 *   choice (its facts read again, an earlier answer dropped; the variables,
 *   the problems and the errors reset). A group gone at the opening toasts
 *   "Group not found" and closes.
 * - **The facts' refusals**: an assignment's (unassigned, a deleted
 *   configuration's version, a retired version) and unreadable settings show
 *   their words and a Groups tab link (no inner Assign dialog: Ruling 66);
 *   `fleet_archived` and `fleet_type_not_installable` their words (the
 *   former reads the fleet again); anything else its words with "Try
 *   again"; the fleet gone, the group gone, the organization's, the terms'
 *   and the session's as D17c-1's.
 * - **The group's install**: its release, namespace and (a gateway's)
 *   in-cluster address as text, inside `ph-no-capture`; the variables
 *   (`EnvVarInputs`, target "helm": opt-in, typed; a YAML 1.1 word's name
 *   like any other, since the platform's chart quotes the keys: D18
 *   decision 23).
 * - **Download values.yaml** (Preflight rulings 24 and 25): the fields
 *   checked (their messages, nothing sent), then the tokens and the group's
 *   facts read again together, the valid default token revealed (audited
 *   `viewed`), values.yaml built from those fresh facts (`helmValuesInputOf`,
 *   `helmValuesYaml`) and handed to `downloadBlob` (its anchor detached) as
 *   `<release>-values-<8 hex>.yaml` (`helmValuesFileName` with a fresh
 *   `helmDownloadFragment`, Rulings 36 and 37: a name of its own, which the
 *   command's `-f` names), "Download
 *   started". The bearer and the file are locals of that chain, never in
 *   state. Then the command screen: "<file> is saved. Run this in a shell
 *   with access to your cluster:" (the file's name, the release's, inside
 *   `ph-no-capture` here and in the warning: Ruling 40), the words for a
 *   file the browser renamed, the install
 *   command (`helmInstallCommand`, no secret) in a `SecretCopyBox` ("Copy
 *   install command"), the warning, "Done". A builder's refusal shows
 *   "Failed to build values.yaml", never its message.
 * - **Quick Deploy** (Preflight ruling 27), only while public install links
 *   are on (else "Public install links are turned off for this
 *   organization.", and a description without it): one click, the link's create (`{kind: "helm", env}`),
 *   then "Quick Deploy command ready" with the link's curl line and the
 *   install (`helmQuickDeployCommand`) in one `SecretCopyBox` ("Copy
 *   command"), shown once (the link's secret is stored only as its hash),
 *   no reveal (the bearer comes with the link's download). A create answered
 *   `public_install_links_disabled` turns the button off at once;
 *   `enrollment_token_default_missing` shows `NoDefaultToken`; a 400's
 *   details show under their variables.
 * - No valid default token (at the opening, or found at a download or a
 *   create): Download and Quick Deploy disabled, `NoDefaultToken` under the
 *   footer.
 * - "Install started" (`onInstallStarted`) on a download's or a link's
 *   success, never on opening.
 * - Focus: after a download, "Copy install command"; after a link,
 *   "Copy command"; "Done" closes, and the route gives the focus back to
 *   the opener.
 * - Closing during a read, a download or a link's making drops its answer;
 *   the Quick Deploy command leaves the state as the dialog closes.
 * - Privacy (decisions 9 and 29): the commands only in a `SecretCopyBox`;
 *   the release, namespace, address, variables' names and values inside
 *   `ph-no-capture`, never in an attribute but an input's own `value`; the
 *   groups' names visible text only (the Select's hidden native option holds
 *   one as text). No toast, URL or log holds any of them.
 */

export const HELM_INSTALL_TITLE = "Install with Helm";
export const HELM_INSTALL_DESCRIPTION =
  "Choose a group, then download its values.yaml and run helm upgrade --install against your cluster, or make a Quick Deploy command.";
/** The description while public install links are off: no Quick Deploy to make (Ruling 40). */
export const HELM_INSTALL_DESCRIPTION_LINKS_OFF =
  "Choose a group, then download its values.yaml and run helm upgrade --install against your cluster.";
export const HELM_LOAD_FAILED_MESSAGE = "Failed to load the install's details";
export const HELM_BUILD_FAILED_MESSAGE = "Failed to build values.yaml";
export const HELM_DOWNLOAD_FAILED_MESSAGE = "Failed to download values.yaml";
export const HELM_QUICK_DEPLOY_FAILED_MESSAGE = "Failed to make the install link";
export const HELM_DOWNLOAD_STARTED_MESSAGE = "Download started";
export const HELM_PICK_GROUP = "Pick a group";
export const HELM_NO_GROUP_WORDS = "Assign a published version to a group first";
/** The command screen's words after the file this download saved (Rulings 36 and 37). */
export const HELM_COMMAND_INTRO_WORDS = "is saved. Run this in a shell with access to your cluster:";
/** The command screen's words, naming the file this download saved, as text (the screen shows the name inside ph-no-capture: Ruling 40). */
export function helmCommandIntro(valuesFile: string): string {
  return `${valuesFile} ${HELM_COMMAND_INTRO_WORDS}`;
}
export const HELM_RENAMED_FILE_WORDS = "If your browser saved it under another name (for example with a number added), use that name after -f.";
/** The command screen's warning after the file saved. */
export const HELM_VALUES_WARNING_WORDS = "holds the fleet's default token: delete it once the release is installed, and don't commit or share it.";
/** The command screen's warning, naming the file saved, as text (shown with the name inside ph-no-capture). */
export function helmValuesWarning(valuesFile: string): string {
  return `${valuesFile} ${HELM_VALUES_WARNING_WORDS}`;
}

/**
 * A sentence starting with the values file's name (the release's: a gateway's
 * name, configuration text): the name inside `ph-no-capture` (Ruling 40),
 * the fixed words after it.
 */
function NamedFileWords({ valuesFile, words }: { valuesFile: string; words: string }) {
  return (
    <>
      <span className="ph-no-capture">{valuesFile}</span> {words}
    </>
  );
}
export const HELM_QUICK_DEPLOY_WORDS =
  "Run this command in a shell with access to your cluster: it downloads the group's values file with the link, then installs the group's Helm release.";
export const HELM_QUICK_DEPLOY_WARNING =
  "The command contains a link that downloads the fleet's default token, with the values you typed, without signing in; the values file it saves holds that token: delete it once the release is installed. Run it in a secure shell; don't paste it into shared logs or chat. If it leaks, revoke the link, and revoke the default token and issue a new one.";

export { PUBLIC_INSTALL_LINKS_OFF_WORDS };

/** The opening's groups read. */
type GroupsState =
  | { kind: "loading" }
  | { kind: "read"; rows: KubernetesGroupRow[] }
  | { kind: "refused"; error: string; retry: boolean };

/** The chosen group's facts read. */
type FactsState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "read"; facts: HelmInstallFacts }
  /** The words shown; `groupsTab` a Groups tab link (an assignment or a save fixes it), `retry` "Try again". */
  | { kind: "refused"; error: string; groupsTab: boolean; retry: boolean };

/** The refusals the Groups tab fixes: an assignment's, and settings to save in Edit. */
function fixedOnGroupsTab(code: string): boolean {
  return ASSIGN_REFUSALS.has(code) || code === "collector_group_settings_unreadable";
}

export interface HelmInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** The group installed; null (the header, the checklist, the empty tab) for the first one with a Helm install. */
  groupId: string | null;
  /** A download's or a link's success: the route's "install started". */
  onInstallStarted: () => void;
  /** The fleet gone (or archived meanwhile): the route reads it again. */
  onFleetChanged: () => void;
  /** The group found gone: the groups shown elsewhere read again. */
  onGroupsChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the route gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: the group chosen afresh, no command, no earlier refusal. */
export function HelmInstallDialog(props: HelmInstallDialogProps) {
  const opening = useOpeningKey(props.open);
  return <HelmInstallSession key={opening} {...props} />;
}

function HelmInstallSession({
  open,
  onOpenChange,
  organizationId,
  fleetId,
  groupId,
  onInstallStarted,
  onFleetChanged,
  onGroupsChanged,
  onCloseAutoFocus,
}: HelmInstallDialogProps) {
  const opening = useInstallOpening({ open, organizationId, onOpenChange, onFleetChanged, onGroupsChanged });
  const { read, live, isStillCurrent, handledEverywhere, groupGone, latest } = opening;
  const selectId = useId();

  const latestStarted = useRef(onInstallStarted);
  useEffect(() => {
    latestStarted.current = onInstallStarted;
  });

  const [groupsState, setGroupsState] = useState<GroupsState>({ kind: "loading" });
  const [linksOn, setLinksOn] = useState(true);
  const [noDefaultToken, setNoDefaultToken] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [factsState, setFactsState] = useState<FactsState>({ kind: "none" });
  const loads = useRef(0);
  const choices = useRef(0);

  // Maps, never plain objects: a variable's name is configuration text, and `constructor` or `__proto__` is a valid one.
  const [env, setEnv] = useState<EnvVarChoices>(() => new Map());
  const [attempted, setAttempted] = useState(false);
  const [serverProblems, setServerProblems] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [actionError, setActionError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);
  const downloadingRef = useRef(false);
  // The command screen: the install's parts as the download's fresh facts named them and the file it saved (no secret).
  const [installed, setInstalled] = useState<(HelmInstallParts & { valuesFile: string }) | null>(null);

  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  // The Quick Deploy screen: the command (the link's secret inside) and the link's expiry; the command leaves at close.
  const [quickDeploy, setQuickDeploy] = useState<{ command: string | null; expiresAt: string | null } | null>(null);
  if (!open && quickDeploy !== null && quickDeploy.command !== null) setQuickDeploy({ ...quickDeploy, command: null });

  const close = () => onOpenChange(false);

  /** What a tokens read found valid: with none, the no-default-token words show. */
  const validTokenFound = (valid: EnrollmentTokenListed | undefined) => setNoDefaultToken(valid === undefined);

  /** A facts refusal, in the body. */
  const factsRefused = (failure: unknown) => {
    if (handledEverywhere(failure)) return;
    if (failure instanceof ApiError && fixedOnGroupsTab(failure.code)) {
      setFactsState({ kind: "refused", error: failure.message, groupsTab: true, retry: false });
      return;
    }
    if (failure instanceof ApiError && FINAL_REFUSALS.has(failure.code)) {
      setFactsState({ kind: "refused", error: failure.message, groupsTab: false, retry: false });
      // Archived meanwhile: the page's entry points follow.
      if (failure.code === "fleet_archived") latest.current.onFleetChanged();
      return;
    }
    setFactsState({ kind: "refused", error: fleetRefusalMessage(failure, HELM_LOAD_FAILED_MESSAGE), groupsTab: false, retry: true });
  };

  /** A group chosen: a fresh choice, its facts read (an earlier choice's answer dropped). */
  const choose = async (row: KubernetesGroupRow | null) => {
    const number = ++choices.current;
    const sentIn = organizationId;
    setChosen(row === null ? null : kubernetesRowKey(row));
    setEnv(new Map());
    setAttempted(false);
    setServerProblems(new Map());
    setActionError(null);
    if (row === null || row.group === null || kubernetesInstallDisabledReason(row) !== null) {
      setFactsState({ kind: "none" });
      return;
    }
    const { id } = row.group;
    setFactsState({ kind: "loading" });
    const facts = await read((signal) => getHelmInstallFacts(sentIn, fleetId, id, { signal }));
    if (facts === null || number !== choices.current || !isStillCurrent(sentIn)) return;
    if (facts.ok) setFactsState({ kind: "read", facts: facts.value });
    else factsRefused(facts.error);
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  /** The opening's reads: the groups, the settings and the tokens together, then the chosen group's facts. */
  const load = async () => {
    const number = ++loads.current;
    const sentIn = organizationId;
    const current = () => number === loads.current && isStillCurrent(sentIn);
    setGroupsState({ kind: "loading" });
    const [groups, settings, tokens] = await Promise.all([
      read((signal) => getCollectorGroups(sentIn, fleetId, { signal })),
      read((signal) => getOrganizationSettings(sentIn, { signal })),
      read((signal) => getEnrollmentTokens(sentIn, fleetId, { signal })),
    ]);
    if (groups === null || settings === null || tokens === null || !current()) return;
    // A settings read that failed counts as on: a create then answers the switch's refusal itself.
    setLinksOn(!settings.ok || settings.value.publicInstallLinks);
    // A tokens read that failed says nothing here: the download reads them again.
    if (tokens.ok) validTokenFound(validDefaultToken(tokens.value.tokens, Date.now()));
    if (!groups.ok) {
      if (handledEverywhere(groups.error)) return;
      setGroupsState({ kind: "refused", error: fleetRefusalMessage(groups.error, HELM_LOAD_FAILED_MESSAGE), retry: true });
      return;
    }
    const rows = kubernetesGroupRows(groups.value.groups);
    const row =
      groupId === null
        ? (rows.find((each) => kubernetesInstallDisabledReason(each) === null) ?? null)
        : (rows.find((each) => each.group?.id === groupId) ?? undefined);
    if (row === undefined) {
      groupGone();
      return;
    }
    setGroupsState({ kind: "read", rows });
    void chooseRef.current(row);
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    // One load per opening; StrictMode's second run starts it again, the first's answers dropped (`useOpeningReads`).
    if (open) void loadRef.current();
  }, [open]);

  // Focus after a download or a link (the button pressed is gone): the box's copy button, else the Tokens tab link.
  const content = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    const root = content.current;
    if (root === null) return;
    const target =
      root.querySelector<HTMLElement>('button[aria-label="Copy install command"], button[aria-label="Copy command"]') ??
      root.querySelector<HTMLElement>("a[href]");
    target?.focus();
  });

  /* The fields, their values as used (trimmed), and their problems. */
  const rows = groupsState.kind === "read" ? groupsState.rows : [];
  const row = rows.find((each) => kubernetesRowKey(each) === chosen) ?? null;
  const facts = factsState.kind === "read" ? factsState.facts : null;
  // A name the server's scan offers is a shell name; one that isn't is never shown or written.
  const envNames = (facts?.envVarNames ?? []).filter((name) => INSTALL_ENV_NAME_PATTERN.test(name));
  const included: IncludedEnvVar[] = envNames
    .filter((name) => env.get(name)?.included === true)
    .map((name) => ({ name, value: (env.get(name)?.value ?? "").trim() }));

  const localProblems = new Map<string, string>();
  for (const { name } of included) {
    const problem = envValueProblem(env.get(name)?.value ?? "");
    if (problem !== null) localProblems.set(`env:${name}`, problem);
  }
  const envCountProblem =
    included.length > INSTALL_ENV_MAXIMUM ? `Tick at most ${INSTALL_ENV_MAXIMUM} variables: values.yaml holds no more.` : null;
  if (envCountProblem !== null) localProblems.set("envCount", envCountProblem);
  const valid = localProblems.size === 0;

  const envProblems = new Map<string, string>();
  for (const name of envNames) {
    const problem = (attempted ? localProblems.get(`env:${name}`) : undefined) ?? serverProblems.get(`env:${name}`);
    if (problem !== undefined) envProblems.set(name, problem);
  }

  const busy = downloading || creating;

  /** A download's or a link's refusal, the opening still on. */
  const requestFailed = (failure: unknown, request: { env: readonly { name: string }[] }, fallback: string) => {
    if (failure instanceof FactsRefused) {
      const refusal = failure.error;
      if (refusal instanceof ApiError && (fixedOnGroupsTab(refusal.code) || FINAL_REFUSALS.has(refusal.code))) {
        factsRefused(refusal);
        return;
      }
      if (handledEverywhere(refusal)) return;
      setActionError(fleetRefusalMessage(refusal, HELM_LOAD_FAILED_MESSAGE));
      return;
    }
    if (failure === NO_DEFAULT_TOKEN || (failure instanceof ApiError && (TOKEN_REFUSALS.has(failure.code) || failure.code === "enrollment_token_default_missing"))) {
      focusNext.current = true;
      validTokenFound(undefined);
      return;
    }
    if (failure instanceof ApiError && failure.code === "public_install_links_disabled") {
      setLinksOn(false);
      return;
    }
    if (handledEverywhere(failure)) return;
    if (failure instanceof ApiError && (fixedOnGroupsTab(failure.code) || FINAL_REFUSALS.has(failure.code))) {
      // The group or the fleet changed since the opening: as the facts' refusal.
      factsRefused(failure);
      return;
    }
    const entries = Object.entries(bundleFieldProblemsOf(failure, request)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    if (entries.length > 0) {
      setServerProblems(new Map(entries));
      return;
    }
    setActionError(isUnknownOutcome(failure) ? FLEETS_UNAVAILABLE_MESSAGE : fleetRefusalMessage(failure, fallback));
  };

  /** "Download values.yaml" (Preflight rulings 24 and 25): the bearer and the file only locals of this chain. */
  const download = async () => {
    setAttempted(true);
    if (facts === null || row === null || row.group === null || busy || downloadingRef.current || creatingRef.current || noDefaultToken || !valid) return;
    const id = row.group.id;
    const variables = included;
    const sentIn = organizationId;
    downloadingRef.current = true;
    setDownloading(true);
    setActionError(null);
    setServerProblems(new Map());
    try {
      const revealed = await revealDefaultBearer<HelmInstallFacts>(opening, sentIn, fleetId, (signal) =>
        getHelmInstallFacts(sentIn, fleetId, id, { signal }),
      );
      if (!live(sentIn)) return;
      // The facts read with the tokens: the file is built from them. A variable they no longer offer is left out.
      const fresh = revealed.facts ?? facts;
      const offered = new Set(fresh.envVarNames);
      let yaml: string;
      let valuesFile: string;
      try {
        yaml = helmValuesYaml(helmValuesInputOf(fresh, revealed.bearer, variables.filter((each) => offered.has(each.name))));
        // A name of this download's own (Ruling 37): another download, of this group or another fleet's, never shares it.
        valuesFile = helmValuesFileName(fresh.helm.release, helmDownloadFragment(crypto.getRandomValues(new Uint8Array(4))));
      } catch {
        setActionError(HELM_BUILD_FAILED_MESSAGE);
        return;
      }
      downloadBlob(new Blob([yaml], { type: "text/yaml" }), valuesFile);
      toast.success(HELM_DOWNLOAD_STARTED_MESSAGE);
      latestStarted.current();
      setFactsState({ kind: "read", facts: fresh });
      focusNext.current = true;
      const { release, namespace, chartReference, chartVersion } = fresh.helm;
      setInstalled({ release, namespace, chartReference, chartVersion, valuesFile });
    } catch (failure) {
      if (failure !== CLOSED && live(sentIn)) requestFailed(failure, { env: variables }, HELM_DOWNLOAD_FAILED_MESSAGE);
    } finally {
      downloadingRef.current = false;
      setDownloading(false);
    }
  };

  /** "Quick Deploy" (Preflight ruling 27): the link's create, then its command, shown once. */
  const makeQuickDeployLink = async () => {
    setAttempted(true);
    if (facts === null || row === null || row.group === null || !linksOn || busy || downloadingRef.current || creatingRef.current || noDefaultToken || !valid) return;
    const request = { kind: "helm" as const, env: included };
    const { chartReference, chartVersion, release, namespace } = facts.helm;
    const sentIn = organizationId;
    creatingRef.current = true;
    setCreating(true);
    setActionError(null);
    setServerProblems(new Map());
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      const created = await createQuickDeployLink(sentIn, fleetId, row.group.id, request, { signal: guard.signal });
      // Closed, or another organization, meanwhile: dropped (the link stays listed under Install links, and expires).
      if (!live(sentIn)) return;
      const named = created.link.choices.kind === "helm" ? created.link.choices : { release, namespace };
      let command: string;
      try {
        command = helmQuickDeployCommand(created.url, { release: named.release, namespace: named.namespace, chartReference, chartVersion });
      } catch {
        setActionError(HELM_BUILD_FAILED_MESSAGE);
        return;
      }
      latestStarted.current();
      focusNext.current = true;
      setQuickDeploy({ command, expiresAt: created.link.expiresAt });
    } catch (failure) {
      if (live(sentIn)) requestFailed(failure, request, HELM_QUICK_DEPLOY_FAILED_MESSAGE);
    } finally {
      guard.clear();
      creatingRef.current = false;
      setCreating(false);
    }
  };

  /* What the dialog shows. */

  const groupsTabLink = (
    <Link to={{ search: "?tab=groups" }} onClick={close} className="font-medium underline">
      Groups tab
    </Link>
  );

  const body = (() => {
    if (groupsState.kind === "loading") {
      return (
        <p role="status" className="text-[13px] text-muted-foreground">
          Loading…
        </p>
      );
    }
    if (groupsState.kind === "refused") {
      return (
        <div className="grid gap-2">
          <DialogErrorAlert error={groupsState.error} />
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </div>
      );
    }
    const select = (
      <div className="grid gap-2">
        <Label htmlFor={selectId}>Group</Label>
        <Select
          value={chosen ?? ""}
          onValueChange={(value) => {
            if (value === chosen) return;
            const next = rows.find((each) => kubernetesRowKey(each) === value);
            if (next !== undefined) void choose(next);
          }}
          disabled={busy}
        >
          <SelectTrigger id={selectId}>
            <SelectValue placeholder={HELM_PICK_GROUP} />
          </SelectTrigger>
          <SelectContent className="w-[var(--radix-select-trigger-width)]">
            {rows.map((each) => {
              const reason = kubernetesInstallDisabledReason(each);
              return (
                <SelectItem key={kubernetesRowKey(each)} value={kubernetesRowKey(each)} disabled={reason !== null} description={reason ?? undefined}>
                  {kubernetesRowName(each)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    );
    return (
      <div className="grid gap-4">
        {select}
        {chosen === null ? (
          <p className="text-[13px] text-muted-foreground">
            {HELM_NO_GROUP_WORDS} on the {groupsTabLink}.
          </p>
        ) : factsState.kind === "loading" ? (
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading…
          </p>
        ) : factsState.kind === "refused" ? (
          <div className="grid gap-2">
            <DialogErrorAlert error={factsState.error} />
            {factsState.groupsTab ? (
              <p className="text-[13px] text-muted-foreground">Fix it on the {groupsTabLink}, then install.</p>
            ) : factsState.retry && row !== null ? (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => void choose(row)}>
                  Try again
                </Button>
              </div>
            ) : null}
          </div>
        ) : factsState.kind === "none" ? (
          row === null ? (
            <p className="text-[13px] text-muted-foreground">{HELM_NO_GROUP_WORDS}</p>
          ) : (
            // The row's group found with no Helm install (opened from its row, or changed since): its reason, and where to fix it.
            <div className="grid gap-1 text-[13px] text-muted-foreground">
              <p>{kubernetesInstallDisabledReason(row) ?? COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE}</p>
              <p>Fix it on the {groupsTabLink}, then install.</p>
            </div>
          )
        ) : (
          <>
            <HelmInstallFactsList facts={factsState.facts} />
            <EnvVarInputs
              names={envNames}
              choices={env}
              onChange={(name: string, next: EnvVarChoice) => {
                setEnv((previous) => new Map(previous).set(name, next));
                setServerProblems(new Map());
                setActionError(null);
              }}
              problems={envProblems}
              countProblem={envCountProblem}
              target="helm"
              disabled={busy}
            />
            <DialogErrorAlert error={actionError} />
          </>
        )}
      </div>
    );
  })();

  const noDefaultTokenId = `${selectId}-no-default-token`;
  const ready = facts !== null && !busy && !noDefaultToken;
  const shown =
    quickDeploy !== null ? (
      <QuickDeployScreen
        systemd={false}
        description={HELM_QUICK_DEPLOY_WORDS}
        warning={HELM_QUICK_DEPLOY_WARNING}
        oneClick
        expiresAt={quickDeploy.expiresAt}
        preview=""
        command={quickDeploy.command}
        revealing={false}
        canReveal={false}
        revealError={null}
        noDefaultToken={false}
        linkTokenRevoked={false}
        revealRef={null}
        doneRef={null}
        onReveal={() => undefined}
        onClose={close}
      />
    ) : installed !== null ? (
      <>
        <DialogHeader>
          <DialogTitle>{HELM_INSTALL_TITLE}</DialogTitle>
          <DialogDescription>
            <NamedFileWords valuesFile={installed.valuesFile} words={HELM_COMMAND_INTRO_WORDS} />
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <SecretCopyBox secret={helmInstallCommand(installed)} copyLabel="Copy install command" multiline />
          <p className="text-xs text-muted-foreground">{HELM_RENAMED_FILE_WORDS}</p>
          <div className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              <NamedFileWords valuesFile={installed.valuesFile} words={HELM_VALUES_WARNING_WORDS} />
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </>
    ) : (
      <>
        <DialogHeader>
          <DialogTitle>{HELM_INSTALL_TITLE}</DialogTitle>
          <DialogDescription>{linksOn ? HELM_INSTALL_DESCRIPTION : HELM_INSTALL_DESCRIPTION_LINKS_OFF}</DialogDescription>
        </DialogHeader>
        <div className="py-4">{body}</div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={linksOn ? "outline" : "default"}
            onClick={() => void download()}
            disabled={!ready}
            aria-describedby={facts !== null && noDefaultToken ? noDefaultTokenId : undefined}
          >
            {downloading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Preparing…
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                Download values.yaml
              </>
            )}
          </Button>
          {linksOn && (
            <Button
              type="button"
              onClick={() => void makeQuickDeployLink()}
              disabled={!ready}
              aria-describedby={facts !== null && noDefaultToken ? noDefaultTokenId : undefined}
            >
              {creating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Making link…
                </>
              ) : (
                <>
                  <Rocket className="mr-2 h-4 w-4" aria-hidden="true" />
                  Quick Deploy
                </>
              )}
            </Button>
          )}
        </DialogFooter>
        {!linksOn && groupsState.kind === "read" && (
          <p className="text-xs text-muted-foreground">
            {PUBLIC_INSTALL_LINKS_OFF_WORDS}
          </p>
        )}
        {facts !== null && noDefaultToken && (
          <div id={noDefaultTokenId} className="pt-3">
            <NoDefaultToken onTokensTab={close} />
          </div>
        )}
      </>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" onCloseAutoFocus={onCloseAutoFocus}>
        <div ref={content} className="grid gap-4">
          {shown}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The chosen group's Helm install as text (configuration text: inside `ph-no-capture`, never an attribute). */
function HelmInstallFactsList({ facts }: { facts: HelmInstallFacts }) {
  const { release, namespace, role } = facts.helm;
  const address = role === "gateway" ? gatewayAddress(release, namespace) : null;
  return (
    <dl className="ph-no-capture grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
      <dt className="text-muted-foreground">Release</dt>
      <dd className="break-all font-mono text-xs text-foreground">{release}</dd>
      <dt className="text-muted-foreground">Namespace</dt>
      <dd className="break-all font-mono text-xs text-foreground">{namespace}</dd>
      {address !== null && (
        <>
          <dt className="text-muted-foreground">Address</dt>
          <dd className="grid gap-0.5 break-all font-mono text-xs text-foreground">
            <span>{address.http}</span>
            <span>{address.grpc}</span>
          </dd>
        </>
      )}
    </dl>
  );
}
