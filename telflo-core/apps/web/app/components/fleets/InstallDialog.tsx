import { useEffect, useId, useRef, useState, type Ref } from "react";
import { AlertTriangle, Download, Loader2, Rocket } from "lucide-react";
import { toast } from "sonner";
import {
  DEFAULT_INSTALL_EXECUTABLE_PATH,
  DEFAULT_INSTALL_ROOT_PATH,
  FLEETS_UNAVAILABLE_MESSAGE,
  INSTALL_ENV_MAXIMUM,
  INSTALL_ENV_NAME_PATTERN,
  withoutTrailingSlash,
  type CollectorGroup,
  type CreateQuickDeployLinkRequestInput,
  type EnrollmentTokenListed,
  type InstallArch,
  type InstallBundleRequestInput,
  type InstallFacts,
  type InstallMethod,
  type QuickDeployLink,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { abortAfter } from "~/lib/abort-after.js";
import {
  ApiError,
  createQuickDeployLink,
  downloadInstallBundle,
  getCollectorGroups,
  getEnrollmentTokens,
  getInstallFacts,
  getOrganizationSettings,
  revealEnrollmentToken,
} from "~/lib/api-client.js";
import { copyTextFromPromise } from "~/lib/clipboard.js";
import { downloadBlob } from "~/lib/download.js";
import { FLEET_WRITE_TIMEOUT_MS, bundleFieldProblemsOf, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useReturnFocus } from "~/lib/hooks/use-return-focus.js";
import {
  absolutePathProblem,
  containerCommand,
  containerPreview,
  displayNameProblem,
  envValueProblem,
  linuxRunCommands,
  MASKED_TOKEN,
  quickDeployCommands,
  quickDeployPreview,
  type IncludedEnvVar,
} from "~/lib/install.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import type { EnvVarChoice, EnvVarChoices } from "./EnvVarInputs.js";
import { GroupDialog } from "./GroupDialog.js";
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
import { InstallContainerSection, NoDefaultToken } from "./InstallContainerSection.js";
import { InstallLinuxSection } from "./InstallLinuxSection.js";
import { QuickDeployScreen } from "./QuickDeployScreen.js";
import { REVEAL_FAILED_MESSAGE } from "./RevealTokenDialog.js";
import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";

/*
 * The install dialog, one Dialog scoped to a group (the fleet's Default
 * group from the header, the empty Collectors tab and the setup checklist; a
 * group's own from its row), keyed per opening.
 *
 * - **Its reads** (a person's, at the opening, each under the 10 s hang
 *   guard: `useOpeningReads`; no polling): the fleet's groups first (the
 *   group's name and published version, for the title "Install collectors:
 *   {group}" — "Install collectors" until known — and the description),
 *   then the install's facts and the fleet's tokens together (whether a
 *   default token is valid). "Loading…" meanwhile.
 * - **Their refusals**: `collector_group_unassigned`,
 *   `collector_group_assignment_deleted` and `collector_version_not_offered`
 *   show their words and "Assign", which opens the group dialog for the
 *   group; its save reads everything again (an install needs the group's
 *   published version). `fleet_archived` and `fleet_type_not_installable`
 *   show their words; the 503 (`install_unavailable`, `fleets_unavailable`),
 *   no connection, the hang guard and a 429 show theirs with "Try again". A
 *   group gone toasts "Group not found" and closes; the fleet gone closes
 *   and the route reads it again ("Fleet not found"); the organization's or
 *   the terms' refusal closes and revalidates the layout; a session ended is
 *   silent.
 * - **Method** (a Select outside the facts' body, its item values fixed
 *   ids): the container image (the default) and the four Linux bundles,
 *   each with its description.
 * - **The reveal**: "Reveal & copy command" checks the fields at once (their
 *   messages, nothing sent), then hands one chain to `copyTextFromPromise`
 *   within the click (Safari's rule): the tokens and the install's facts
 *   read again together (the fleet archived since shows its words and the
 *   route reads the fleet again; the group deleted since toasts "Group not
 *   found" and closes; a facts change, a mount saved meanwhile, is in the
 *   command, built from the fresh facts), the valid default token, its
 *   reveal (a bearer reply, audited `viewed`), the command. The Method
 *   select is disabled meanwhile. The chain throws once the dialog has
 *   closed or the organization changed before the text is built, so a late
 *   reveal never reaches the clipboard. A read finding no valid default
 *   token, or another one than the bearer's (revoked and replaced), takes a
 *   bearer revealed earlier out of the box. One bearer per opening, shared
 *   by the container and the Linux token screen. "Copied run command"; a
 *   copy the browser refuses after the reveal: "Command revealed, but
 *   copying failed: copy it from the box above." No valid default token (all
 *   revoked, at the opening or at the reveal): `NoDefaultToken`.
 * - **The download**: the fields checked as the reveal's, then one `POST
 *   …/install-bundle` ("Building…"), saved as the contracts' file name
 *   (`downloadBlob`, its anchor never in the document), "Download
 *   started", then the screen "Set the token, then run" with its own Reveal
 *   and the four lines. A 400's details show under their fields.
 * - **Quick Deploy**, the Linux methods only: "Install as a systemd service"
 *   (ticked at each opening) disables Download, its reason shown and named
 *   by `aria-describedby`; the footer is Cancel | Download | Quick Deploy.
 *   Two clicks. **"Quick Deploy"** ("Making link…") checks the fields as the
 *   download's, then sends the create only (the download's request plus
 *   `systemd`; the display name never sent), the fields disabled meanwhile;
 *   its answer, the opening still on, takes a snapshot (the checked, trimmed
 *   fields, the link and its `url`) and shows `QuickDeployScreen` with
 *   `quickDeployPreview` (both secrets masked). **"Reveal & copy command"**
 *   hands one chain to `copyTextFromPromise` within the click: the link's
 *   `defaultTokenId` revealed (never a fresh tokens read; the opening's
 *   bearer reused when its token is the link's), the command built from the
 *   snapshot, then shown in a `SecretCopyBox` ("Copy command"). The chain
 *   throws once the opening is over; a create answered after it is dropped
 *   (the link stays listed under Install links, and expires). The create's
 *   refusals go as the download's (`bundleFieldProblemsOf`; the cap's
 *   inline); `enrollment_token_default_missing` shows `NoDefaultToken`. The
 *   reveal's token refusal reads the tokens again: another valid default
 *   token (the link's revoked and replaced since it was made), or a read
 *   that fails, shows "This link's token was revoked: make a new link." (the
 *   focus on "Done"); none shows `NoDefaultToken`. With no valid default
 *   token at the opening, Quick Deploy is disabled with the words (Download
 *   kept once unticked).
 * - The organization's "Public install links", read with the facts and the
 *   tokens (a failed read counts as on): while off, no Quick Deploy (its
 *   place "Public install links are turned off for this organization.") and
 *   no systemd box (the service comes only with Quick Deploy), so Download
 *   is offered unticked; a create answered `public_install_links_disabled`
 *   turns it off at once.
 * - "Install started" (`onInstallStarted`) on a reveal's, a download's or a
 *   Quick Deploy link's success, never on opening.
 * - Focus: after a reveal, on the box's copy button (the button pressed is
 *   gone); after a download, on the token screen's (or its Reveal); after a
 *   Quick Deploy link is made, on its "Reveal & copy command". On a Linux
 *   method a fleet with no valid default token shows the words under the
 *   footer before the download, Download kept.
 * - Closing during a read, a reveal, a download or a link's making drops its
 *   answer; the bearer, the link's `url` and the command leave the state as
 *   the dialog closes (before Radix's exit animation ends), the Quick Deploy
 *   screen's title, words and masked preview kept through the animation.
 * - Privacy: the bearer and the Quick Deploy command only in a
 *   `SecretCopyBox` (`ph-no-capture`) and the clipboard; the masked
 *   previews hold neither secret; the display name, the paths, the
 *   variables' names and values and the mounts' paths inside
 *   `ph-no-capture`, never in an attribute but an input's own `value`; the
 *   group's and the configuration's names visible text only. No toast, URL
 *   or log holds any of them.
 */

/** The Method select's item values (fixed ids). */
export const INSTALL_METHOD_CHOICES = ["container", "all-in-one-amd64", "all-in-one-arm64", "own-binary-amd64", "own-binary-arm64"] as const;
export type InstallMethodChoice = (typeof INSTALL_METHOD_CHOICES)[number];

/** Each method's words in the select (each with its description). */
export const INSTALL_METHOD_LABELS: Record<InstallMethodChoice, { label: string; description: string }> = {
  container: {
    label: "Container image — pull and run",
    description: "Pull the prebuilt collector image from the container registry and run it: no bundle to build.",
  },
  "all-in-one-amd64": {
    label: "Linux All In One (amd64)",
    description: "Installs the supervisor and the collector together on an x86_64 machine. Best for a first install.",
  },
  "all-in-one-arm64": {
    label: "Linux All In One (arm64)",
    description: "Installs the supervisor and the collector together on an arm64 machine. Best for a first install.",
  },
  "own-binary-amd64": {
    label: "Linux with your own otelcol-contrib (amd64)",
    description: "Installs the supervisor to run an otelcol-contrib you provide on an x86_64 machine.",
  },
  "own-binary-arm64": {
    label: "Linux with your own otelcol-contrib (arm64)",
    description: "Installs the supervisor to run an otelcol-contrib you provide on an arm64 machine.",
  },
};

function isMethodChoice(value: string): value is InstallMethodChoice {
  return (INSTALL_METHOD_CHOICES as readonly string[]).includes(value);
}

/** A Linux choice's method and arch; null for the container. */
function linuxOf(choice: InstallMethodChoice): { method: InstallMethod; arch: InstallArch } | null {
  switch (choice) {
    case "container":
      return null;
    case "all-in-one-amd64":
      return { method: "all-in-one", arch: "amd64" };
    case "all-in-one-arm64":
      return { method: "all-in-one", arch: "arm64" };
    case "own-binary-amd64":
      return { method: "own-binary", arch: "amd64" };
    case "own-binary-arm64":
      return { method: "own-binary", arch: "arm64" };
  }
}

export const INSTALL_LOAD_FAILED_MESSAGE = "Failed to load the install's details";
export const DOWNLOAD_FAILED_MESSAGE = "Failed to download the bundle";
export const COPIED_MESSAGE = "Copied run command";
export const COPY_FAILED_MESSAGE = "Command revealed, but copying failed: copy it from the box above.";
export const DOWNLOAD_STARTED_MESSAGE = "Download started";
/** Quick Deploy's. */
export const QUICK_DEPLOY_FAILED_MESSAGE = "Failed to make the install link";
export const QUICK_DEPLOY_COPIED_MESSAGE = "Copied install command";
export const QUICK_DEPLOY_COPY_FAILED_MESSAGE = "Link made, but copying failed: copy it from the box above.";
/** Download's reason while "Install as a systemd service" is ticked (visible, and its `aria-describedby`). */
export const DOWNLOAD_NEEDS_UNTICK_WORDS =
  'The systemd service comes with Quick Deploy. Untick "Install as a systemd service" to download the bundle instead.';
/** The Linux token screen's warning (its own words: the commands are plural). */
export const LINUX_TOKEN_WARNING =
  "These commands contain the fleet's default token. Anyone holding it can enroll collectors in this fleet. Run them in a secure shell; don't paste them into shared logs or chat. If the token leaks, revoke the default token and issue a new one on the Tokens tab.";

type FactsState =
  | { kind: "loading" }
  | { kind: "read"; facts: InstallFacts }
  /** The words shown; `assign` offers the group dialog, `retry` "Try again". */
  | { kind: "refused"; error: string; assign: boolean; retry: boolean };

/** The Linux token screen: what the download was made with (the root path as typed). */
interface TokenScreen {
  method: InstallMethod;
  arch: InstallArch;
  rootPath: string;
  displayName: string;
}

/**
 * The Quick Deploy screen: the snapshot taken as the link's create was sent (the checked fields, the display name
 * trimmed) with the create's answer, its masked preview, and the command once revealed. The `url` and the command are
 * secrets: they leave the state as the dialog closes (null from then on), the rest kept so the screen stays as it was
 * through Radix's exit animation.
 */
interface QuickDeployShot {
  method: InstallMethod;
  arch: InstallArch;
  rootPath: string;
  displayName: string;
  systemd: boolean;
  url: string | null;
  link: QuickDeployLink;
  preview: string;
  command: string | null;
}

export interface InstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** The group installed into; null for the fleet's Default group. */
  groupId: string | null;
  /** A reveal's or a download's success: the route's "install started". */
  onInstallStarted: () => void;
  /** The fleet gone (or archived meanwhile): the route reads it again. */
  onFleetChanged: () => void;
  /** An assignment made here, or the group found gone: the groups shown elsewhere read again. */
  onGroupsChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the route gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: the fields afresh, no bearer, no earlier refusal. */
export function InstallDialog(props: InstallDialogProps) {
  const opening = useOpeningKey(props.open);
  return <InstallSession key={opening} {...props} />;
}

function InstallSession({
  open,
  onOpenChange,
  organizationId,
  fleetId,
  groupId,
  onInstallStarted,
  onFleetChanged,
  onGroupsChanged,
  onCloseAutoFocus,
}: InstallDialogProps) {
  // The opening's reads, its liveness (a reveal's chain and a download's answer check it) and its common refusals.
  const opening = useInstallOpening({ open, organizationId, onOpenChange, onFleetChanged, onGroupsChanged });
  const { read, live, isStillCurrent, groupGone, handledEverywhere, latest } = opening;
  const methodId = useId();

  const latestStarted = useRef(onInstallStarted);
  useEffect(() => {
    latestStarted.current = onInstallStarted;
  });

  const [group, setGroup] = useState<CollectorGroup | null>(null);
  const [factsState, setFactsState] = useState<FactsState>({ kind: "loading" });
  const [noDefaultToken, setNoDefaultToken] = useState(false);
  const loads = useRef(0);

  const [choice, setChoice] = useState<InstallMethodChoice>("container");
  const [displayName, setDisplayName] = useState("");
  // Maps, never plain objects: a variable's name is configuration text, and `constructor` or `__proto__` is a valid one.
  const [env, setEnv] = useState<EnvVarChoices>(() => new Map());
  const [rootPath, setRootPath] = useState(DEFAULT_INSTALL_ROOT_PATH);
  const [executablePath, setExecutablePath] = useState(DEFAULT_INSTALL_EXECUTABLE_PATH);
  // The fields' problems show once a reveal or a download was asked for, then live.
  const [attempted, setAttempted] = useState(false);
  const [serverProblems, setServerProblems] = useState<ReadonlyMap<string, string>>(() => new Map());

  const [bearer, setBearer] = useState<string | null>(null);
  // The default token the bearer was revealed for: a later read finding another (or none) valid takes the bearer away.
  const revealedTokenId = useRef<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const revealingRef = useRef(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);
  const downloadingRef = useRef(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [tokenScreen, setTokenScreen] = useState<TokenScreen | null>(null);

  // Quick Deploy: ticked at each opening (the session is keyed per opening).
  const [systemd, setSystemd] = useState(true);
  // The organization's public install links (on until a read says off).
  const [linksOn, setLinksOn] = useState(true);
  const linksOff = () => {
    setLinksOn(false);
    setSystemd(false);
  };
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [quickDeploy, setQuickDeploy] = useState<QuickDeployShot | null>(null);
  // The link's token refused at the reveal while another default token is valid: the screen's words (a new link).
  const [linkTokenRevoked, setLinkTokenRevoked] = useState(false);

  // Closed (by the person, or from outside: an organization switch): the bearer, the link's url and the command leave
  // the state at once, before Radix's exit animation ends. The Quick Deploy screen's other parts stay (its title, words
  // and masked preview), so the closing dialog doesn't show the form again.
  if (!open && bearer !== null) setBearer(null);
  if (!open && quickDeploy !== null && (quickDeploy.url !== null || quickDeploy.command !== null)) {
    setQuickDeploy({ ...quickDeploy, url: null, command: null });
  }

  const close = () => onOpenChange(false);

  /**
   * What a tokens read found valid: with none, the no-default-token words show. A bearer revealed earlier in this
   * opening leaves the box unless its token is still the valid one (revoked since, or revoked and replaced, it no
   * longer enrolls anything).
   */
  const validTokenFound = (valid: EnrollmentTokenListed | undefined) => {
    setNoDefaultToken(valid === undefined);
    if (valid === undefined || valid.id !== revealedTokenId.current) {
      revealedTokenId.current = null;
      setBearer(null);
    }
  };

  /** The facts' refusals (and the groups'), in the body. */
  const readRefused = (failure: unknown) => {
    if (handledEverywhere(failure)) return;
    if (failure instanceof ApiError && ASSIGN_REFUSALS.has(failure.code)) {
      setFactsState({ kind: "refused", error: failure.message, assign: true, retry: false });
      return;
    }
    if (failure instanceof ApiError && FINAL_REFUSALS.has(failure.code)) {
      setFactsState({ kind: "refused", error: failure.message, assign: false, retry: false });
      // Archived meanwhile: the page's entry points follow.
      if (failure.code === "fleet_archived") latest.current.onFleetChanged();
      return;
    }
    setFactsState({ kind: "refused", error: fleetRefusalMessage(failure, INSTALL_LOAD_FAILED_MESSAGE), assign: false, retry: true });
  };

  /** The opening's reads: the groups, then the facts and the tokens together. A later load drops an earlier one's answers. */
  const load = async () => {
    const number = ++loads.current;
    const sentIn = organizationId;
    const current = () => number === loads.current && isStillCurrent(sentIn);
    setFactsState({ kind: "loading" });
    const groups = await read((signal) => getCollectorGroups(sentIn, fleetId, { signal }));
    if (groups === null || !current()) return;
    if (!groups.ok) {
      readRefused(groups.error);
      return;
    }
    const found = groups.value.groups.find((each) => (groupId === null ? each.isDefault : each.id === groupId));
    if (found === undefined) {
      groupGone();
      return;
    }
    setGroup(found);
    const [facts, tokens, settings] = await Promise.all([
      read((signal) => getInstallFacts(sentIn, fleetId, found.id, { signal })),
      read((signal) => getEnrollmentTokens(sentIn, fleetId, { signal })),
      read((signal) => getOrganizationSettings(sentIn, { signal })),
    ]);
    if (facts === null || tokens === null || settings === null || !current()) return;
    // A settings read that failed counts as on: a create then answers the switch's refusal itself.
    if (settings.ok && !settings.value.publicInstallLinks) linksOff();
    // A tokens read that failed says nothing here: the reveal reads them again.
    if (tokens.ok) validTokenFound(validDefaultToken(tokens.value.tokens, Date.now()));
    if (facts.ok) setFactsState({ kind: "read", facts: facts.value });
    else readRefused(facts.error);
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    // One load per opening; StrictMode's second run starts it again, the first's answers dropped (`useOpeningReads`).
    if (open) void loadRef.current();
  }, [open]);

  // The inner group dialog (Assign), its focus back to "Assign", else the Method select.
  const [assignOpen, setAssignOpen] = useState(false);
  const assignFocus = useReturnFocus();
  const methodTrigger = useRef<HTMLButtonElement>(null);

  // Focus after a reveal or a download (the button pressed is gone): the box's copy button, else the token
  // screen's Reveal, else its Tokens tab link, else the Quick Deploy screen's "Done". Tried once, on the render the
  // answer brings.
  const content = useRef<HTMLDivElement>(null);
  const linuxReveal = useRef<HTMLButtonElement>(null);
  const quickReveal = useRef<HTMLButtonElement>(null);
  const quickDone = useRef<HTMLButtonElement>(null);
  const focusNext = useRef(false);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    const root = content.current;
    if (root === null) return;
    const target =
      root.querySelector<HTMLElement>('button[aria-label="Copy command"], button[aria-label="Copy commands"]') ??
      linuxReveal.current ??
      quickReveal.current ??
      root.querySelector<HTMLElement>("a[href]") ??
      quickDone.current;
    target?.focus();
  });

  /* The fields, their values as used (trimmed), and their problems. */
  const facts = factsState.kind === "read" ? factsState.facts : null;
  // A name the server's scan offers is a shell name; one that isn't is never shown or written.
  const envNames = (facts?.envVarNames ?? []).filter((name) => INSTALL_ENV_NAME_PATTERN.test(name));
  const included: IncludedEnvVar[] = envNames
    .filter((name) => env.get(name)?.included === true)
    .map((name) => ({ name, value: (env.get(name)?.value ?? "").trim() }));
  const linux = linuxOf(choice);
  const trimmedName = displayName.trim();

  // Keyed "displayName", "envCount", "rootPath", "executablePath" and `env:${name}`.
  const localProblems = new Map<string, string>();
  const nameProblem = displayNameProblem(displayName);
  if (nameProblem !== null) localProblems.set("displayName", nameProblem);
  for (const name of envNames) {
    const choiceOf = env.get(name);
    if (choiceOf?.included !== true) continue;
    const problem = envValueProblem(choiceOf.value);
    if (problem !== null) localProblems.set(`env:${name}`, problem);
  }
  const containerValid = localProblems.size === 0;
  // The bundle's request holds at most 50 variables (the facts have no such bound): never one the route refuses.
  const envCountProblem =
    linux !== null && included.length > INSTALL_ENV_MAXIMUM ? `Tick at most ${INSTALL_ENV_MAXIMUM} variables: a bundle holds no more.` : null;
  if (envCountProblem !== null) localProblems.set("envCount", envCountProblem);
  const rootPathProblem = absolutePathProblem(rootPath);
  const executablePathProblem = linux?.method === "own-binary" ? absolutePathProblem(executablePath) : null;
  if (linux !== null && rootPathProblem !== null) localProblems.set("rootPath", rootPathProblem);
  if (executablePathProblem !== null) localProblems.set("executablePath", executablePathProblem);
  const linuxValid = localProblems.size === 0;

  const shownProblem = (key: "rootPath" | "executablePath" | `env:${string}` | "displayName"): string | null =>
    (attempted ? localProblems.get(key) : undefined) ?? serverProblems.get(key) ?? null;
  const envProblems = new Map<string, string>();
  for (const name of envNames) {
    const problem = shownProblem(`env:${name}`);
    if (problem !== null) envProblems.set(name, problem);
  }

  /** Any field changed: a 400's messages and a refusal's go, the field's own stay live. */
  const edited = () => {
    setServerProblems(new Map());
    setDownloadError(null);
    setRevealError(null);
  };
  const envProps = {
    names: envNames,
    choices: env,
    onChange: (name: string, next: EnvVarChoice) => {
      setEnv((previous) => new Map(previous).set(name, next));
      edited();
    },
    problems: envProblems,
    countProblem: envCountProblem,
  };
  const onDisplayName = (value: string) => {
    setDisplayName(value);
    edited();
  };

  /* The reveal. */

  /**
   * The opening's bearer: the tokens read, the valid default token, its reveal. Throws CLOSED once the opening is
   * over. With `factsOf` (the container's), the install's facts are read again with the tokens: the fleet archived
   * or the group deleted since the opening refuses (FactsRefused), and the facts read are the ones the command is
   * built from (a mount saved meanwhile is in it).
   */
  const revealBearer = (sentIn: string, factsOf?: string): Promise<{ bearer: string; tokenId: string; facts: InstallFacts | null }> =>
    revealDefaultBearer<InstallFacts>(
      opening,
      sentIn,
      fleetId,
      factsOf === undefined ? undefined : (signal) => getInstallFacts(sentIn, fleetId, factsOf, { signal }),
    );

  /** A reveal's failure, the opening still on (the caller checks: closed or another organization says nothing). */
  const revealFailed = (failure: unknown) => {
    if (failure instanceof FactsRefused) {
      const refusal = failure.error;
      // Archived since the opening: its words, and the route reads the fleet again; unassigned or retired: Assign.
      if (refusal instanceof ApiError && (ASSIGN_REFUSALS.has(refusal.code) || FINAL_REFUSALS.has(refusal.code))) {
        readRefused(refusal);
        return;
      }
      // The group deleted since the opening (groupGone), the fleet gone, the organization's or the session's: as at the opening.
      if (handledEverywhere(refusal)) return;
      setRevealError(fleetRefusalMessage(refusal, INSTALL_LOAD_FAILED_MESSAGE));
      return;
    }
    if (failure === NO_DEFAULT_TOKEN || (failure instanceof ApiError && TOKEN_REFUSALS.has(failure.code))) {
      validTokenFound(undefined);
      return;
    }
    if (isFleetGone(failure)) toast.error(fleetRefusalMessage(failure, REVEAL_FAILED_MESSAGE));
    if (handledEverywhere(failure)) return;
    setRevealError(isUnknownOutcome(failure) ? FLEETS_UNAVAILABLE_MESSAGE : fleetRefusalMessage(failure, REVEAL_FAILED_MESSAGE));
  };

  const beginReveal = (): string | null => {
    if (revealingRef.current) return null;
    revealingRef.current = true;
    setRevealing(true);
    setRevealError(null);
    return organizationId;
  };
  const endReveal = () => {
    revealingRef.current = false;
    setRevealing(false);
  };

  /**
   * "Reveal & copy command": checked at once, then one chain handed to the
   * clipboard within the click. What happened is told by this opening's own
   * state, never by an error's identity (a browser rejects ClipboardItem's
   * write with its own NotAllowedError whatever made it fail): `built` once
   * the command was built, and `live` for the opening still on.
   */
  const revealAndCopy = () => {
    setAttempted(true);
    if (facts === null || group === null || bearer !== null || !containerValid) return;
    const parts = { displayName: trimmedName, env: included };
    const sentIn = beginReveal();
    if (sentIn === null) return;
    let built = false;
    const text = revealBearer(sentIn, group.id).then((revealed) => {
      // Closed, or another organization, before the text is built: nothing reaches the clipboard.
      if (!live(sentIn)) throw CLOSED;
      // The facts read with the tokens: the command is built from them, and the dialog shows them. A variable
      // the fresh facts no longer offer is left out, as the box (built from the same facts) leaves it.
      const fresh = revealed.facts ?? facts;
      const offered = new Set(fresh.envVarNames);
      setFactsState({ kind: "read", facts: fresh });
      focusNext.current = true;
      revealedTokenId.current = revealed.tokenId;
      setBearer(revealed.bearer);
      const builtCommand = containerCommand({
        ...parts,
        facts: fresh,
        env: parts.env.filter((each) => offered.has(each.name)),
        bearer: revealed.bearer,
      });
      built = true;
      return builtCommand;
    });
    const copied = copyTextFromPromise(text).then(
      () => true,
      () => false,
    );
    void (async () => {
      let failure: unknown = null;
      try {
        await text;
      } catch (error) {
        failure = error;
      }
      const wasCopied = await copied;
      endReveal();
      if (built) {
        latestStarted.current();
        if (wasCopied) toast.success(COPIED_MESSAGE);
        else toast.error(COPY_FAILED_MESSAGE);
        return;
      }
      if (live(sentIn)) revealFailed(failure);
    })();
  };

  /** The token screen's Reveal: the same reveal, shown in its box (copied by its button). */
  const revealForLinux = () => {
    if (bearer !== null) return;
    const sentIn = beginReveal();
    if (sentIn === null) return;
    void revealBearer(sentIn)
      .then(
        (revealed) => {
          if (!live(sentIn)) return;
          focusNext.current = true;
          revealedTokenId.current = revealed.tokenId;
          setBearer(revealed.bearer);
          latestStarted.current();
        },
        (failure: unknown) => {
          if (live(sentIn)) revealFailed(failure);
        },
      )
      .finally(endReveal);
  };

  /* The download. */

  /** A download's or a Quick Deploy link's refusal (one mapper), the opening still on. */
  const bundleRequestFailed = (failure: unknown, request: InstallBundleRequestInput, fallback: string) => {
    if (handledEverywhere(failure)) return;
    if (
      failure instanceof ApiError &&
      (failure.code === "collector_group_unassigned" || failure.code === "collector_group_assignment_deleted" || FINAL_REFUSALS.has(failure.code))
    ) {
      // The group or the fleet changed since the opening: as the facts' refusal.
      readRefused(failure);
      return;
    }
    // `collector_version_not_offered` stays inline, the form kept: on the bundle it is the arch's case (no binaries for
    // it: the other arch may have them); the facts' read already sent a distribution or a retired version to Assign.
    // The cap's refusal (`quick_deploy_link_limit_reached`) and a 429's wait show inline, as their words.
    const entries = Object.entries(bundleFieldProblemsOf(failure, request)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    if (entries.length > 0) {
      setServerProblems(new Map(entries));
      return;
    }
    setDownloadError(isUnknownOutcome(failure) ? FLEETS_UNAVAILABLE_MESSAGE : fleetRefusalMessage(failure, fallback));
  };

  const download = async () => {
    setAttempted(true);
    if (facts === null || group === null || linux === null || downloadingRef.current || creatingRef.current || systemd || !linuxValid) return;
    const request: InstallBundleRequestInput = {
      method: linux.method,
      arch: linux.arch,
      rootPath,
      ...(linux.method === "own-binary" ? { executablePath } : {}),
      env: included,
    };
    const screen: TokenScreen = { ...linux, rootPath, displayName: trimmedName };
    const sentIn = organizationId;
    downloadingRef.current = true;
    setDownloading(true);
    setDownloadError(null);
    setServerProblems(new Map());
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      const bundle = await downloadInstallBundle(sentIn, fleetId, group.id, request, { signal: guard.signal });
      // Closed meanwhile: the bundle is dropped, never saved.
      if (!live(sentIn)) return;
      downloadBlob(new Blob([bundle.archive as BlobPart], { type: "application/gzip" }), bundle.fileName);
      toast.success(DOWNLOAD_STARTED_MESSAGE);
      latestStarted.current();
      focusNext.current = true;
      setTokenScreen(screen);
    } catch (failure) {
      if (live(sentIn)) bundleRequestFailed(failure, request, DOWNLOAD_FAILED_MESSAGE);
    } finally {
      guard.clear();
      downloadingRef.current = false;
      setDownloading(false);
    }
  };

  /* Quick Deploy. */

  /**
   * "Quick Deploy": the fields checked as the download's (their messages, nothing sent), then the link's create only.
   * Its answer, the opening still on, shows the screen with the masked preview; a late answer is dropped (the link
   * stays listed, and expires).
   */
  const makeQuickDeployLink = async () => {
    setAttempted(true);
    if (facts === null || group === null || linux === null || !linksOn || creatingRef.current || downloadingRef.current || noDefaultToken || !linuxValid) {
      return;
    }
    const request: CreateQuickDeployLinkRequestInput = {
      method: linux.method,
      arch: linux.arch,
      rootPath,
      ...(linux.method === "own-binary" ? { executablePath } : {}),
      env: included,
      systemd,
    };
    // The snapshot: the fields as checked (the root path's rule holds no space; the display name trimmed).
    const shot = { ...linux, rootPath: withoutTrailingSlash(rootPath), displayName: trimmedName, systemd };
    const sentIn = organizationId;
    creatingRef.current = true;
    setCreating(true);
    setDownloadError(null);
    setServerProblems(new Map());
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      const created = await createQuickDeployLink(sentIn, fleetId, group.id, request, { signal: guard.signal });
      // Closed, or another organization, meanwhile: dropped.
      if (!live(sentIn)) return;
      const preview = quickDeployPreview({ url: created.url, rootPath: shot.rootPath, displayName: shot.displayName, systemd: shot.systemd });
      latestStarted.current();
      focusNext.current = true;
      setQuickDeploy({ ...shot, url: created.url, link: created.link, preview, command: null });
    } catch (failure) {
      if (!live(sentIn)) return;
      // No valid default token since the opening: the words, Quick Deploy disabled, the focus on their Tokens tab link
      // (the button pressed is disabled), as the reveal's refusal on the screen.
      if (failure instanceof ApiError && failure.code === "enrollment_token_default_missing") {
        focusNext.current = true;
        validTokenFound(undefined);
      } else if (failure instanceof ApiError && failure.code === "public_install_links_disabled") {
        // Turned off since the opening: Quick Deploy and the systemd box go, Download is offered.
        linksOff();
      } else bundleRequestFailed(failure, request, QUICK_DEPLOY_FAILED_MESSAGE);
    } finally {
      guard.clear();
      creatingRef.current = false;
      setCreating(false);
    }
  };

  /**
   * "Reveal & copy command" on the Quick Deploy screen: one chain handed to the clipboard within the click, the link's
   * default token revealed (the opening's bearer reused when it is that token's), the command built from the snapshot.
   * Told by this opening's own state, as the container's (`built`, `live`).
   */
  const revealQuickDeploy = () => {
    const shot = quickDeploy;
    // Closed: the url is gone (the screen kept for the exit animation has nothing to reveal).
    if (shot === null || shot.url === null || shot.command !== null) return;
    const { url } = shot;
    const sentIn = beginReveal();
    if (sentIn === null) return;
    const tokenId = shot.link.defaultTokenId;
    const kept = bearer !== null && revealedTokenId.current === tokenId ? bearer : null;
    let built = false;
    const text = (async () => {
      let token = kept;
      if (token === null) {
        const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
        try {
          token = (await revealEnrollmentToken(sentIn, fleetId, tokenId, { signal: guard.signal })).token.bearer;
        } finally {
          guard.clear();
        }
      }
      // Closed, or another organization, before the text is built: nothing reaches the clipboard.
      if (!live(sentIn)) throw CLOSED;
      const command = quickDeployCommands({ url, rootPath: shot.rootPath, bearer: token, displayName: shot.displayName, systemd: shot.systemd });
      focusNext.current = true;
      revealedTokenId.current = tokenId;
      setBearer(token);
      setQuickDeploy((current) => (current === null ? null : { ...current, command }));
      built = true;
      return command;
    })();
    const copied = copyTextFromPromise(text).then(
      () => true,
      () => false,
    );
    void (async () => {
      let failure: unknown = null;
      try {
        await text;
      } catch (error) {
        failure = error;
      }
      const wasCopied = await copied;
      if (built) {
        endReveal();
        if (wasCopied) toast.success(QUICK_DEPLOY_COPIED_MESSAGE);
        else toast.error(QUICK_DEPLOY_COPY_FAILED_MESSAGE);
        return;
      }
      if (!live(sentIn)) {
        endReveal();
        return;
      }
      if (failure instanceof ApiError && TOKEN_REFUSALS.has(failure.code)) {
        // The link's token revoked meanwhile: the tokens read again (the button still "Preparing…") to tell which words
        // take its place. Another valid default token (the link's revoked and replaced since it was made): this link can
        // never work again, a new one can; none: the no-default-token words. A read that fails can't tell: the link's
        // words, true either way.
        const tokens = await read((signal) => getEnrollmentTokens(sentIn, fleetId, { signal }));
        endReveal();
        if (tokens === null || !live(sentIn)) return;
        if (!tokens.ok && handledEverywhere(tokens.error)) return;
        const other = tokens.ok ? validDefaultToken(tokens.value.tokens.filter((each) => each.id !== tokenId), Date.now()) : undefined;
        // The focus on the words' way on: "Done", or the Tokens tab link.
        focusNext.current = true;
        if (tokens.ok && other === undefined) {
          validTokenFound(undefined);
          return;
        }
        if (other !== undefined) validTokenFound(other);
        setLinkTokenRevoked(true);
        return;
      }
      endReveal();
      revealFailed(failure);
    })();
  };

  /* What the dialog shows. */

  const title = group === null ? "Install collectors" : `Install collectors: ${group.name}`;
  const version = group?.assignedVersion ?? null;
  const description =
    group === null
      ? "Collectors installed here join the group and run its published version."
      : version !== null
        ? `Collectors installed here join ${group.name} and run its published version, ${version.configurationName} @v${version.versionNumber}.`
        : `Collectors installed here join ${group.name}.`;

  const command = facts !== null && bearer !== null && containerValid ? containerCommand({ facts, bearer, displayName: trimmedName, env: included }) : null;
  const preview = facts !== null ? containerPreview({ facts, displayName: trimmedName, env: included }) : "";

  const body = (() => {
    if (factsState.kind === "loading") {
      return (
        <p role="status" className="text-[13px] text-muted-foreground">
          Loading…
        </p>
      );
    }
    if (factsState.kind === "refused") {
      return (
        <div className="grid gap-2">
          <DialogErrorAlert error={factsState.error} />
          {(factsState.assign || factsState.retry) && (
            <div>
              {factsState.assign && group !== null ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={(event) => {
                    assignFocus.opened(event.currentTarget, () => methodTrigger.current);
                    setAssignOpen(true);
                  }}
                >
                  Assign
                </Button>
              ) : factsState.retry ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  Try again
                </Button>
              ) : null}
            </div>
          )}
        </div>
      );
    }
    if (linux === null) {
      return (
        <InstallContainerSection
          mounts={factsState.facts.mounts}
          mountsReadable={factsState.facts.mountsReadable}
          displayName={displayName}
          onDisplayName={onDisplayName}
          displayNameProblem={shownProblem("displayName")}
          env={envProps}
          preview={preview}
          command={command}
          revealed={bearer !== null}
          revealing={revealing}
          revealError={revealError}
          noDefaultToken={noDefaultToken}
          onReveal={revealAndCopy}
          onTokensTab={close}
        />
      );
    }
    return (
      <div className="grid gap-4">
        <InstallLinuxSection
          method={linux.method}
          rootPath={rootPath}
          onRootPath={(value) => {
            setRootPath(value);
            edited();
          }}
          rootPathProblem={shownProblem("rootPath")}
          executablePath={executablePath}
          onExecutablePath={(value) => {
            setExecutablePath(value);
            edited();
          }}
          executablePathProblem={shownProblem("executablePath")}
          displayName={displayName}
          onDisplayName={onDisplayName}
          displayNameProblem={shownProblem("displayName")}
          env={envProps}
          systemd={systemd}
          onSystemd={(value) => {
            setSystemd(value);
            edited();
          }}
          disabled={creating}
          systemdOffered={linksOn}
        />
        <DialogErrorAlert error={downloadError} />
      </div>
    );
  })();

  const downloadReasonId = `${methodId}-download-reason`;
  const noDefaultTokenId = `${methodId}-no-default-token`;
  const shown =
    quickDeploy !== null ? (
      <QuickDeployScreen
        systemd={quickDeploy.systemd}
        expiresAt={quickDeploy.link.expiresAt}
        preview={quickDeploy.preview}
        command={quickDeploy.command}
        revealing={revealing}
        canReveal={quickDeploy.url !== null}
        revealError={revealError}
        noDefaultToken={noDefaultToken}
        linkTokenRevoked={linkTokenRevoked}
        revealRef={quickReveal}
        doneRef={quickDone}
        onReveal={revealQuickDeploy}
        onClose={close}
      />
    ) : tokenScreen !== null ? (
      <LinuxTokenScreen
        screen={tokenScreen}
        bearer={bearer}
        revealing={revealing}
        revealError={revealError}
        noDefaultToken={noDefaultToken}
        revealRef={linuxReveal}
        onReveal={revealForLinux}
        onClose={close}
      />
    ) : (
      <>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor={methodId}>Method</Label>
            <Select
              value={choice}
              onValueChange={(value) => {
                if (!isMethodChoice(value) || value === choice) return;
                setChoice(value);
                edited();
              }}
              disabled={downloading || revealing || creating}
            >
              <SelectTrigger id={methodId} ref={methodTrigger}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-[var(--radix-select-trigger-width)]">
                {INSTALL_METHOD_CHOICES.map((each) => (
                  <SelectItem key={each} value={each} description={INSTALL_METHOD_LABELS[each].description}>
                    {INSTALL_METHOD_LABELS[each].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {body}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          {linux === null ? (
            <Button type="button" variant="outline" onClick={close}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void download()}
                disabled={facts === null || downloading || creating || systemd}
                // Named only while its reason is shown (under the footer, once the facts are read).
                aria-describedby={facts !== null && systemd ? downloadReasonId : undefined}
              >
                {downloading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Building…
                  </>
                ) : (
                  <>
                    <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                    Download
                  </>
                )}
              </Button>
              {linksOn && (
                <Button
                  type="button"
                  onClick={() => void makeQuickDeployLink()}
                  disabled={facts === null || creating || downloading || noDefaultToken}
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
            </>
          )}
        </DialogFooter>
        {/* Download's reason while the systemd service is ticked: it comes with Quick Deploy only. */}
        {linux !== null && facts !== null && systemd && (
          <p id={downloadReasonId} className="text-xs text-muted-foreground">
            {DOWNLOAD_NEEDS_UNTICK_WORDS}
          </p>
        )}
        {linux !== null && facts !== null && !linksOn && <p className="text-xs text-muted-foreground">{PUBLIC_INSTALL_LINKS_OFF_WORDS}</p>}
        {/* No valid default token: Quick Deploy has none to put in its command; the bundle downloads (it holds none), but
            its token screen will have nothing to reveal. */}
        {linux !== null && facts !== null && noDefaultToken && (
          <div id={noDefaultTokenId} className="pt-3">
            <NoDefaultToken onTokensTab={close} />
          </div>
        )}
      </>
    );

  return (
    <>
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
      {/* Assign: the group dialog for the group; its save reads everything again. */}
      <GroupDialog
        open={open && assignOpen}
        onOpenChange={setAssignOpen}
        group={group}
        organizationId={organizationId}
        fleetId={fleetId}
        onChanged={() => {
          latest.current.onGroupsChanged();
          void loadRef.current();
        }}
        onCloseAutoFocus={assignFocus.returnFocus}
      />
    </>
  );
}

/** The words under the Linux lines: where the token is kept, the root path as typed. */
export function tokenKeptWords(rootPath: string): string {
  return `The supervisor keeps the token in ${withoutTrailingSlash(rootPath)}/opamp.env (only root can read it), so later runs need no export. It runs in the foreground; a service that starts on boot comes with Quick Deploy.`;
}

/**
 * "Set the token, then run": after a download, the four lines
 * (`linuxRunCommands`) to run on the host. Before the reveal they show
 * the token masked; "Reveal" (the opening's one reveal) puts the bearer
 * in, in a `SecretCopyBox`.
 */
function LinuxTokenScreen({
  screen,
  bearer,
  revealing,
  revealError,
  noDefaultToken,
  revealRef,
  onReveal,
  onClose,
}: {
  screen: TokenScreen;
  bearer: string | null;
  revealing: boolean;
  revealError: string | null;
  noDefaultToken: boolean;
  revealRef: Ref<HTMLButtonElement>;
  onReveal: () => void;
  onClose: () => void;
}) {
  const lines = (token: string) => linuxRunCommands({ ...screen, bearer: token });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Set the token, then run</DialogTitle>
        <DialogDescription>
          On the host, in the directory holding the bundle, run these commands. They hold the fleet&apos;s default token: run them in a
          secure shell.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        {bearer !== null ? (
          <SecretCopyBox secret={lines(bearer)} copyLabel="Copy commands" multiline />
        ) : (
          <>
            <div className="ph-no-capture">
              <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">{lines(MASKED_TOKEN)}</pre>
            </div>
            {noDefaultToken ? (
              <NoDefaultToken onTokensTab={onClose} />
            ) : (
              <div>
                <Button ref={revealRef} type="button" onClick={onReveal} disabled={revealing}>
                  {revealing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      Revealing…
                    </>
                  ) : (
                    "Reveal"
                  )}
                </Button>
              </div>
            )}
          </>
        )}
        <DialogErrorAlert error={revealError} />
        <p className="ph-no-capture text-xs text-muted-foreground">{tokenKeptWords(screen.rootPath)}</p>
        <div className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{LINUX_TOKEN_WARNING}</p>
        </div>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
