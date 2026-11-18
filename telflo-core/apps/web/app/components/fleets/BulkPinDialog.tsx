import { useId, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  FLEETS_UNAVAILABLE_MESSAGE,
  type Collector,
  type CollectorGroup,
  type CollectorPinRequest,
  type FleetType,
  type PinCollectorsRequest,
  type VariablesUndefinedDetails,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { abortAfter } from "~/lib/abort-after.js";
import { isSessionEnded, pinCollectors } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_READ_TIMEOUT_MS, FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useOpeningReads } from "~/lib/hooks/use-opening-reads.js";
import { isVariableGroupGone, variablesUndefinedOf } from "~/lib/variable-group-display.js";
import {
  ConfigurationVersionPicker,
  useConfigurationPickerKept,
  useConfigurationVersions,
  usePublishedConfigurations,
} from "./CollectorPinPicker.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import { KUBERNETES_PIN_NOTE, PIN_CHOICE_LABELS } from "./EditCollectorDialog.js";
import {
  UndefinedNamesRefused,
  useOfferedVariableGroups,
  useVersionReferences,
  VariableGroupSelect,
  VariablesUsed,
} from "./VariableGroupChoice.js";

/*
 * "Pin collectors" (D17b-1 decisions 8, 12 and 27; Preflight rulings 5 and
 * 13; ADR 0018): a `max-w-2xl` dialog with a `<form>`, "Pin {n}" /
 * "Pinning…" and the toast "Pinned {n} collector(s)", over the grid's
 * selection. In the D17b-1 Parity Notes:
 *
 * - No group step and no checkbox list: the collectors are the grid's
 *   selection.
 * - **Two choices** (D20 Q103, default 24; Preflight ruling 42), both
 *   starting at "Leave as is": **Version** — "Leave as is", "Follow each
 *   collector's group" (unpins), "A published version" (the picker,
 *   `CollectorPinPicker.tsx`); **Variable group** — "Leave as is", "Follow
 *   each collector's group" (clears the pinned variable group), or one of
 *   the organization's variable groups (read at the opening,
 *   `VariableGroupChoice`). Pin is enabled once either moves off "Leave as
 *   is" (a version chosen complete). The request carries only the choices
 *   moved: "Follow each collector's group" is a null, "Leave as is" a field
 *   left out (`pin`, `pinnedVariableGroupId`). No imported configuration
 *   (D16c removed importing).
 * - **"Variables used"** (D20 Q86; the group dialogs' part,
 *   `VariableGroupChoice`'s `VariablesUsed`): for "A published version",
 *   the chosen version's organization variables no variable defines, before
 *   Pin, with "Saving is refused until they are defined on the Variables
 *   page." (a version chosen is always sent).
 * - **The snapshot** (D17c-1 Ruling 66; Preflight ruling 33): the selected
 *   collectors (their ids sent) and the lists offered (the tab's groups, the
 *   variable groups) are taken at the opening; a grid's reload while it is
 *   open changes none of them.
 * - **"Follow the group" is never refused** (D16c decision 10: the owner's
 *   Q18 refusal went with importing), whether or not the tab's groups could
 *   be read. The dialog doesn't read the groups itself; they only mark a
 *   group's published version "(group default)".
 * - **One `POST …/collectors/pin`** (decision 12: a page holds at most 50,
 *   the route takes 500): success toasts what changed (Q103; Ruling 50), n
 *   the collectors updated: the version alone "Pinned {n} collector(s)." (or
 *   "Unpinned …"); the variable group alone "Variable group set on {n}
 *   collector(s)." or, for "Follow each collector's group", "{n}
 *   collector(s) follow their group's variable group."; both "Pin and
 *   variable group set on {n} collector(s).". With "{m} were deleted
 *   meanwhile." when the API found some gone (`notFound`). Fixed words and
 *   counts, never a name.
 * - Refusals inline (`DialogErrorAlert`):
 *   `configuration_version_not_published`,
 *   `configuration_version_not_found`, a 429 and the fleet refusals (D20:
 *   `variable_group_not_found`; `variables_undefined` with its names, at
 *   most 100, then "… and N more"), else "Failed to pin collectors". `fleet_not_found` toasts the API's words
 *   (`fleetRefusalMessage`), closes and reloads. An unknown outcome (a 5xx,
 *   no connection, a reply that doesn't parse, the 30 s hang guard) shows
 *   the 503's words and keeps the dialog open: a retry sets the same pin;
 *   the dialog closed after one reloads. The organization's or the terms'
 *   refusal closes and revalidates the layout; a session ended is silent.
 * - While pinning: Cancel disabled, no X, Escape and outside clicks do
 *   nothing; every field disabled; a double Enter sends once.
 * - Each opening is a new session (`useOpeningKey`); an answer after the
 *   dialog unmounted, or for an organization no longer active, does
 *   nothing (`useStillCurrent`).
 *
 * On a Kubernetes-supervisor fleet (D17d-1 decision 4; Preflight ruling 27)
 * the edit dialog's canary note sits under the Pin select, which it
 * describes (`aria-describedby`).
 *
 * Privacy (decision 32): no name in the dialog but configuration names and
 * version labels as text, and the variable groups' names inside
 * `ph-no-capture` (Q88); every Select's item values are ids or the fixed
 * choices, never names.
 */

export const PIN_COLLECTORS_FAILED_MESSAGE = "Failed to pin collectors";

/**
 * The success toast: "Pinned 3 collectors.", "Unpinned 1 collector.", with
 * " 2 were deleted meanwhile." when some were gone. Full-stopped, as the
 * variable group's toasts are (Q103; D20 final review side 2's Nit).
 */
export function pinnedWords(pinned: number, unpinned: boolean, gone: number): string {
  const done = `${unpinned ? "Unpinned" : "Pinned"} ${pinned} collector${pinned === 1 ? "" : "s"}.`;
  if (gone === 0) return done;
  return `${done} ${gone} ${gone === 1 ? "was" : "were"} deleted meanwhile.`;
}

/** "Leave as is" and "Follow each collector's group": both choices' fixed item values (Q103), never an id. */
export const LEAVE_CHOICE = "leave";
export const FOLLOW_CHOICE = "follow";

export const LEAVE_WORDS = "Leave as is";
export const FOLLOW_EACH_WORDS = "Follow each collector's group";

/** The Version choice: left as is, each collector following its group's, or a published version. */
type BulkPinChoice = typeof LEAVE_CHOICE | typeof FOLLOW_CHOICE | "version";

function isBulkPinChoice(value: string): value is BulkPinChoice {
  return value === LEAVE_CHOICE || value === FOLLOW_CHOICE || value === "version";
}

/** The Version choice's label (Q103's "Version"): the group dialogs' words, as the picker's own Select is "Version". */
export const BULK_VERSION_LABEL = "Published version";

/** The Version Select's words. */
export const BULK_VERSION_LABELS: Record<BulkPinChoice, string> = {
  leave: LEAVE_WORDS,
  follow: FOLLOW_EACH_WORDS,
  version: PIN_CHOICE_LABELS.version,
};

function collectorsWords(count: number): string {
  return `${count} collector${count === 1 ? "" : "s"}`;
}

/** What the request changed, for its toast: each choice moved, the variable group's set or followed. */
export interface BulkPinChange {
  /** The pin sent: null unpins; undefined left as is. */
  pin: CollectorPinRequest | undefined;
  /** The variable group sent: null follows each collector's group's; undefined left as is. */
  variableGroupId: string | null | undefined;
}

/**
 * The success toast (Q103; Ruling 50), fixed words and counts: the version
 * alone today's `pinnedWords`; the variable group alone "Variable group set
 * on 12 collectors." or "12 collectors follow their group's variable group.";
 * both "Pin and variable group set on 12 collectors.". With ". 2 were deleted
 * meanwhile." when some were gone.
 */
export function bulkPinWords(change: BulkPinChange, updated: number, gone: number): string {
  if (change.variableGroupId === undefined) return pinnedWords(updated, change.pin === null, gone);
  const done =
    change.pin !== undefined
      ? `Pin and variable group set on ${collectorsWords(updated)}.`
      : change.variableGroupId === null
        ? `${collectorsWords(updated)} ${updated === 1 ? "follows its" : "follow their"} group's variable group.`
        : `Variable group set on ${collectorsWords(updated)}.`;
  if (gone === 0) return done;
  return `${done} ${gone} ${gone === 1 ? "was" : "were"} deleted meanwhile.`;
}

export interface BulkPinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected collectors, in the grid's order. */
  collectors: Collector[];
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** The tab's groups; null when they can't be read. */
  groups: CollectorGroup[] | null;
  /** The fleet's type: a Kubernetes fleet's Pin has the canary note. */
  fleetType?: FleetType;
  /** After the pin, the fleet found gone, or closing after an unknown outcome: the grid reloads its page and the fleet. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the host gives it back to the opener (D14b Ruling 46). */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: no earlier choice or refusal carries over. */
export function BulkPinDialog(props: BulkPinDialogProps) {
  const opening = useOpeningKey(props.open);
  return <BulkPinSession key={opening} {...props} />;
}

function BulkPinSession({
  open,
  onOpenChange,
  collectors: liveCollectors,
  organizationId,
  fleetId,
  groups: liveGroups,
  fleetType = "server",
  onChanged,
  onCloseAutoFocus,
}: BulkPinDialogProps) {
  // The baseline is taken at the opening, never a live prop (D17c-1 Ruling 66; Preflight ruling 33): the selection
  // (whose ids are sent) and the lists offered.
  const [collectors] = useState(liveCollectors);
  const [groups] = useState(liveGroups);
  const kubernetes = fleetType === "kubernetes-supervisor";
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const read = useOpeningReads(open, FLEET_READ_TIMEOUT_MS);
  const pinId = useId();
  const variableGroupSelectId = useId();

  const [choice, setChoice] = useState<BulkPinChoice>(LEAVE_CHOICE);
  const [configurationId, setConfigurationId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  // A configuration chosen selects its newest version once its versions are read.
  const [pickNewest, setPickNewest] = useState(false);

  const [saving, setSaving] = useState(false);
  // Reentry guard: a double Enter lands before the state re-renders.
  const savingRef = useRef(false);
  // An answer left the pin unknown: closing reloads the grid.
  const outcomeUnknownRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const configurations = usePublishedConfigurations(open, read, organizationId);
  const versions = useConfigurationVersions(read, organizationId, configurationId);
  // The picker's configurations chosen, kept while the Pin choice switches away and back.
  const pickerKept = useConfigurationPickerKept();
  // The variable group (Q103): "Leave as is" first; the list read at the opening.
  const offeredVariableGroups = useOfferedVariableGroups(open, read, organizationId);
  const [variableGroupChoice, setVariableGroupChoice] = useState<string>(LEAVE_CHOICE);
  const [undefinedRefused, setUndefinedRefused] = useState<VariablesUndefinedDetails | null>(null);
  // "Variables used" (Q86, the group dialogs' part): the published version chosen, before Pin.
  const references = useVersionReferences(
    read,
    organizationId,
    choice === "version" ? configurationId : null,
    choice === "version" ? versionId : null,
  );

  // Only a read picks: after a failed read, "Try again"'s answer still preselects the newest (the edit dialog's rule).
  if (pickNewest && versions.configurationId === configurationId && versions.status === "read") {
    setPickNewest(false);
    setVersionId(versions.versions[0]?.id ?? null);
  }

  // "(group default)" marks a group's assignment when every selected collector is in that one group.
  const groupIds = new Set(collectors.map((collector) => collector.groupId));
  const onlyGroupId = groupIds.size === 1 ? [...groupIds][0] : undefined;
  const groupDefault = groups?.find((group) => group.id === onlyGroupId)?.assignedVersion ?? null;

  const pin = ((): CollectorPinRequest | undefined => {
    switch (choice) {
      case LEAVE_CHOICE:
        return undefined;
      case FOLLOW_CHOICE:
        return null;
      case "version":
        return versionId === null ? undefined : { kind: "version", versionId };
    }
  })();
  // A version chosen without its version yet is incomplete: nothing is sent until it is.
  const versionIncomplete = choice === "version" && pin === undefined;
  const variableGroupId = variableGroupChoice === LEAVE_CHOICE ? undefined : variableGroupChoice === FOLLOW_CHOICE ? null : variableGroupChoice;
  const canSubmit = !saving && collectors.length > 0 && !versionIncomplete && (pin !== undefined || variableGroupId !== undefined);

  const close = () => {
    if (savingRef.current) return;
    onOpenChange(false);
    // The collectors may have changed: the grid reads its page again.
    if (outcomeUnknownRef.current) onChanged();
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
    // The session is over: the session-ended handler has the page.
    if (isSessionEnded(failure)) return;
    if (isFleetGone(failure)) {
      toast.error(fleetRefusalMessage(failure, PIN_COLLECTORS_FAILED_MESSAGE));
      onOpenChange(false);
      onChanged();
      return;
    }
    if (isUnknownOutcome(failure)) {
      outcomeUnknownRef.current = true;
      setError(FLEETS_UNAVAILABLE_MESSAGE);
      return;
    }
    // A variable group deleted meanwhile: its words, and the list read again (the choice then reads "no longer listed").
    if (isVariableGroupGone(failure)) offeredVariableGroups.retry();
    setUndefinedRefused(variablesUndefinedOf(failure));
    setError(fleetRefusalMessage(failure, PIN_COLLECTORS_FAILED_MESSAGE));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current || !canSubmit) return;
    // Only the choices moved off "Leave as is" (Q103): a field left out leaves each collector's as it is.
    const request: PinCollectorsRequest = { collectorIds: collectors.map((collector) => collector.id) };
    if (pin !== undefined) request.pin = pin;
    if (variableGroupId !== undefined) request.pinnedVariableGroupId = variableGroupId;
    const change: BulkPinChange = { pin, variableGroupId };
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setUndefinedRefused(null);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    let answer: Awaited<ReturnType<typeof pinCollectors>>;
    try {
      answer = await pinCollectors(sentIn, fleetId, request, { signal: guard.signal });
    } catch (failure) {
      savingRef.current = false;
      setSaving(false);
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    savingRef.current = false;
    setSaving(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success(bulkPinWords(change, answer.updated.length, answer.notFound.length));
    onOpenChange(false);
    onChanged();
  };

  const count = collectors.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-h-[90vh] max-w-2xl overflow-y-auto"
        hideCloseButton={saving}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <form onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>Pin collectors</DialogTitle>
            <DialogDescription>
              Pin the {count === 1 ? "selected collector" : `${count} selected collectors`} to a published version, a variable group,
              or both; “Follow each collector's group” clears that pin, and “Leave as is” keeps each collector's. A pinned version
              wins over the group's; a pinned variable group's overrides come first, then the group's variable group's.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor={pinId}>{BULK_VERSION_LABEL}</Label>
              <Select
                value={choice}
                onValueChange={(value) => {
                  if (!isBulkPinChoice(value) || value === choice) return;
                  setChoice(value);
                  setError(null);
                }}
                disabled={saving}
              >
                <SelectTrigger id={pinId} aria-describedby={kubernetes ? `${pinId}-note` : undefined}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={LEAVE_CHOICE}>{BULK_VERSION_LABELS.leave}</SelectItem>
                  <SelectItem value={FOLLOW_CHOICE}>{BULK_VERSION_LABELS.follow}</SelectItem>
                  <SelectItem value="version">{BULK_VERSION_LABELS.version}</SelectItem>
                </SelectContent>
              </Select>
              {kubernetes && (
                <p id={`${pinId}-note`} className="text-xs text-muted-foreground">
                  {KUBERNETES_PIN_NOTE}
                </p>
              )}
              {choice === "version" && (
                <ConfigurationVersionPicker
                  configurations={configurations}
                  versions={versions}
                  configurationId={configurationId}
                  versionId={versionId}
                  pinned={null}
                  groupDefault={groupDefault}
                  onConfiguration={(value) => {
                    setConfigurationId(value);
                    setVersionId(null);
                    setPickNewest(true);
                    setError(null);
                  }}
                  onVersion={(value) => {
                    setVersionId(value);
                    setError(null);
                  }}
                  disabled={saving}
                  kept={pickerKept}
                />
              )}
            </div>

            {/* A version chosen is always sent: pinning is refused while it uses a name no variable defines. */}
            <VariablesUsed references={references} assigns={choice === "version"} disabled={saving} />

            <VariableGroupSelect
              id={variableGroupSelectId}
              label="Variable group"
              offered={offeredVariableGroups}
              value={variableGroupChoice}
              fixed={[
                { value: LEAVE_CHOICE, label: LEAVE_WORDS },
                { value: FOLLOW_CHOICE, label: FOLLOW_EACH_WORDS },
              ]}
              onChange={(value) => {
                setVariableGroupChoice(value);
                setError(null);
              }}
              disabled={saving}
            />

            <DialogErrorAlert error={error} />
            <UndefinedNamesRefused details={error === null ? null : undefinedRefused} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Pinning…
                </>
              ) : (
                `Pin ${count}`
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
