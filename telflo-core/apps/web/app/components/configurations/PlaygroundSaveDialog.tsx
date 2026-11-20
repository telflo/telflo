import { useEffect, useRef, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { CONFIGURATION_NAME_MAXIMUM_LENGTH, type CollectorDistribution, type ConfigurationErrorCode } from "@telflo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.js";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { captureEvent } from "~/lib/analytics.js";
import { ApiError } from "~/lib/api-client.js";
import {
  configurationRefusalMessage,
  isOrganizationGone,
  isTermsAcceptanceRequired,
  useStillCurrent,
} from "~/lib/configurations.js";
import { useTermsRequired } from "~/lib/fleets.js";
import { createConfigurationFromContent, flowCopyPin, type FlowCopyPin } from "~/lib/flows/instantiate-flow.js";
import { clearStagedEdit, readStagedEdit, type ReadStagedEdit } from "~/lib/playground/staged-edit.js";
import { findDistribution, useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";

/*
 * The playground's handoff: saving or clearing the playground's edit, on the
 * signed-in configurations page (`/app`). The playground editor's and the
 * blank public editor's Save staged an edit in this browser
 * (`lib/playground/staged-edit.ts`); here, signed in, the person decides what
 * becomes of it:
 * - it opens only with a staged edit (`readStagedEdit`, which ignores and
 *   removes one older than 7 days, unreadable, or refused by the create's
 *   schema) and only once the current terms are accepted (the layout's terms
 *   dialog first; `useTermsRequired`). What it shows and sends is a snapshot
 *   read at its opening, never re-read meanwhile: a Save in another tab
 *   changes nothing here;
 * - "Save your playground configuration?": the name, editable under the
 *   create's rules (trimmed, 1 to 200 characters), and a note of its pin;
 *   **Save** creates the configuration and its version 1 in the current
 *   organization with the four content fields and both pin fields
 *   (`createConfigurationFromContent`, the create-from-a-flow path
 *   generalized; no flow's slug), removes the staged edit and opens the
 *   editor on it. Nothing is sent before that click;
 * - **Discard** asks once, "Discard your playground configuration?", and
 *   removes it; Cancel there goes back. Closing the dialog otherwise
 *   (Escape, the close button) keeps it, asked again on the next visit;
 * - a refusal keeps the staged edit (but a 401 `unauthenticated`, which
 *   signs out and removes it) and says why: a pin the catalogue no
 *   longer offers moves to the distribution's default, which a sentence
 *   says (as a flow's copy does: `flowCopyPin`), before Save and after a
 *   400 `collector_version_unknown`; a 403 `terms_acceptance_required` (or
 *   a 404 `organization_not_found`) closes it and revalidates the layout,
 *   and it opens again once the terms are accepted (or in the session's
 *   organization); anything else says the configurations' refusal words
 *   (`configurationRefusalMessage`).
 * The invariant: a staged edit becomes AT MOST ONE configuration, and only
 * the snapshot's edit is ever removed. Save first checks the staged edit is
 * still the snapshot's (by `savedAt`): one saved, discarded or replaced in
 * another tab since closes the dialog and sends nothing. A create that
 * succeeds removes the edit at once, even when the page has gone or
 * switched organization meanwhile; while it is under way an organization
 * switch opens no second dialog. Save and Discard remove the edit only
 * while it is still the snapshot's. `config_created` is captured as the
 * create dialog does, with no properties.
 *
 * The name and the text are configuration text: the name field is inside
 * `ph-no-capture`, its value only as the input's; the text is never shown.
 * Neither reaches an attribute, a toast, the page's title or a URL: every
 * word here is fixed, and the refusal's is the API's fixed message.
 */

export const PLAYGROUND_SAVE_TITLE = "Save your playground configuration?";
export const PLAYGROUND_SAVE_TEXT =
  "You have a configuration from the playground ready to save. It will be added to this organization's configurations.";
export const PLAYGROUND_DISCARD_TITLE = "Discard your playground configuration?";
export const PLAYGROUND_DISCARD_TEXT = "It's removed from this browser and can't be brought back.";
/** A refusal the configurations' words don't cover. */
export const PLAYGROUND_SAVE_FAILED_MESSAGE = "Failed to save configuration";

const VERSION_UNKNOWN: ConfigurationErrorCode = "collector_version_unknown";

/** What the dialog says when the copy moves off the staged pin; null when it doesn't. */
export function playgroundPinMovedSentence(pin: FlowCopyPin): string | null {
  if (pin.movedFrom === null) return null;
  return `Your playground configuration was built for collector v${pin.movedFrom}, which is no longer offered; it will use v${pin.version}.`;
}

/** The distribution's default version (else its first), when the catalogue lists it and it differs from `version`; else null. */
function defaultInstead(
  distributions: readonly CollectorDistribution[] | null,
  distribution: string,
  version: string,
): FlowCopyPin | null {
  const row = findDistribution(distributions, distribution);
  const fallback = row?.versions.find((offer) => offer.isDefault) ?? row?.versions[0];
  if (fallback === undefined || fallback.version === version) return null;
  return { distribution, version: fallback.version, movedFrom: version };
}

export function PlaygroundSaveDialog({ organizationId }: { organizationId: string }) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const termsRequired = useTermsRequired();
  const isStillCurrent = useStillCurrent(organizationId);

  /** The staged edit as read at the opening; null while closed. */
  const [snapshot, setSnapshot] = useState<ReadStagedEdit | null>(null);
  const [step, setStep] = useState<"save" | "discard">("save");
  const [name, setName] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The default pin offered after the API refused the staged one. */
  const [pinOffered, setPinOffered] = useState<FlowCopyPin | null>(null);
  const [busy, setBusy] = useState(false);
  // Reentry guard: a double Enter lands before `busy` has re-rendered.
  const savingRef = useRef(false);
  /** Bumped after a revalidation a refusal asked for, so the dialog may open again. */
  const [checks, setChecks] = useState(0);

  const open = snapshot !== null;
  const { distributions } = useCollectorDistributions(open);

  // Opens on a staged edit in an organization whose terms are accepted;
  // closes (keeping it) while they aren't.
  useEffect(() => {
    // A create under way, sent before the organization changed, settles
    // first: its success removes the edit, its failure looks again.
    if (organizationId === "" || termsRequired || savingRef.current) {
      setSnapshot(null);
      return;
    }
    const read = readStagedEdit();
    if (read === null) return;
    setSnapshot(read);
    setStep("save");
    setName(read.edit.name);
    setRefusal(null);
    setPinOffered(null);
  }, [organizationId, termsRequired, checks]);

  if (snapshot === null) return null;

  const staged = { collectorDistribution: snapshot.content.collectorDistribution, collectorVersion: snapshot.content.collectorVersion };
  const pin = pinOffered ?? flowCopyPin(staged, distributions);
  const moved = playgroundPinMovedSentence(pin);

  /** Closes, keeping the staged edit. */
  const close = () => {
    if (!savingRef.current) setSnapshot(null);
  };

  /** Closes, revalidates the layout, and looks again afterwards. */
  const closeAndRevalidate = () => {
    setSnapshot(null);
    void Promise.resolve(revalidate()).then(() => setChecks((count) => count + 1));
  };

  /** Whether the staged edit is still the one read at the opening (not saved, discarded or replaced in another tab since). */
  const isStillStaged = () => readStagedEdit()?.edit.savedAt === snapshot.edit.savedAt;

  const save = async () => {
    const trimmed = name.trim();
    if (savingRef.current || !trimmed) return;
    // A staged edit becomes at most one configuration. One saved,
    // discarded or replaced in another tab since the opening sends nothing.
    if (!isStillStaged()) {
      setSnapshot(null);
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setRefusal(null);
    const sentIn = organizationId;
    let editorPath: string;
    try {
      ({ editorPath } = await createConfigurationFromContent(sentIn, {
        ...snapshot.content,
        name: trimmed,
        collectorDistribution: pin.distribution,
        collectorVersion: pin.version,
      }));
    } catch (error) {
      savingRef.current = false;
      setBusy(false);
      if (!isStillCurrent(sentIn)) {
        // Left meanwhile (another organization): the kept edit is looked at again there.
        setChecks((count) => count + 1);
        return;
      }
      if (isTermsAcceptanceRequired(error) || isOrganizationGone(error)) {
        closeAndRevalidate();
        return;
      }
      if (error instanceof ApiError && error.code === VERSION_UNKNOWN) {
        const instead = defaultInstead(distributions, pin.distribution, pin.version);
        if (instead !== null) {
          setPinOffered(instead);
          return;
        }
      }
      // `collector_distribution_unknown` gets the refusal's words: an unlisted distribution has no default to offer.
      setRefusal(configurationRefusalMessage(error, PLAYGROUND_SAVE_FAILED_MESSAGE));
      return;
    }
    // Created: the edit is removed at once, even if the page has gone or moved
    // to another organization meanwhile, so it is never offered again. Only
    // the snapshot's: one staged since in another tab stays.
    if (isStillStaged()) clearStagedEdit();
    // Still busy: the editor replaces this page, and with it the dialog.
    if (!isStillCurrent(sentIn)) {
      savingRef.current = false;
      setBusy(false);
      return;
    }
    captureEvent("config_created");
    void navigate(editorPath);
  };

  const discard = () => {
    // Only the snapshot's edit: one staged since in another tab stays.
    if (isStillStaged()) clearStagedEdit();
    setSnapshot(null);
  };

  return (
    <>
      <Dialog
        open={step === "save"}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{PLAYGROUND_SAVE_TITLE}</DialogTitle>
            <DialogDescription>{PLAYGROUND_SAVE_TEXT}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="ph-no-capture space-y-2">
              <Label htmlFor="playground-config-name" className="mb-2 block">
                Configuration name
              </Label>
              <Input
                id="playground-config-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void save();
                  }
                }}
                autoFocus
                maxLength={CONFIGURATION_NAME_MAXIMUM_LENGTH}
                disabled={busy}
              />
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">pinned to collector v{pin.version}</p>
            {moved !== null && <p className="text-[12px] leading-[1.4] text-muted-foreground">{moved}</p>}
            {refusal !== null && (
              <p role="alert" className="text-[12px] leading-[1.4] text-fail">
                {refusal}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setStep("discard")} disabled={busy}>
              Discard
            </Button>
            <Button
              type="button"
              onClick={() => {
                void save();
              }}
              disabled={busy || !name.trim()}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={step === "discard"}
        onOpenChange={(next) => {
          if (!next) setStep("save");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{PLAYGROUND_DISCARD_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{PLAYGROUND_DISCARD_TEXT}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={discard}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
