import { Loader2 } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEET_LABEL_MAXIMUM_LENGTH, FleetLabelSchema, type Fleet, type FleetErrorCode, type FleetType } from "@telflo/contracts";
import { COPY_THEM_NOW, CreatedFleetTokens, type CreatedTokens } from "~/components/fleets/CreatedFleetTokens.js";
import { DialogErrorAlert } from "~/components/fleets/DialogErrorAlert.js";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { abortAfter } from "~/lib/abort-after.js";
import {
  ApiError,
  createFleet,
  getEnrollmentTokens,
  isSessionEnded,
  revealEnrollmentToken,
  type FleetCreateOutcome,
} from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import {
  FLEET_WRITE_TIMEOUT_MS,
  fleetFieldProblemsOf,
  fleetRefusalMessage,
  isUnknownOutcome,
  type FleetField,
} from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { randomUuid } from "~/lib/ids.js";

/*
 * The create dialogs' shared body: the dialogs differ only in their title,
 * text and the Token expiry field, which `NewServerFleetDialog` and
 * `NewKubernetesFleetDialog` give. Its details:
 *
 * - The Name is trimmed before it is sent; a name the contract still refuses
 *   (`FleetLabelSchema`: a control character, say) shows its words under the
 *   field and nothing is sent. "…within your org." reads "…within your
 *   organization.".
 * - The request carries an id the dialog made when it opened (`randomUuid`:
 *   `crypto.randomUUID`, else `getRandomValues`), so a retry is safe.
 * - **An unknown outcome** (`isUnknownOutcome`: any 5xx, no connection, a
 *   reply that doesn't parse, or the create's 30 s hang guard) locks the
 *   Name and Token expiry, says "The fleet may or may not have been
 *   created. Trying again won't make a second one.", and the button reads
 *   "Try again": it resends the same id, label and type, the expiry computed
 *   again. A 201 shows the tokens; a 200 (the earlier attempt made it) reads
 *   the fleet's tokens and reveals both, or says it couldn't.
 * - While locked, any other refusal (a 429, a 400, a 403 other than the
 *   terms') proves nothing was done this time: the lock stays and its words
 *   show. A 409 `fleet_label_taken` unlocks (the opamp-server reads the id
 *   before the label, so no fleet holds the id here), the id kept.
 * - **409 `fleet_conflict`:** once any attempt in this dialog had an unknown
 *   outcome, the id is kept until the dialog closes, and a `fleet_conflict`
 *   (this organization's fleet may hold the id under another label, renamed
 *   meanwhile) toasts "This fleet may already exist under another name:
 *   check the list before creating another.", closes the dialog and reloads
 *   the list. With no unknown outcome (another organization's fleet holding
 *   the same random id) it makes a new id and shows the API's words, the
 *   dialog open. So no retry makes a second fleet.
 * - A 403 `terms_acceptance_required` or 404 `organization_not_found` closes
 *   the dialog and revalidates the layout, while locked too; a session ended
 *   is silent (the session-ended handler has the page). Anything else shows
 *   `fleetRefusalMessage`'s words, or "Failed to create fleet"; a 400's
 *   details naming a field show under it.
 * - On success the dialog shows both bearers once (`CreatedFleetTokens`) and
 *   toasts `Fleet "{label}" created` (no bearer). Done forgets the bearers,
 *   closes and opens the fleet's page.
 * - **Closing:** Cancel, Escape, an outside click and the X do nothing while
 *   the create is under way, and once the tokens show only Done closes it (no
 *   X), so a bearer isn't lost to a stray click. Closing after an unknown
 *   outcome reloads the list (`onMayHaveCreated`): a fleet may have been
 *   made. An organization switch closes it whatever it shows: the bearers are
 *   dropped from its state as it closes, and a create's answer arriving after
 *   the switch (201, or a 200 and its reveals) shows nothing and toasts
 *   nothing.
 * No fleet label, and no bearer, goes in an attribute, a toast other than the
 * label's own (masked: the shell is ph-mask), a log, a URL or storage.
 */

export const CREATE_FAILED_MESSAGE = "Failed to create fleet";

/** After an unknown outcome, while the fields are locked. */
export const UNKNOWN_OUTCOME_MESSAGE = "The fleet may or may not have been created. Trying again won't make a second one.";

/** The toast of a `fleet_conflict` after an unknown outcome, as the dialog closes. */
export const MAY_ALREADY_EXIST_MESSAGE =
  "This fleet may already exist under another name: check the list before creating another.";

/** A retry answered 200, but the fleet's tokens couldn't be read or revealed. */
export const EARLIER_ATTEMPT_TOKENS_FAILED_MESSAGE =
  "The fleet was created by your earlier attempt, but its tokens couldn't be shown here. Delete it and create it again to get new tokens.";

/** The Token expiry presets, "Never" the default: days of 86,400,000 ms, not calendar years. */
export const TOKEN_EXPIRY_PRESETS = [
  { value: "never", label: "Never", days: null },
  { value: "180d", label: "180 days", days: 180 },
  { value: "1y", label: "1 year", days: 365 },
  { value: "2y", label: "2 years", days: 730 },
] as const;

export type TokenExpiryPreset = (typeof TOKEN_EXPIRY_PRESETS)[number]["value"];

const DAY_MS = 86_400_000;

function isPreset(value: string): value is TokenExpiryPreset {
  return TOKEN_EXPIRY_PRESETS.some((preset) => preset.value === value);
}

/** When a preset's rotate token expires, from `now` (each send's own: the server doesn't compare it on a retry); null for Never. */
export function rotateExpiresAtFor(preset: TokenExpiryPreset, now: number): string | null {
  const days = TOKEN_EXPIRY_PRESETS.find((each) => each.value === preset)?.days ?? null;
  return days === null ? null : new Date(now + days * DAY_MS).toISOString();
}

const FLEET_CONFLICT: FleetErrorCode = "fleet_conflict";
const FLEET_LABEL_TAKEN: FleetErrorCode = "fleet_label_taken";

/** What the dialog's caller gives every create dialog. */
export interface NewFleetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The organization the fleet is made in: the active one. */
  organizationId: string;
  /** Called as the dialog closes after an unknown outcome: the list reloads, as a fleet may have been made. */
  onMayHaveCreated?: (() => void) | undefined;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the page gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** What each type's dialog says, and whether it asks for the Token expiry. */
interface NewFleetDialogText {
  type: FleetType;
  title: string;
  description: string;
  /** A paragraph above the Name, if any. */
  intro?: ReactNode;
  withExpiry: boolean;
}

/** Where the dialog is: the form (or the create under way), the tokens shown once, or closing after Done. */
type Stage =
  | { kind: "form" }
  | { kind: "creating" }
  | { kind: "created"; fleetId: string; tokens: CreatedTokens | null }
  | { kind: "done" };

/**
 * A create dialog. Each opening is a new session, with its own id and empty
 * fields: a session's state is never carried into the next opening.
 */
export function NewFleetDialog(props: NewFleetDialogProps & NewFleetDialogText) {
  const opening = useOpeningKey(props.open);
  return <NewFleetSession key={opening} {...props} />;
}

function NewFleetSession({
  open,
  onOpenChange,
  organizationId,
  onMayHaveCreated,
  onCloseAutoFocus,
  type,
  title,
  description,
  intro,
  withExpiry,
}: NewFleetDialogProps & NewFleetDialogText) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const nameId = useId();
  const expiryId = useId();

  /** The id every attempt of this session sends: kept through retries, new only on a `fleet_conflict` with no unknown outcome. */
  const [fleetId, setFleetId] = useState(randomUuid);
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<TokenExpiryPreset>("never");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  /** The Name and Token expiry locked, after an unknown outcome until a `fleet_label_taken`. */
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Partial<Record<FleetField, string>>>({});
  /** Whether any attempt of this session had an unknown outcome: never cleared, so a later `fleet_conflict` closes. */
  const hadUnknownOutcome = useRef(false);
  // Reentry guard: a double Enter lands before the state re-renders.
  const creatingRef = useRef(false);

  // Closed from outside while the tokens show (an organization switch closes it): the bearers leave the
  // session's state at once, not when the next opening replaces the session.
  if (!open && stage.kind === "created") setStage({ kind: "done" });

  const creating = stage.kind === "creating";
  /** Nothing but Done closes the dialog: while it works, and once the tokens show. */
  const blocked = stage.kind !== "form";
  const trimmed = label.trim();
  const canSubmit = stage.kind === "form" && trimmed.length > 0;

  const close = () => {
    if (creatingRef.current) return;
    if (hadUnknownOutcome.current) onMayHaveCreated?.();
    onOpenChange(false);
  };

  const showTokens = (fleet: Fleet, tokens: CreatedTokens) => {
    setStage({ kind: "created", fleetId: fleet.id, tokens });
    toast.success(`Fleet "${fleet.label}" created`);
  };

  const refused = (failure: unknown) => {
    setStage({ kind: "form" });
    if (isUnknownOutcome(failure)) {
      hadUnknownOutcome.current = true;
      setLocked(true);
      return;
    }
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      close();
      void revalidate();
      return;
    }
    // The session is over: the session-ended handler has the page.
    if (isSessionEnded(failure)) return;
    if (failure instanceof ApiError && failure.code === FLEET_CONFLICT) {
      if (hadUnknownOutcome.current) {
        toast.warning(MAY_ALREADY_EXIST_MESSAGE);
        close();
        return;
      }
      setFleetId(randomUuid());
      setError(fleetRefusalMessage(failure, CREATE_FAILED_MESSAGE));
      return;
    }
    if (failure instanceof ApiError && failure.code === FLEET_LABEL_TAKEN) setLocked(false);
    // A 400's details naming a field show under it; the Kubernetes dialog has no Token expiry to show one under.
    const fieldProblems = fleetFieldProblemsOf(failure);
    const shown: Partial<Record<FleetField, string>> = {};
    if (fieldProblems.label !== undefined) shown.label = fieldProblems.label;
    if (withExpiry && fieldProblems.rotateExpiresAt !== undefined) shown.rotateExpiresAt = fieldProblems.rotateExpiresAt;
    if (Object.keys(shown).length > 0) {
      setProblems(shown);
      return;
    }
    setError(fleetRefusalMessage(failure, CREATE_FAILED_MESSAGE));
  };

  /**
   * A retry answered 200: the earlier attempt made the fleet, and no bearer
   * came back. Its tokens (newest first): the default, and the newest rotate
   * token neither revoked nor rotated; then both revealed at once. Null if any
   * step fails (a reveal's 409 `enrollment_token_expired` decides expiry, not
   * the browser's clock) or no token fits. Each step has the 30 s hang guard.
   */
  const revealExisting = async (sentIn: string, createdId: string): Promise<CreatedTokens | null> => {
    const read = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    let listed;
    try {
      listed = (await getEnrollmentTokens(sentIn, createdId, { signal: read.signal })).tokens;
    } catch {
      return null;
    } finally {
      read.clear();
    }
    const defaultToken = listed.find((token) => token.kind === "default");
    const rotateToken = listed.find((token) => token.kind === "rotate" && token.revokedAt === null && !token.doRefresh);
    if (defaultToken === undefined || rotateToken === undefined) return null;
    const reveals = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      const [revealedDefault, revealedRotate] = await Promise.all([
        revealEnrollmentToken(sentIn, createdId, defaultToken.id, { signal: reveals.signal }),
        revealEnrollmentToken(sentIn, createdId, rotateToken.id, { signal: reveals.signal }),
      ]);
      return {
        defaultBearer: revealedDefault.token.bearer,
        rotateBearer: revealedRotate.token.bearer,
        rotateExpiresAt: revealedRotate.token.expiresAt,
      };
    } catch {
      // The other reveal, if still under way, is no longer wanted.
      reveals.abort();
      return null;
    } finally {
      reveals.clear();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (creatingRef.current || stage.kind !== "form" || trimmed === "") return;
    const checked = FleetLabelSchema.safeParse(trimmed);
    if (!checked.success) {
      setError(null);
      setProblems({ label: checked.error.issues[0]?.message ?? CREATE_FAILED_MESSAGE });
      return;
    }
    creatingRef.current = true;
    setStage({ kind: "creating" });
    setError(null);
    setProblems({});
    const sentIn = organizationId;
    const request = {
      id: fleetId,
      label: trimmed,
      type,
      // Computed at each send: a retry an hour later expires an hour later.
      rotateExpiresAt: rotateExpiresAtFor(withExpiry ? expiry : "never", Date.now()),
    };
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    let outcome: FleetCreateOutcome;
    try {
      outcome = await createFleet(sentIn, request, { signal: guard.signal });
    } catch (failure) {
      creatingRef.current = false;
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    if (outcome.kind === "created") {
      creatingRef.current = false;
      if (!isStillCurrent(sentIn)) return;
      showTokens(outcome.fleet, {
        defaultBearer: outcome.tokens.default.bearer,
        rotateBearer: outcome.tokens.rotate.bearer,
        rotateExpiresAt: outcome.tokens.rotate.expiresAt,
      });
      return;
    }
    const tokens = isStillCurrent(sentIn) ? await revealExisting(sentIn, outcome.fleet.id) : null;
    creatingRef.current = false;
    if (!isStillCurrent(sentIn)) return;
    if (tokens === null) setStage({ kind: "created", fleetId: outcome.fleet.id, tokens: null });
    else showTokens(outcome.fleet, tokens);
  };

  /** Forgets the bearers, closes, and opens the new fleet's page. */
  const done = () => {
    if (stage.kind !== "created") return;
    const createdId = stage.fleetId;
    setStage({ kind: "done" });
    onOpenChange(false);
    void navigate(`/fleet-management/${createdId}`);
  };

  const describedBy = (...ids: Array<string | false>) => ids.filter(Boolean).join(" ") || undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !blocked) close();
      }}
    >
      <DialogContent
        className="max-w-lg"
        hideCloseButton={blocked}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (blocked) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (blocked) event.preventDefault();
        }}
      >
        {stage.kind === "created" || stage.kind === "done" ? (
          <>
            <DialogHeader>
              <DialogTitle>Fleet created</DialogTitle>
              <DialogDescription>
                {stage.kind === "created" && stage.tokens === null ? EARLIER_ATTEMPT_TOKENS_FAILED_MESSAGE : COPY_THEM_NOW}
              </DialogDescription>
            </DialogHeader>
            {stage.kind === "created" && stage.tokens !== null && <CreatedFleetTokens tokens={stage.tokens} />}
            <DialogFooter>
              <Button type="button" onClick={done}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              {intro !== undefined && <p className="text-xs text-muted-foreground">{intro}</p>}

              <div className="grid gap-2">
                <Label htmlFor={nameId}>Name</Label>
                <Input
                  id={nameId}
                  value={label}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    if (problems.label !== undefined) setProblems(({ label: _label, ...rest }) => rest);
                  }}
                  placeholder="prod-otel-fleet"
                  maxLength={FLEET_LABEL_MAXIMUM_LENGTH}
                  disabled={creating || locked}
                  autoComplete="off"
                  aria-invalid={problems.label !== undefined || undefined}
                  aria-describedby={describedBy(`${nameId}-help`, problems.label !== undefined && `${nameId}-problem`)}
                />
                <p id={`${nameId}-help`} className="text-xs text-muted-foreground">
                  Fleet name must be unique within your organization.
                </p>
                {problems.label !== undefined && (
                  <p id={`${nameId}-problem`} className="text-xs text-fail" role="alert">
                    {problems.label}
                  </p>
                )}
              </div>

              {withExpiry && (
                <div className="grid gap-2">
                  <Label htmlFor={expiryId}>Token expiry</Label>
                  <Select
                    value={expiry}
                    onValueChange={(value) => {
                      if (isPreset(value)) setExpiry(value);
                      if (problems.rotateExpiresAt !== undefined) setProblems(({ rotateExpiresAt: _expiry, ...rest }) => rest);
                    }}
                    disabled={creating || locked}
                  >
                    <SelectTrigger
                      id={expiryId}
                      aria-invalid={problems.rotateExpiresAt !== undefined || undefined}
                      aria-describedby={describedBy(
                        `${expiryId}-help`,
                        problems.rotateExpiresAt !== undefined && `${expiryId}-problem`,
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TOKEN_EXPIRY_PRESETS.map((preset) => (
                        <SelectItem key={preset.value} value={preset.value}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p id={`${expiryId}-help`} className="text-xs text-muted-foreground">
                    Collectors authenticate to this fleet with a token. You can rotate or revoke it at any time from the
                    Tokens tab.
                  </p>
                  {problems.rotateExpiresAt !== undefined && (
                    <p id={`${expiryId}-problem`} className="text-xs text-fail" role="alert">
                      {problems.rotateExpiresAt}
                    </p>
                  )}
                </div>
              )}

              {locked && <DialogErrorAlert error={UNKNOWN_OUTCOME_MESSAGE} />}
              <DialogErrorAlert error={error} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {creating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Creating…
                  </>
                ) : locked ? (
                  "Try again"
                ) : (
                  "Create fleet"
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
