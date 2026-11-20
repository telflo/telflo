import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type EnrollmentTokenListed, type FleetRotateToken } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { abortAfter } from "~/lib/abort-after.js";
import { isSessionEnded, rotateEnrollmentToken } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetFieldProblemsOf, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { formatDateTime } from "~/lib/format.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import { rotateExpiresAtFor, TOKEN_EXPIRY_PRESETS, type TokenExpiryPreset } from "./NewFleetDialog.js";
import { NO_VALID_DEFAULT_CLAUSE_ONE, noValidDefaultToken } from "./RevokeTokenDialog.js";
import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";

/*
 * Rotate: a Dialog with its presets as native radios (no radio group in
 * `components/ui`, no new dependency), 1 year the default, its grace's end as
 * a date input, its three messages, "Cancel" / "Rotate token" ("Rotating…"),
 * "Token rotated" and "Done". Its details:
 *
 * - The title "Rotate token" (no fleet label); the description, the field's
 *   label and help, and the info box say the current token expires at the
 *   grace's end (it isn't revoked), and a supervisor's restart, not a
 *   redeploy, brings a stranded collector back.
 * - **The grace in the person's time zone** (not UTC days): the default today
 *   + 30 days, set at each opening, never after the new expiry; `min` today,
 *   `max` the new expiry's local date; the grace ends at the end of the
 *   chosen local day (the next day's start less 1 ms: a wall-clock 23:59:59
 *   is an hour early where clocks fall back at midnight), capped at the new
 *   expiry, so the last day the picker allows is accepted. The three messages
 *   show under the field and keep "Rotate token" disabled; an
 *   `invalid_request` detail on `graceEndsAt` shows there in those words
 *   ("Must not be after expiresAt." as the third, any other as the second),
 *   never its own; with the field hidden (no valid rotate token) in the
 *   dialog's alert. Today and `min` are reckoned at each render and again at
 *   submit: a date that was today when the form drew, submitted after
 *   midnight, shows "…in the future."
 * - **A rotation never lengthens the current token's life**: when it
 *   expires before the end of the chosen day, the dialog says so beside
 *   the field.
 * - **No valid rotate token** (`summary.rotateToken` null): no field; the
 *   new token is current at once, and the request still carries the
 *   default grace (should another member rotate meanwhile, that token
 *   gets it).
 * - `expiresAt` and `graceEndsAt` come from one `now` at submit; the `POST`
 *   runs under the write hang guard. Refusals inline (`fleet_archived`, the
 *   fields' details, a 429 with its words), else "Failed to rotate token" (a
 *   toast). `fleet_not_found` toasts, closes and reloads. **An unknown
 *   outcome** shows the 503's words and puts "Close" in place of "Rotate
 *   token": a second rotation isn't a safe retry, so the person reloads and
 *   looks first; closing reloads the tab.
 * - **The result** shows the new rotate token's bearer once, in a
 *   `SecretCopyBox` (`ph-no-capture`), and when the token it replaces stops
 *   working: the earlier of the grace sent and that token's listed expiry
 *   (the reply carries none for it), the grace sent when the tokens read
 *   doesn't hold it (another member rotated meanwhile); with no predecessor,
 *   that the new one is current at once. The tab and the fleet reload as the
 *   result shows (the history gains the rotation). The bearer lives only in
 *   this session's state and leaves it as the dialog closes.
 * - While rotating: Cancel disabled, no X, Escape and outside clicks do
 *   nothing, every field disabled; a double Enter sends once. Each opening
 *   is a new session (`useOpeningKey`); an answer after the dialog unmounted
 *   or for an organization no longer active does nothing.
 */

export const ROTATE_DESCRIPTION =
  "Issues a new rotate token. Collectors holding the current one keep working until the grace period ends, or until it expires if that is sooner; those that accept connection settings are handed the new one on one of their next polls. The default token doesn't change.";
export const GRACE_LABEL = "Current token stops working on";
export const GRACE_HELP =
  "Defaults to 30 days from today, and at most the new token's expiry. The current token stops working at the end of the chosen day, or earlier if it expires first.";
export const NO_PREDECESSOR_FORM = "The fleet has no valid rotate token: the new one is current at once.";
export const ROTATE_INFO =
  "Running collectors are handed the new token on one of their next polls. A collector still holding the current token when it stops working (offline then, or one that doesn't accept connection settings) is refused until its supervisor restarts; it then comes back through the default token.";

/**
 * The info box's words by the tab's tokens: ROTATE_INFO while the fleet has a valid default token; with none valid,
 * NO_VALID_DEFAULT_CLAUSE_ONE (one collector: "re-install it") after "the default token"; before the tokens are read,
 * words true either way.
 */
export function rotateInfoWords(tokens: readonly EnrollmentTokenListed[] | null, now: number): string {
  if (tokens === null) return `${ROTATE_INFO.slice(0, -1)}, while the fleet has a valid one.`;
  if (noValidDefaultToken(tokens, now)) return `${ROTATE_INFO.slice(0, -1)}${NO_VALID_DEFAULT_CLAUSE_ONE}.`;
  return ROTATE_INFO;
}
export const ROTATED_NO_ACTION =
  "No action required: running collectors are handed the new token on one of their next polls, and the default token is unchanged.";
export const ROTATED_BEARER_HINT =
  "You don't need to copy it: running collectors are handed it on one of their next polls. It is shown now only; Reveal gives a new one for it.";
export const NO_PREDECESSOR_RESULT = "The fleet had no valid rotate token: the new one is current at once.";
export const ROTATE_FAILED_MESSAGE = "Failed to rotate token";

export const GRACE_REQUIRED = "Pick a grace period end date.";
export const GRACE_PAST = "Grace period end must be in the future.";
export const GRACE_AFTER_EXPIRY = "Grace period end must be on or before the new token's expiry.";

/** The API's detail for a grace after the new expiry (`modules/fleets`' rotation check). */
const GRACE_AFTER_EXPIRY_DETAIL = "Must not be after expiresAt.";

/** "The current token expires {date} on its own: …". */
export function soonerExpiryWords(expiresAt: string): string {
  return `The current token expires ${formatDateTime(expiresAt)} on its own: a later date doesn't keep it working past then.`;
}

/** "The token it replaces stops working on {date}." */
export function replacedStopsWords(at: string): string {
  return `The token it replaces stops working on ${formatDateTime(at)}.`;
}

/* ---------------------------------------------------------------------------
 * The grace's date math: local calendar dates as a date input's value
 * ("YYYY-MM-DD"), in the browser's own time zone.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar date of an instant. */
export function localDateOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A date input's value as its year, month and day; null for one that isn't a real date. */
function partsOf(date: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Noon: no time zone moves it to another day.
  const probe = new Date(year, month - 1, day, 12);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
  return [year, month, day];
}

/** `days` calendar days after a local date (noon-anchored, so a daylight-saving change never skips or repeats a day). */
export function addLocalDays(date: string, days: number): string {
  const parts = partsOf(date);
  if (parts === null) return date;
  return localDateOf(new Date(parts[0], parts[1] - 1, parts[2] + days, 12).getTime());
}

/** The last millisecond of a local day: the next day's first instant, less 1 ms. Null for a value that isn't a date. */
export function endOfLocalDay(date: string): number | null {
  const parts = partsOf(date);
  if (parts === null) return null;
  return new Date(parts[0], parts[1] - 1, parts[2] + 1, 0, 0, 0, 0).getTime() - 1;
}

/** The grace's default: today + 30 days, never after the new token's expiry's date. */
export function defaultGraceDate(expiresAt: number | null, now: number): string {
  const date = addLocalDays(localDateOf(now), 30);
  if (expiresAt === null) return date;
  const last = localDateOf(expiresAt);
  return date > last ? last : date;
}

/**
 * The grace for a chosen date (three messages; the last day is accepted):
 * empty or not a date, "Pick a grace period end date."; its
 * day's end at or before `now`, "…in the future."; a date after the new
 * expiry's date (a date comparison), "…on or before the new token's
 * expiry."; else the day's end, capped at the new expiry.
 */
export function graceOf(date: string, expiresAt: number | null, now: number): { problem: string } | { graceEndsAt: number } {
  const end = endOfLocalDay(date);
  if (end === null) return { problem: GRACE_REQUIRED };
  if (end <= now) return { problem: GRACE_PAST };
  if (expiresAt !== null && date > localDateOf(expiresAt)) return { problem: GRACE_AFTER_EXPIRY };
  return { graceEndsAt: expiresAt === null ? end : Math.min(end, expiresAt) };
}

/** An `invalid_request` detail on `graceEndsAt`, in the dialog's fixed words: never the detail's own. */
export function graceDetailWords(detail: string): string {
  return detail === GRACE_AFTER_EXPIRY_DETAIL ? GRACE_AFTER_EXPIRY : GRACE_PAST;
}

/** When the replaced token stops working: the earlier of the grace sent and its listed expiry; the grace when it isn't listed. */
export function replacedStopsAt(predecessorId: string, graceEndsAt: number, tokens: readonly EnrollmentTokenListed[] | null): string {
  const listed = tokens?.find((token) => token.id === predecessorId);
  const expiresAt = listed?.expiresAt == null ? null : Date.parse(listed.expiresAt);
  return new Date(expiresAt === null ? graceEndsAt : Math.min(graceEndsAt, expiresAt)).toISOString();
}

const DEFAULT_PRESET: TokenExpiryPreset = "1y";

function isPreset(value: string): value is TokenExpiryPreset {
  return TOKEN_EXPIRY_PRESETS.some((preset) => preset.value === value);
}

/** Where the dialog is. */
type Stage =
  | { kind: "form" }
  | { kind: "rotating" }
  /** The rotation may or may not have been made: "Close" only. */
  | { kind: "unknown" }
  /** The result, the bearer shown once; `replacesUntil` null when there was no predecessor. */
  | { kind: "rotated"; bearer: string; replacesUntil: string | null }
  /** The result after the dialog closed: the bearer gone from the state. */
  | { kind: "done"; replacesUntil: string | null };

export interface RotateTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The fleet's rotate token state (`summary.rotateToken`): null when none is valid (no grace field). */
  rotateToken: FleetRotateToken | null;
  /** The tab's tokens: the replaced token's listed expiry, for the result's date. */
  tokens: readonly EnrollmentTokenListed[] | null;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** After a rotation, a 404 for the fleet, or closing after an unknown outcome: the tab reloads, and the fleet. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: the presets and the grace afresh (today + 30 days at this opening), no earlier refusal. */
export function RotateTokenDialog(props: RotateTokenDialogProps) {
  const opening = useOpeningKey(props.open);
  return <RotateSession key={opening} {...props} />;
}

function RotateSession({ open, onOpenChange, rotateToken, tokens, organizationId, fleetId, onChanged, onCloseAutoFocus }: RotateTokenDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const graceId = useId();

  const [preset, setPreset] = useState<TokenExpiryPreset>(DEFAULT_PRESET);
  const [graceDate, setGraceDate] = useState(() => {
    const now = Date.now();
    const expiresAt = rotateExpiresAtFor(DEFAULT_PRESET, now);
    return defaultGraceDate(expiresAt === null ? null : Date.parse(expiresAt), now);
  });
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  // Reentry guard: a double Enter lands before the state re-renders.
  const rotatingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ expiresAt?: string; graceEndsAt?: string }>({});

  // The tokens as the latest render had them: the result reads the replaced token's expiry from them.
  const latestTokens = useRef(tokens);
  useEffect(() => {
    latestTokens.current = tokens;
  });

  // Closed from outside while the result shows (an organization switch closes it): the bearer leaves the state at once.
  if (!open && stage.kind === "rotated") setStage({ kind: "done", replacesUntil: stage.replacesUntil });

  const hasPredecessor = rotateToken !== null;
  const now = Date.now();
  const newExpiresAt = rotateExpiresAtFor(preset, now);
  const newExpiresAtMs = newExpiresAt === null ? null : Date.parse(newExpiresAt);
  const checked = graceOf(graceDate, newExpiresAtMs, now);
  const graceProblem = problems.graceEndsAt ?? ("problem" in checked ? checked.problem : null);
  const chosenEnd = endOfLocalDay(graceDate);
  const soonerExpiry =
    hasPredecessor && rotateToken.expiresAt !== null && chosenEnd !== null && Date.parse(rotateToken.expiresAt) < chosenEnd
      ? rotateToken.expiresAt
      : null;

  const rotating = stage.kind === "rotating";
  const locked = stage.kind !== "form";
  const canSubmit = stage.kind === "form" && (!hasPredecessor || !("problem" in checked));

  const close = () => {
    if (rotatingRef.current) return;
    onOpenChange(false);
    // The rotation may have been made: the tab reads its tokens again.
    if (stage.kind === "unknown") onChanged();
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
      toast.error(fleetRefusalMessage(failure, ROTATE_FAILED_MESSAGE));
      onOpenChange(false);
      onChanged();
      return;
    }
    if (isUnknownOutcome(failure)) {
      setStage({ kind: "unknown" });
      setError(FLEETS_UNAVAILABLE_MESSAGE);
      return;
    }
    const fields = fleetFieldProblemsOf(failure);
    if (fields.expiresAt !== undefined || fields.graceEndsAt !== undefined) {
      const graceWords = fields.graceEndsAt === undefined ? null : graceDetailWords(fields.graceEndsAt);
      setProblems({
        ...(fields.expiresAt === undefined ? {} : { expiresAt: fields.expiresAt }),
        ...(graceWords === null || !hasPredecessor ? {} : { graceEndsAt: graceWords }),
      });
      // With no valid rotate token the field is hidden: its refusal shows in the dialog's alert.
      if (graceWords !== null && !hasPredecessor) setError(graceWords);
      return;
    }
    setError(fleetRefusalMessage(failure, ROTATE_FAILED_MESSAGE));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (rotatingRef.current || !canSubmit) return;
    // One now for both instants.
    const sentAt = Date.now();
    const expiresAt = rotateExpiresAtFor(preset, sentAt);
    const expiresAtMs = expiresAt === null ? null : Date.parse(expiresAt);
    // With no valid rotate token, the default grace the field would have held.
    const grace = graceOf(hasPredecessor ? graceDate : defaultGraceDate(expiresAtMs, sentAt), expiresAtMs, sentAt);
    // A date that was today when the form last drew, past midnight now: its problem shows beside any other
    // still shown (an expiry's refusal), and the render it causes reckons today and the field's min afresh.
    if ("problem" in grace) {
      setProblems((previous) => ({ ...previous, graceEndsAt: grace.problem }));
      return;
    }
    rotatingRef.current = true;
    setStage({ kind: "rotating" });
    setError(null);
    setProblems({});
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    let rotated;
    try {
      rotated = await rotateEnrollmentToken(
        sentIn,
        fleetId,
        { expiresAt, graceEndsAt: new Date(grace.graceEndsAt).toISOString() },
        { signal: guard.signal },
      );
    } catch (failure) {
      rotatingRef.current = false;
      setStage({ kind: "form" });
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    rotatingRef.current = false;
    if (!isStillCurrent(sentIn)) {
      setStage({ kind: "form" });
      return;
    }
    const { bearer, predecessorId } = rotated.token;
    setStage({
      kind: "rotated",
      bearer,
      replacesUntil: predecessorId === null ? null : replacedStopsAt(predecessorId, grace.graceEndsAt, latestTokens.current),
    });
    onChanged();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        hideCloseButton={rotating}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (rotating) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (rotating) event.preventDefault();
        }}
      >
        {stage.kind === "rotated" || stage.kind === "done" ? (
          <>
            <DialogHeader>
              <DialogTitle>Token rotated</DialogTitle>
              <DialogDescription className="rounded-md border border-ok/25 bg-ok-soft p-3 text-[13px] text-ok">
                {ROTATED_NO_ACTION}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              {stage.kind === "rotated" && (
                <div className="grid gap-2">
                  <p className="text-[13px] font-medium text-foreground">New rotate token</p>
                  <SecretCopyBox secret={stage.bearer} copyLabel="Copy rotate token" />
                  <p className="text-xs text-muted-foreground">{ROTATED_BEARER_HINT}</p>
                </div>
              )}
              <p className="text-[13px] text-foreground">
                {stage.replacesUntil === null ? NO_PREDECESSOR_RESULT : replacedStopsWords(stage.replacesUntil)}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate>
            <DialogHeader>
              <DialogTitle>Rotate token</DialogTitle>
              <DialogDescription>{ROTATE_DESCRIPTION}</DialogDescription>
            </DialogHeader>

            <div className="grid gap-5 py-4">
              <fieldset disabled={locked}>
                <legend className="mb-2 text-[13px] font-medium text-foreground">New token expires</legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {TOKEN_EXPIRY_PRESETS.map((each) => (
                    <label
                      key={each.value}
                      className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[13px] transition-colors ${
                        preset === each.value ? "border-brand bg-brand-soft text-foreground" : "border-border text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      <input
                        type="radio"
                        name="new-expires-in"
                        value={each.value}
                        checked={preset === each.value}
                        onChange={(change) => {
                          if (!isPreset(change.target.value)) return;
                          setPreset(change.target.value);
                          setProblems({});
                          setError(null);
                        }}
                        className="h-3.5 w-3.5"
                      />
                      {each.label}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {newExpiresAt === null ? "The new token never expires." : `New token expires ${formatDateTime(newExpiresAt)}.`}
                </p>
                {problems.expiresAt !== undefined && (
                  <p className="mt-1.5 text-xs text-fail" role="alert">
                    {problems.expiresAt}
                  </p>
                )}
              </fieldset>

              {hasPredecessor ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={graceId}>{GRACE_LABEL}</Label>
                  <Input
                    id={graceId}
                    type="date"
                    value={graceDate}
                    min={localDateOf(now)}
                    max={newExpiresAtMs === null ? undefined : localDateOf(newExpiresAtMs)}
                    onChange={(change) => {
                      setGraceDate(change.target.value);
                      setProblems({});
                      setError(null);
                    }}
                    disabled={locked}
                    className="w-auto"
                    aria-invalid={graceProblem !== null || undefined}
                    aria-describedby={`${graceId}-help${graceProblem !== null ? ` ${graceId}-problem` : ""}`}
                  />
                  <p id={`${graceId}-help`} className="text-xs text-muted-foreground">
                    {GRACE_HELP}
                  </p>
                  {soonerExpiry !== null && <p className="text-xs text-warn">{soonerExpiryWords(soonerExpiry)}</p>}
                  {graceProblem !== null && (
                    <p id={`${graceId}-problem`} className="text-xs text-fail" role="alert">
                      {graceProblem}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-foreground">{NO_PREDECESSOR_FORM}</p>
              )}

              <div className="rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">{rotateInfoWords(tokens, now)}</div>

              <DialogErrorAlert error={error} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={rotating}>
                Cancel
              </Button>
              {stage.kind === "unknown" ? (
                <Button type="button" onClick={close}>
                  Close
                </Button>
              ) : (
                <Button type="submit" disabled={!canSubmit}>
                  {rotating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      Rotating…
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                      Rotate token
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
