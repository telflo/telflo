import type { TestDefinition } from "@telflo/contracts";
import { toast } from "sonner";
import { getTestRun, isSessionEnded } from "~/lib/api-client.js";
import { useEditorStore, type EditorState } from "~/lib/stores/editor-store.js";
import { DEFINITIONS_LOAD_FAILED_MESSAGE, readFailure, useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import {
  isRefusal,
  isRunActive,
  RUNS_FAILURES_BEFORE_STOP,
  RUNS_POLL_INTERVAL_MS,
  RUNS_REFRESH_FAILED_MESSAGE,
  RUNS_REQUEST_TIMEOUT_MS,
  useTestingStore,
  type PlayAllMode,
  type PlayAllRun,
  type RunTarget,
} from "~/lib/stores/testing-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/*
 * Play all: a suite's runs, in parallel or in serial order (following one run
 * at a time). The loops belong here, not to a component: collapsing the right
 * panel unmounts the Testing tab and must not stop them.
 *
 * - one hold for every Play (`selectIsPlayHeld`): a Play all holds every
 *   Play on its version from its click, set before anything is awaited, so
 *   a double click starts one; until its last queue answer (parallel) or
 *   until its loop ends or stops (serial);
 * - the API queues each run from its definition
 *   (`{definitionId, yaml, collectorVersion}`): the server takes the input,
 *   pipeline, signal, duration and breadcrumb, and doesn't count the run
 *   against the 20 a minute; the text (raw), the pin, the version and the
 *   suite are captured at the click, and the definitions read afresh then
 *   (a read under way awaited), never whatever was read once before; a read
 *   that fails (aborted after RUNS_REQUEST_TIMEOUT_MS when it never
 *   answers) ends the Play all, its hold released, with the API's words for
 *   a refusal, else "Failed to load test configurations";
 * - parallel keeps at most PLAY_ALL_REQUESTS_IN_FLIGHT queue requests in
 *   flight, never every one at once; it selects the run of
 *   the first definition in the card's order that was queued;
 * - serial follows its own runs by id (`GET …/test-runs/{runId}`, each read
 *   aborted after RUNS_REQUEST_TIMEOUT_MS) every RUNS_POLL_INTERVAL_MS, with
 *   no total-time cap (every run ends by its lease or the down rule), so it
 *   never moves on with a run still running; a run that ends in failure is
 *   followed at once by the next;
 * - a definition the API refuses to queue is counted and the rest go on;
 *   the refusals show as ONE error toast per Play all and message, updated
 *   in place ("3 of 5 test configurations weren't queued: …"),
 *   and no row is left stuck Queued;
 * - it stops when the editor leaves the version it was started on (another
 *   version or configuration, leaving the page) and on signing out (the
 *   store's `reset`), never because the tab's panel collapsed, so it never
 *   queues for a version no longer open; 30 failed reads in a row
 *   stop it with "Failed to refresh test runs", a refusal (a 4xx but 408
 *   and 429) with the API's words, and a session that ended silently;
 * - no fixture-shape question: each run whose input doesn't suit its receiver
 *   still carries the tester's advisory;
 * - a Play all that queued nothing (every one refused, an empty suite, a
 *   failed read) says so (`onNothingQueued`): the tab gives the focus back;
 *   one stopped (another version or configuration, the page left, signing
 *   out, a session that ended) says nothing, though its definitions read
 *   answers or times out later: no late focus jump.
 *
 * Suite, definition and template names reach no toast here but the API's
 * own words, and no attribute or analytics event.
 */

/** At most this many of a parallel Play all's queue requests are in flight at once. */
export const PLAY_ALL_REQUESTS_IN_FLIGHT = 4;

/** What a Play all of an empty suite says (an info toast). */
export const SUITE_HAS_NO_DEFINITIONS_MESSAGE = "This suite has no test configurations yet";

/** A refusal's words when the API's say nothing more (a failed start). */
export const PLAY_ALL_FAILED_MESSAGE = "Failed to start test run";

export interface PlayAllRequest {
  /** Who plays: the hold reads their own runs. */
  userId: string | null;
  /** The version open at the click, in the organization it was loaded in. */
  target: RunTarget;
  suiteId: string;
  mode: PlayAllMode;
  /** The editor's raw text at the click (the API substitutes organization variables). */
  yaml: string;
  /** The pin at the click. */
  collectorVersion: string;
  /** Called once, with the first run it selects: the focus goes to its row. */
  onFirstSelected?: (runId: string) => void;
  /**
   * Called once the definitions are read and there is at least one, before
   * the first is queued: the tab shows the Tests subtab then (the empty
   * check comes before the switch to Tests), so an empty suite's toast or a
   * failed read leaves the person on Suites.
   */
  onDefinitionsKnown?: () => void;
  /**
   * Called once it has ended having queued nothing (every definition
   * refused, an empty suite, a failed read), after its hold is released:
   * the tab gives the focus back to the button pressed. Never once it was
   * stopped (the editor leaving its version, signing out, a session that
   * ended), even when a read or request answers after: the person is
   * elsewhere by then.
   */
  onNothingQueued?: () => void;
}

/** How many Play alls have started: each one's toast ids are its own. */
let played = 0;

/** The words of a refusals toast: "{k} of {n} test configurations weren't queued: {words}" ("wasn't" for one). */
export function refusalsMessage(refused: number, total: number, words: string): string {
  return `${refused} of ${total} test configurations ${refused === 1 ? "wasn't" : "weren't"} queued: ${words}`;
}

/**
 * Starts a Play all of the suite: false, starting nothing, when Play is
 * held on its version; otherwise the hold is set before this returns and
 * the loop runs on in the background.
 */
export function playAll(request: PlayAllRequest): boolean {
  const run = useTestingStore.getState().beginPlayAll(request.target, request.suiteId, request.mode, request.userId);
  if (run === null) return false;
  void play(run, request);
  return true;
}

/** Whether the editor still has `target` open (a Play all's loop, and a single run's fixture-shape question, TestingTab). */
export function isOpen(editor: Pick<EditorState, "organizationId" | "configuration" | "version">, target: RunTarget): boolean {
  return (
    editor.organizationId === target.organizationId &&
    editor.configuration?.id === target.configurationId &&
    editor.version?.id === target.versionId
  );
}

/** Stops `run` from outside its steps: nothing more is queued, its wait and read are cut short. */
function stop(run: PlayAllRun): void {
  useTestingStore.getState().stopPlayAll(run);
}

/** One toast per message for this Play all, updated in place as its refusals are counted. */
function refusalsToast(total: number): (words: string) => void {
  const playAllNumber = ++played;
  const counts = new Map<string, { refused: number; index: number }>();
  return (words) => {
    const count = counts.get(words) ?? { refused: 0, index: counts.size };
    count.refused += 1;
    counts.set(words, count);
    // The id names the Play all and the message by number: no words in it.
    toast.error(refusalsMessage(count.refused, total, words), { id: `play-all-${playAllNumber}-refused-${count.index}` });
  };
}

async function play(run: PlayAllRun, request: PlayAllRequest): Promise<void> {
  // The editor leaving the version (another version or configuration, the page left, signing out) stops it.
  const unsubscribe = useEditorStore.subscribe((editor) => {
    if (!isOpen(editor, run.target)) stop(run);
  });
  let queuedAny = false;
  try {
    let definitions: TestDefinition[];
    try {
      definitions = await useTestSuitesStore.getState().loadDefinitions(run.target, run.suiteId);
    } catch (error) {
      // A refusal in the API's words, else "Failed to load test configurations" (a timeout included), as the
      // card's own read shows it; nothing when the session ended.
      const message = readFailure(error, DEFINITIONS_LOAD_FAILED_MESSAGE);
      if (!run.stopped && message !== null) toast.error(message);
      return;
    }
    if (run.stopped) return;
    if (definitions.length === 0) {
      toast.info(SUITE_HAS_NO_DEFINITIONS_MESSAGE);
      return;
    }
    request.onDefinitionsKnown?.();
    const refused = refusalsToast(definitions.length);
    queuedAny =
      run.mode === "parallel"
        ? await playInParallel(run, request, definitions, refused)
        : await playSerially(run, request, definitions, refused);
  } finally {
    unsubscribe();
    // Before endPlayAll, which marks every ended Play all stopped: whether something stopped this one.
    const stopped = run.stopped;
    useTestingStore.getState().endPlayAll(run);
    if (!queuedAny && !stopped) request.onNothingQueued?.();
  }
}

/**
 * A queue request's failure: a session that ended stops the Play all
 * silently (the session-ended handler takes the browser to sign in);
 * anything else is counted under its words and the rest go on.
 */
function onQueueFailure(run: PlayAllRun, error: unknown, refused: (words: string) => void): void {
  if (isSessionEnded(error)) {
    stop(run);
    return;
  }
  if (run.stopped) return;
  refused(failureMessage(error, PLAY_ALL_FAILED_MESSAGE) ?? PLAY_ALL_FAILED_MESSAGE);
}

/** Every definition queued, at most PLAY_ALL_REQUESTS_IN_FLIGHT at once, in the card's order; whether any was. */
async function playInParallel(
  run: PlayAllRun,
  request: PlayAllRequest,
  definitions: TestDefinition[],
  refused: (words: string) => void,
): Promise<boolean> {
  const testing = () => useTestingStore.getState();
  /** Each definition's answer, in the card's order: its run's id, "refused", or undefined while it waits. */
  const answers: Array<string | "refused" | undefined> = definitions.map(() => undefined);
  let next = 0;
  let selected = false;

  // The first definition's run in the card's order, or (when it was
  // refused) the next one queued, once every one before it has answered.
  const selectFirst = () => {
    if (selected || run.stopped) return;
    for (const answer of answers) {
      if (answer === undefined) return;
      if (answer === "refused") continue;
      selected = true;
      testing().selectRun(answer);
      request.onFirstSelected?.(answer);
      return;
    }
  };

  const sendNext = async (): Promise<void> => {
    while (!run.stopped && next < definitions.length) {
      const index = next;
      next += 1;
      try {
        const queued = await testing().queueRun(
          run.target,
          { definitionId: definitions[index]!.id, yaml: request.yaml, collectorVersion: request.collectorVersion },
          { select: false },
        );
        answers[index] = queued.id;
      } catch (error) {
        answers[index] = "refused";
        onQueueFailure(run, error, refused);
      }
      selectFirst();
    }
  };

  await Promise.all(Array.from({ length: Math.min(PLAY_ALL_REQUESTS_IN_FLIGHT, definitions.length) }, sendNext));
  return answers.some((answer) => answer !== undefined && answer !== "refused");
}

/** Each definition queued once the run before it has ended, in the card's order, each step's run selected; whether any was. */
async function playSerially(
  run: PlayAllRun,
  request: PlayAllRequest,
  definitions: TestDefinition[],
  refused: (words: string) => void,
): Promise<boolean> {
  let queuedAny = false;
  for (const definition of definitions) {
    if (run.stopped) return queuedAny;
    let queued;
    try {
      queued = await useTestingStore
        .getState()
        .queueRun(run.target, { definitionId: definition.id, yaml: request.yaml, collectorVersion: request.collectorVersion });
    } catch (error) {
      onQueueFailure(run, error, refused);
      continue;
    }
    // Queued, whether or not the Play all has stopped since.
    const first = !queuedAny;
    queuedAny = true;
    if (run.stopped) return queuedAny;
    if (first) request.onFirstSelected?.(queued.id);
    if (isRunActive(queued) && !(await followUntilEnded(run, queued.id))) return queuedAny;
  }
  return queuedAny;
}

/**
 * Reads the run every RUNS_POLL_INTERVAL_MS until it has ended (true), each
 * read aborted after RUNS_REQUEST_TIMEOUT_MS; false once the Play all has
 * stopped: from outside, after RUNS_FAILURES_BEFORE_STOP failed reads in a
 * row ("Failed to refresh test runs"), on a refusal (the API's words), or a
 * session that ended (silently).
 */
function followUntilEnded(run: PlayAllRun, runId: string): Promise<boolean> {
  const { organizationId, configurationId, versionId } = run.target;
  return new Promise<boolean>((resolve) => {
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading: AbortController | null = null;
    let readTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (ended: boolean) => {
      if (timer !== null) clearTimeout(timer);
      if (readTimer !== null) clearTimeout(readTimer);
      timer = null;
      readTimer = null;
      resolve(ended);
    };
    run.onStop = () => {
      reading?.abort();
      settle(false);
    };
    const giveUp = (message: string | null) => {
      if (message !== null) toast.error(message);
      stop(run);
    };

    const read = () => {
      timer = null;
      if (run.stopped) return;
      const controller = new AbortController();
      reading = controller;
      readTimer = setTimeout(() => controller.abort(), RUNS_REQUEST_TIMEOUT_MS);
      getTestRun(organizationId, configurationId, versionId, runId, { signal: controller.signal }).then(
        ({ run: detail }) => {
          if (readTimer !== null) clearTimeout(readTimer);
          readTimer = null;
          reading = null;
          if (run.stopped) return;
          failures = 0;
          useTestingStore.getState().noteRun(detail);
          if (isRunActive(detail)) wait();
          else {
            run.onStop = null;
            settle(true);
          }
        },
        (error: unknown) => {
          if (readTimer !== null) clearTimeout(readTimer);
          readTimer = null;
          reading = null;
          if (run.stopped) return;
          if (isSessionEnded(error)) return giveUp(null);
          // A refusal (the run or the version gone, the organization left): reading again won't change it.
          if (isRefusal(error)) return giveUp(error.message);
          failures += 1;
          if (failures >= RUNS_FAILURES_BEFORE_STOP) return giveUp(RUNS_REFRESH_FAILED_MESSAGE);
          wait();
        },
      );
    };
    const wait = () => {
      timer = setTimeout(read, RUNS_POLL_INTERVAL_MS);
    };
    wait();
  });
}
