import { hasYamlControlCharacter, type ConfigurationValidationResponse } from "@telflo/contracts";
import { useEffect } from "react";

import { ApiError, validateAnonymously, validateVersion } from "~/lib/api-client.js";
import { readText } from "~/lib/graph/parse.js";
import { isBlank, useEditorStore, type CollectorValidationOutcome, type EditorState } from "~/lib/stores/editor-store.js";

/** How long after the last change to the text a check is sent. */
export const VALIDATION_DEBOUNCE_MS = 2000;

/** The words when the API couldn't be reached at all. */
export const VALIDATION_UNREACHABLE_MESSAGE = "Couldn't reach the validation service. Your YAML was not checked.";

/**
 * How long a 429 waits when it gave no `Retry-After` the client could read
 * (the API's in-flight answer's 1 s), and the least it ever waits (a
 * `Retry-After: 0`, or a date already past, never asks in a tight loop).
 */
const MIN_RETRY_AFTER_SECONDS = 1;

/**
 * How long one text is asked about again while the API answers 429: a retry is
 * sent after each `Retry-After` only while it falls within this long after the
 * first refusal. Then it stays unavailable, with
 * `VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE`, until something changes.
 */
export const RATE_LIMIT_RETRY_WINDOW_MS = 60_000;

/**
 * A safety bound only, never reached while the clock moves forward: at least
 * a second between asks gives at most 61 inside the window.
 */
const MAX_RATE_LIMITED_ASKS = 100;

/** What the bar says once a rate-limited text is no longer asked about again. */
export const VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE =
  "Too many checks. Your YAML was not checked — make a change to check it again.";

/** An answer the contract doesn't allow, or one about another pin than the one asked about. */
export const VALIDATION_UNEXPECTED_MESSAGE = "The server returned an unexpected response.";

/** Text holding a C0 control character YAML can't hold, which the API refuses, is never sent. */
export const VALIDATION_CONTROL_CHARACTER_MESSAGE = "Your YAML holds a control character, so it was not checked.";

/**
 * What a check is for: the version, the text and the pin on screen, and the
 * load that put them there (`loadCount`), so a version opened again, even
 * with the same text and pin, is a new opening.
 */
interface Subject {
  loadCount: number;
  versionId: string;
  text: string;
  collectorVersion: string;
}

function subjectOf(state: EditorState): Subject | null {
  if (state.version === null || state.configuration === null || state.organizationId === null) return null;
  if (state.collectorVersion === null) return null;
  return {
    loadCount: state.loadCount,
    versionId: state.version.id,
    text: state.text,
    collectorVersion: state.collectorVersion,
  };
}

function sameSubject(one: Subject | null, other: Subject | null): boolean {
  if (one === null || other === null) return one === other;
  return (
    one.loadCount === other.loadCount &&
    one.versionId === other.versionId &&
    one.text === other.text &&
    one.collectorVersion === other.collectorVersion
  );
}

/**
 * The answer, as the store keeps it, for the pin it was asked about. An
 * `invalid` without errors is no answer the contract allows, and one about
 * another collector version answers nothing about this pin: unavailable.
 */
function outcomeOf(answer: ConfigurationValidationResponse, collectorVersion: string): CollectorValidationOutcome {
  if (answer.collectorVersion !== collectorVersion) return { status: "unavailable", message: VALIDATION_UNEXPECTED_MESSAGE };
  switch (answer.status) {
    case "valid":
      return { status: "valid", collectorVersion: answer.collectorVersion, requirements: answer.requirements };
    case "invalid":
      if (answer.errors.length === 0) return { status: "unavailable", message: VALIDATION_UNEXPECTED_MESSAGE };
      return {
        status: "invalid",
        collectorVersion: answer.collectorVersion,
        errors: answer.errors,
        requirements: answer.requirements,
      };
    case "retired":
      return { status: "retired", collectorVersion: answer.collectorVersion };
  }
}

/** What the bar says when the anonymous validate refused a text as too large (413). */
export const VALIDATION_TOO_LARGE_MESSAGE = "This YAML is too large to check here, so it was not checked.";

/** What a check is sent with: the version, the text and the pin on screen. */
export type ValidationSubject = Pick<Subject, "versionId" | "text" | "collectorVersion">;

/**
 * Where a check goes, and how:
 * - `debounceMs`: how long after the last change to the text it is sent;
 * - `checkOpenedAtOnce`: whether a version just opened is checked at once,
 *   or after the debounce too;
 * - `rateLimitedCode`: the 429's code, asked again after `Retry-After`;
 * - `showsCountdown`: whether a rate-limited outcome carries `retryAt`, for
 *   the status bar's countdown;
 * - `send`: the request, its answer in the contract's response.
 */
export interface ValidationSource {
  debounceMs: number;
  checkOpenedAtOnce: boolean;
  rateLimitedCode: string;
  showsCountdown: boolean;
  send: (state: EditorState, subject: ValidationSubject, signal: AbortSignal) => Promise<ConfigurationValidationResponse>;
}

/** The signed-in editor's: its configuration's version's validation route, 2 s, an opened version at once. */
export const SIGNED_IN_VALIDATION: ValidationSource = {
  debounceMs: VALIDATION_DEBOUNCE_MS,
  checkOpenedAtOnce: true,
  rateLimitedCode: "validation_rate_limited",
  showsCountdown: false,
  send: (state, subject, signal) =>
    validateVersion(
      state.organizationId!,
      state.configuration!.id,
      subject.versionId,
      { yaml: subject.text, collectorVersion: subject.collectorVersion },
      { signal },
    ),
};

/** How long after an opening or a change the playground checks: a 1.5 s pause. */
export const ANONYMOUS_VALIDATION_DEBOUNCE_MS = 1500;

/**
 * The playground's and the blank public editor's: the anonymous validate,
 * `{ yaml, distribution, collectorVersion }`, 1.5 s after an opening or a
 * change (an opened text is checked after the pause too), its 429
 * `rate_limited` counted down. Its verdict is read as the contract's response
 * with no requirements (the anonymous route reports none); a retired pin (400
 * `collector_version_retired`) as `retired`, as the signed-in editor shows it;
 * a 413 (the API's, or the gateway's own page) as too large to check.
 * Organization variables don't exist there (`${org:NAME}` stays as written).
 */
export const ANONYMOUS_VALIDATION: ValidationSource = {
  debounceMs: ANONYMOUS_VALIDATION_DEBOUNCE_MS,
  checkOpenedAtOnce: false,
  rateLimitedCode: "rate_limited",
  showsCountdown: true,
  send: async (state, subject, signal) => {
    try {
      const answer = await validateAnonymously(
        { yaml: subject.text, distribution: state.configuration!.collectorDistribution, collectorVersion: subject.collectorVersion },
        { signal },
      );
      return answer.valid
        ? { status: "valid", collectorVersion: answer.collectorVersion, errors: [], requirements: [] }
        : { status: "invalid", collectorVersion: answer.collectorVersion, errors: answer.errors, requirements: [] };
    } catch (error) {
      if (error instanceof ApiError && error.code === "collector_version_retired") {
        return { status: "retired", collectorVersion: subject.collectorVersion, errors: [], requirements: [] };
      }
      // The API's 413 is `payload_too_large`; behind the gateway, nginx's own
      // 1 MiB 413 is an HTML page, read as `unexpected_response` with the
      // status: any 413 is too large to check.
      if (error instanceof ApiError && (error.code === "payload_too_large" || error.status === 413)) {
        throw new ApiError("payload_too_large", VALIDATION_TOO_LARGE_MESSAGE, { status: 413 });
      }
      throw error;
    }
  },
};

/**
 * The checks themselves, outside React (the hook below runs them while the
 * editor page is mounted): it watches the store's version, text and pin on
 * screen and asks the API (`validateVersion`), keeping each answer in the
 * store with what it was for (`setValidation`; `selectCollectorValidation`
 * shows it only while exactly that is on screen). The rules:
 * - a version opened (every load, the same version opened again included:
 *   a re-read after a refused publish, a reload in another organization),
 *   or a pin changed, is checked at once; a change to the text alone, typed
 *   or from the canvas, 2 s after the last one;
 * - empty or whitespace-only text and text that doesn't parse (`readText`)
 *   send nothing: idle. Text that parses but holds a C0 control character
 *   YAML can't hold (the API refuses it) sends nothing either,
 *   and shows unavailable, so Apply says it applies unchecked YAML;
 * - only the latest check's answer is kept (a sequence number, taken before
 *   any wait), so an older text's or pin's answer never lands; and a text
 *   put back to the one last answered (an undo inside the debounce) shows
 *   that answer at once, with nothing sent, so the status never sticks at
 *   validating;
 * - a published version is checked too;
 * - the pin on screen is always sent as `collectorVersion`, so
 *   the answer is about it whatever the version's saved pin is meanwhile (a
 *   save under way, another tab's); an answer about another version is
 *   unavailable;
 * - 429 shows unavailable with the API's message, and is asked again after
 *   each `Retry-After` (at least 1 s) while nothing changes, as long as the
 *   retry falls within `RATE_LIMIT_RETRY_WINDOW_MS` of the first refusal (a
 *   slot can be held 20 s, a per-minute limit lifts within the minute); then
 *   unavailable with `VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE` until a change;
 *   503 and every other refusal show unavailable with the API's message; no
 *   answer at all, "Couldn't reach the validation service. Your YAML was not
 *   checked.";
 * - a check another supersedes (anything that drops its answer: a change,
 *   a newer check, the stop) is aborted, in the browser only: the API
 *   keeps the person's in-flight slot until the validator answers, so a
 *   quick re-pick may still meet "Too many checks at once" and retry
 *   about a second later. An aborted check shows nothing and is never
 *   asked again;
 * - stopping cancels the timers, and drops any answer still to come.
 * Returns the stop. `source` says where the checks go (`SIGNED_IN_VALIDATION`
 * unless given; the playground's is `ANONYMOUS_VALIDATION`): its
 * debounce, whether an opening is checked at once, its 429's code, and
 * whether a rate-limited outcome carries `retryAt` for the countdown.
 */
export function startCollectorValidation(source: ValidationSource = SIGNED_IN_VALIDATION): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The latest check's number: an answer to any other is dropped. */
  let sequence = 0;
  let stopped = false;
  let seen: Subject | null = null;
  /** The check still waiting on the API, if any: aborted whenever its answer would be dropped. */
  let inFlight: AbortController | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const abortInFlight = () => {
    inFlight?.abort();
    inFlight = null;
  };

  const keep = (subject: Subject, outcome: CollectorValidationOutcome) => {
    const { versionId, text, collectorVersion } = subject;
    useEditorStore.getState().setValidation({ versionId, text, collectorVersion, outcome });
  };

  /**
   * Checks what is on screen now. While the API answers 429 for it,
   * `rateLimited` holds when the first refusal came and how many asks were
   * refused; null otherwise.
   */
  const check = (rateLimited: { since: number; asks: number } | null) => {
    clearTimer();
    abortInFlight();
    const state = useEditorStore.getState();
    const subject = subjectOf(state);
    const thisCheck = ++sequence;
    if (subject === null || isBlank(subject.text)) return;
    if (!readText(subject.text).ok) {
      keep(subject, { status: "idle" });
      return;
    }
    if (hasYamlControlCharacter(subject.text)) {
      keep(subject, { status: "unavailable", message: VALIDATION_CONTROL_CHARACTER_MESSAGE });
      return;
    }
    const { organizationId, configuration } = state;
    if (organizationId === null || configuration === null) return;
    const controller = new AbortController();
    inFlight = controller;
    /** Whether this check's answer is still wanted (an aborted one never is). */
    const current = () => !stopped && thisCheck === sequence && !controller.signal.aborted;
    source.send(state, subject, controller.signal).then(
      (answer) => {
        if (inFlight === controller) inFlight = null;
        if (!current()) return;
        keep(subject, outcomeOf(answer, subject.collectorVersion));
      },
      (error: unknown) => {
        if (inFlight === controller) inFlight = null;
        if (!current()) return;
        if (!(error instanceof ApiError) || error.code === "network_error") {
          keep(subject, { status: "unavailable", message: VALIDATION_UNREACHABLE_MESSAGE });
          return;
        }
        if (error.code !== source.rateLimitedCode) {
          keep(subject, { status: "unavailable", message: error.message });
          return;
        }
        const now = Date.now();
        const refused = { since: rateLimited?.since ?? now, asks: (rateLimited?.asks ?? 0) + 1 };
        const waitMs = Math.max(MIN_RETRY_AFTER_SECONDS, error.retryAfterSeconds ?? MIN_RETRY_AFTER_SECONDS) * 1000;
        if (now + waitMs - refused.since > RATE_LIMIT_RETRY_WINDOW_MS || refused.asks >= MAX_RATE_LIMITED_ASKS) {
          keep(subject, { status: "unavailable", message: VALIDATION_RATE_LIMIT_GAVE_UP_MESSAGE });
          return;
        }
        keep(
          subject,
          source.showsCountdown
            ? { status: "unavailable", message: error.message, retryAt: now + waitMs }
            : { status: "unavailable", message: error.message },
        );
        // Any change meanwhile clears this, and checks on its own.
        timer = setTimeout(() => {
          timer = null;
          check(refused);
        }, waitMs);
      },
    );
  };

  const onChange = (state: EditorState) => {
    const subject = subjectOf(state);
    if (sameSubject(subject, seen)) return;
    const previous = seen;
    seen = subject;
    clearTimer();
    // Any answer still to come is for what was on screen before: dropped,
    // and its request aborted.
    sequence += 1;
    abortInFlight();
    if (subject === null || isBlank(subject.text)) return;
    const opened = previous === null || previous.loadCount !== subject.loadCount || previous.versionId !== subject.versionId;
    const kept = state.validation;
    if (
      !opened &&
      kept !== null &&
      kept.outcome.status !== "unavailable" &&
      kept.versionId === subject.versionId &&
      kept.text === subject.text &&
      kept.collectorVersion === subject.collectorVersion
    ) {
      // Back to the text last answered: its answer shows, and stands.
      return;
    }
    const repinned = previous !== null && previous.collectorVersion !== subject.collectorVersion;
    if ((opened && source.checkOpenedAtOnce) || repinned) {
      check(null);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      check(null);
    }, source.debounceMs);
  };

  const unsubscribe = useEditorStore.subscribe((state) => onChange(state));
  onChange(useEditorStore.getState());

  return () => {
    stopped = true;
    unsubscribe();
    clearTimer();
    abortInFlight();
  };
}

/**
 * The collector validation of the open version, while the editor page is
 * mounted (`routes/editor.tsx`): see `startCollectorValidation`. Its
 * answers are in the editor store, read by the YAML tab's status bar and
 * Apply, and by the canvas's overlay. The playground's editors pass
 * `ANONYMOUS_VALIDATION`; a source is read once, when the page mounts.
 */
export function useCollectorValidation(source: ValidationSource = SIGNED_IN_VALIDATION): void {
  // A page's source is one of the two constants: read once, as the page mounts.
  useEffect(() => startCollectorValidation(source), []);
}
