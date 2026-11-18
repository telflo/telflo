import type { QueueTestRunRequest, TestDefinition, TestRunSignal, TestRunSummary, TestSuite } from "@telflo/contracts";
import { Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getTestDefinitionInputHead, getTestRunInputHead, getTestTemplateFileHead } from "~/lib/api-client.js";
import { HelpPopover } from "~/components/ui/help-popover.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import {
  RUNS_REQUEST_TIMEOUT_MS,
  selectIsPlayHeld,
  useTestingStore,
  type PlayAllMode,
  type RunTarget,
} from "~/lib/stores/testing-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { isOpen, playAll } from "~/lib/test-suites/play-all.js";
import { detectFixtureMismatch, SNIFF_BYTES, type MismatchAdvisory } from "~/lib/test-runs/fixture-shape.js";
import { failureMessage, HELD_TITLE } from "~/lib/test-runs/messages.js";
import { SuitesPanel } from "../test-suites/SuitesPanel.js";
import { ValidationPipelinesPanel } from "../validation-pipelines/ValidationPipelinesPanel.js";
import { FixtureMismatchDialog } from "./FixtureMismatchDialog.js";
import { RunTestDialog, type RunTestValues } from "./RunTestDialog.js";
import { TestRunsPanel } from "./TestRunsPanel.js";

/** The toolbar buttons' classes. */
const TOOLBAR_BTN_CLASS =
  "inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors";

/** The tab's subtabs, in order: Tests, Validation (D15a), Suites (D14b). */
export type TestingSubtab = "tests" | "validation" | "suites";

/** A run the fixture-shape check asked about, queued only on "Run Anyway". */
interface PendingRun {
  advisory: MismatchAdvisory;
  target: RunTarget;
  request: QueueTestRunRequest;
  /** What a refusal says when nothing better is known: the dialog's run, a re-run, or a definition's. */
  fallback: string;
  /** Releases the hold its start took (`beginStart`): on Cancel, or once the queue request answers. */
  release: () => void;
  /** Once queued: Play one shows the Tests subtab first; every run's row then takes the focus. */
  afterQueue: () => void;
  /** The button pressed (Play, ↺, Run test): the focus goes back to it when nothing is queued (D14b Ruling 50). */
  opener: HTMLElement | null;
}

/** How the question last closed, for where its dialog sends the focus. */
interface ClosedQuestion {
  /** Run Anyway (the queue's answer moves the focus), Cancel (back to the button pressed), or the editor left its version (D14b Ruling 46). */
  how: "confirmed" | "cancelled" | "left";
  opener: HTMLElement | null;
}

/**
 * The first SNIFF_BYTES of an input, read from one of the API's heads (D14a
 * Rulings 43 and 46: 64 KiB, never the whole input), aborted after 10 s as
 * the tab's other reads are; null when it can't be read (the check is then
 * skipped).
 */
async function headOf(read: (signal: AbortSignal) => Promise<Uint8Array>): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNS_REQUEST_TIMEOUT_MS);
  try {
    return (await read(controller.signal)).slice(0, SNIFF_BYTES);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The question to ask before queuing, if the input's head doesn't suit the pipeline (decision 17); null when it does or can't be read. */
function adviceFor(head: Uint8Array | null, yaml: string, signal: TestRunSignal, pipeline: string): MismatchAdvisory | null {
  return head === null ? null : detectFixtureMismatch({ yamlConfig: yaml, signalType: signal, targetPipeline: pipeline, fixtureHead: head });
}

/** The person signed in, as the hold reads them. */
function currentUserId(): string | null {
  return useUserStore.getState().current?.user.id ?? null;
}

/**
 * The editor's Testing tab (D14a decisions 10, 16 to 21; Preflight rulings
 * 12, 14 and 15; D14b Preflight ruling 14): the run's preflight and
 * queueing, the re-run, the subtab bar, the dialogs, the toolbar, and the
 * version's runs and their results under it (TestRunsPanel), polled while
 * the tab is mounted (the store's `watchRuns`); and the Suites subtab
 * (`../test-suites/SuitesPanel.tsx`), with Play one here, Play all's loops
 * in `lib/test-suites/play-all.ts`; and between them the Validation subtab
 * (`../validation-pipelines/ValidationPipelinesPanel.tsx`, D15a).
 *
 * A composed panel tab (D8), kept mounted, disabled with Configuration
 * (routes/editor.tsx). Differences (the Parity Notes):
 * - three subtabs, "Tests", "Validation" and "Suites". The subtab shown is
 *   the tab's state (controlled), so a Play from Suites can switch to Tests;
 *   the Validation and Suites subtabs mount each time they show, and read
 *   their pipelines and suites afresh;
 * - a run is queued by the API (`queueTestRun`) with the raw text, which the
 *   API substitutes organization variables into (Preflight ruling 12), the
 *   pin on screen and the pipeline's name and signal; the API queues it and
 *   its dispatcher starts it in turn (decision 1);
 * - the fixture-shape check narrows to the target pipeline, and reads the
 *   head this tab kept of a file it uploaded or saved, or the API's head of a
 *   file from an earlier session (`headFor`, D14a Ruling 43);
 * - ↺ re-runs a run the person can see, a teammate's included, through the
 *   run's own copy of its input (`sourceRunId`), with the run's pipeline,
 *   signal and duration and the CURRENT raw text, which the API substitutes
 *   organization variables into as for any run (decision 18), never the text
 *   unsubstituted with the person's own file re-read.
 *   The fixture-shape check reads the first 64 KiB of the run's input, from
 *   the API's head of it (`…/files/input/head`, D14a Ruling 46);
 * - every Play ("Configure and run", ↺, a definition's Run test, both Play
 *   alls) is held, and titled "Another run is in progress", while the
 *   person's own run on this version is queued or running (Preflight ruling
 *   15), while a Play all on it is under way, and while a single run is
 *   starting, from its click, and during a head read (D14b Preflight ruling
 *   13: `selectIsPlayHeld`), not while just any polled run is in flight;
 * - a definition's Run test (Play one) asks the fixture-shape question from
 *   the head of the definition's own input (`…/input/head`), and switches to
 *   the Tests subtab once its run is queued, so a cancelled question stays
 *   on Suites (D14b Preflight ruling 14), never switched first; a
 *   Play all switches once its definitions are known not to be empty (D14b
 *   Ruling 40), and asks nothing (decision 6);
 * - neither switches to Tests while one of the Suites subtab's dialogs shows
 *   (the suite dialog, the definition dialog, either delete confirmation),
 *   or one of the Validation subtab's (New validation pipeline, the rule
 *   editor, either delete confirmation; D15a): the switch would unmount it,
 *   losing what was typed in it. The run is still queued and selected, and
 *   the request to focus its row dropped (D14b Ruling 50); the rule editor
 *   Compare's chip opens (D15b) shows on Tests, where a Play's switch goes,
 *   and is held beside the results (TestRunResults), so a Play all's answer
 *   selecting its run leaves it open: it isn't counted here;
 * - a run from a template reads the template's head (`…/file/head`) for the
 *   question;
 * - once a run is queued (Run, Run Anyway, ↺, Run test, a Play all's
 *   first), the focus goes to its row, selected, never lost on the disabled
 *   Play or ↺ (D14a Ruling 48's nit);
 *   only while the Tests subtab shows it: a request made while Suites
 *   shows is dropped, and the list serves or drops one the first time it
 *   renders after it, so none waits to pull the focus to a row later (D14b
 *   Ruling 42);
 * - a fixture-shape question whose head answers once the editor has left
 *   its version (another version, configuration or organization) is
 *   dropped with its hold: no question, nothing queued (D14b Ruling 42, as
 *   D14a Ruling 46 drops answers for a version left behind); one already
 *   showing when the editor leaves its version closes with its hold, so
 *   Run Anyway can't queue on a version no longer open (D14b Ruling 45), and
 *   the focus goes to the active subtab's trigger (D14b Ruling 46); a head
 *   that answers once the editor has left queues nothing either, though its
 *   input suits the pipeline (D14b Ruling 50);
 * - a Play that queued nothing (every definition refused, an empty suite, a
 *   failed read, a refused or failed Play one or ↺, a cancelled question)
 *   gives the focus back to the button pressed when it is still there and
 *   can be pressed, else to the active subtab's trigger, where it was lost
 *   to the body (the button held, or unmounted by the switch to Tests); only
 *   while the focus is lost, never from where the person has put it since
 *   (D14b Ruling 50);
 * - nothing here sends an analytics event (Preflight ruling 16);
 * - in the playground (D31-1 decisions 24 and 31; Preflight ruling 9), the
 *   run dialog opens on the sample's templates, and its
 *   Run is the locked action: nothing is remembered or queued, the dialog
 *   closes, and the sign-up prompt opens once it has (its close's focus
 *   return, so the closing dialog's focus trap never holds the prompt's
 *   focus, with no fixed wait). ↺, Compare and the
 *   Suites' and Validation subtabs' actions are locked at their own buttons;
 *   the runs, their details and files are read from the sample.
 */
export function TestingTab() {
  const locked = useLockedAction();
  /** The playground's Run was pressed: as the dialog closes, the sign-up prompt opens. */
  const lockedRun = useRef(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  const [subtab, setSubtab] = useState<TestingSubtab>("tests");
  /** The subtab shown, as of the last change, before React renders it: a focus request reads it. */
  const subtabRef = useRef<TestingSubtab>("tests");
  /** Counts requests to move the focus to the selected run's row: each re-renders the list, which serves it, or drops it when no selected row shows. */
  const [focusRequests, setFocusRequests] = useState(0);
  /** Whether a request to focus the selected row waits to be served (TestRunsPanel's `takeFocus`). */
  const focusPending = useRef(false);
  const organizationId = useEditorStore((state) => state.organizationId);
  const configurationId = useEditorStore((state) => state.configuration?.id ?? null);
  const versionId = useEditorStore((state) => state.version?.id ?? null);
  const userId = useUserStore((state) => state.current?.user.id ?? null);
  const held = useTestingStore((state) => selectIsPlayHeld(state, userId, versionId));
  const disableRun = versionId === null || held;
  const testsRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  /** The run dialog's Run queued its run: as the dialog closes, the focus goes to that run's row, not back to Play. */
  const queuedFromDialog = useRef(false);
  /** Whether the tab is mounted: a start that ends after the panel collapsed touches no state. */
  const mounted = useRef(true);
  /**
   * The question showing, if any: the panel collapsing releases its hold.
   * Set with the state (`setQuestion`), not from a render, so a tab
   * unmounting in the same batch as the question's head answering still
   * releases it (D14b Ruling 47).
   */
  const pendingRef = useRef<PendingRun | null>(null);
  /** How the question last closed: its dialog's focus reads it. */
  const closedQuestion = useRef<ClosedQuestion | null>(null);
  const testsTriggerRef = useRef<HTMLButtonElement>(null);
  const validationTriggerRef = useRef<HTMLButtonElement>(null);
  const suitesTriggerRef = useRef<HTMLButtonElement>(null);
  /**
   * How many of the Suites and Validation subtabs' dialogs show: a Play doesn't switch to Tests while any does (D14b Ruling
   * 50); a Play all under way would otherwise tear a rule editor away once the person has moved to Validation.
   */
  const suitesDialogs = useRef(0);
  /** The button a Play that queued nothing gives the focus back to, once the tab has rendered the hold's release. */
  const focusBackTo = useRef<HTMLElement | null>(null);
  /** Counts requests to give the focus back after a Play that queued nothing: each is served once the tab has rendered. */
  const [focusBackRequests, setFocusBackRequests] = useState(0);

  /** Shows, or closes, the fixture-shape question: the ref at once, the dialog on the next render. */
  const setQuestion = (next: PendingRun | null) => {
    pendingRef.current = next;
    setPendingRun(next);
  };

  /** A Suites or Validation dialog shows: counted until it closes or unmounts (the panels' `onDialogShown`). */
  const dialogShown = useCallback(() => {
    suitesDialogs.current += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      suitesDialogs.current -= 1;
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A question left unanswered as the panel collapses queues nothing and holds nothing.
      pendingRef.current?.release();
    };
  }, []);

  /**
   * After a run is queued: the focus to its row (the selected one, which
   * queueRun selected), else Play when it can be pressed. Play and ↺ are
   * held (disabled) while the run waits, so the focus would be lost.
   */
  const focusAfterQueue = () => {
    const row = testsRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    const target = row ?? (playRef.current?.disabled === false ? playRef.current : null);
    target?.focus();
  };

  /** Shows a subtab (the Play's switch, or the person's). */
  const showSubtab = (next: TestingSubtab) => {
    subtabRef.current = next;
    setSubtab(next);
  };

  /** A Play's switch to Tests: none once the tab has gone, nor while a Suites dialog shows, as it would unmount it (D14b Ruling 50). */
  const showTestsForPlay = () => {
    if (!mounted.current || suitesDialogs.current > 0) return;
    showSubtab("tests");
  };

  /** The trigger of the subtab showing. */
  const activeTrigger = () =>
    subtabRef.current === "tests"
      ? testsTriggerRef.current
      : subtabRef.current === "validation"
        ? validationTriggerRef.current
        : suitesTriggerRef.current;

  /** Whether the focus is lost: on the body (its button held, or gone), or still on `opener`, never somewhere the person put it. */
  const focusLost = (opener: HTMLElement | null) => {
    const active = document.activeElement;
    return active === null || active === document.body || (opener !== null && active === opener);
  };

  /**
   * After a Play that queued nothing: the focus back to the button pressed
   * when it is still there and can be pressed, else to the active subtab's
   * trigger; only while the focus is lost (D14b Ruling 50). A button in a
   * subtab no longer shown isn't there: its panel may not have unmounted
   * yet, but is going.
   */
  const giveFocusBack = (opener: HTMLElement | null) => {
    if (!mounted.current || !focusLost(opener)) return;
    const pressable =
      opener !== null &&
      opener.isConnected &&
      !(opener instanceof HTMLButtonElement && opener.disabled) &&
      opener.closest('[role="tabpanel"]')?.getAttribute("data-state") !== "inactive";
    (pressable ? opener : activeTrigger())?.focus();
  };

  /** Gives the focus back (`giveFocusBack`) once the tab has rendered the hold's release, so the button can take it. */
  const requestFocusBack = (opener: HTMLElement | null) => {
    if (!mounted.current) return;
    focusBackTo.current = opener;
    setFocusBackRequests((count) => count + 1);
  };

  useEffect(() => {
    if (focusBackRequests === 0) return;
    const opener = focusBackTo.current;
    focusBackTo.current = null;
    giveFocusBack(opener);
  }, [focusBackRequests]);

  /**
   * Moves the focus to the selected run's row once it has rendered (the
   * Tests subtab may only now be showing); nothing once the tab has gone,
   * nor while Suites shows: a request made there would wait and pull the
   * focus to the row whenever Tests next showed (D14b Ruling 42).
   */
  const requestFocus = () => {
    if (!mounted.current || subtabRef.current !== "tests") return;
    focusPending.current = true;
    setFocusRequests((count) => count + 1);
  };

  /** Serves a waiting request to focus the selected row: true once, then false until the next. */
  const takeFocus = () => {
    const pending = focusPending.current;
    focusPending.current = false;
    return pending;
  };

  /**
   * Shows the Tests subtab, then the selected run's row takes the focus;
   * while a Suites dialog shows, neither: the request is dropped, as Suites
   * still shows (D14b Ruling 50).
   */
  const showQueued = () => {
    if (!mounted.current) return;
    showTestsForPlay();
    requestFocus();
  };

  // A question showing when the editor leaves its version (another version,
  // configuration or organization) closes, queuing nothing, and its hold
  // goes with it (D14b Ruling 45); the focus to the active subtab's trigger
  // (D14b Ruling 46).
  useEffect(() => {
    if (pendingRun === null || isOpen(useEditorStore.getState(), pendingRun.target)) return;
    closedQuestion.current = { how: "left", opener: null };
    pendingRun.release();
    setQuestion(null);
  }, [pendingRun, organizationId, configurationId, versionId]);

  // The version's runs, polled while any is queued or running; stopped on
  // unmount and when the version changes (Preflight ruling 15).
  useEffect(() => {
    if (organizationId === null || configurationId === null || versionId === null) return;
    return useTestingStore.getState().watchRuns({ organizationId, configurationId, versionId });
  }, [organizationId, configurationId, versionId]);

  const queue = async (target: RunTarget, request: QueueTestRunRequest) => {
    await useTestingStore.getState().queueRun(target, request);
  };

  /** The open version, in the organization it was loaded in, with its text and pin as they are now; throws when none is loaded. */
  const currentVersion = (): { target: RunTarget; yaml: string; collectorVersion: string } => {
    const editor = useEditorStore.getState();
    if (editor.organizationId === null || editor.configuration === null || editor.version === null || editor.collectorVersion === null) {
      throw new Error("No configuration version loaded");
    }
    return {
      target: { organizationId: editor.organizationId, configurationId: editor.configuration.id, versionId: editor.version.id },
      yaml: editor.text,
      collectorVersion: editor.collectorVersion,
    };
  };

  /**
   * A single run's start, under the hold (`beginStart`), set at once, before
   * anything is awaited: "held" when Play is held (a second click among
   * them). `start` reads the input's head and answers the request and the
   * question to ask, if any; the run is queued then ("queued"), or the
   * question shown ("asked"), which keeps the hold until it is answered.
   * A start whose head answers once the editor has left the target is
   * dropped with the hold, nothing queued, the question asked or not
   * ("dropped": D14b Rulings 42 and 50), and so is a question nobody can
   * answer, the panel having collapsed during the head read. Rejects as the
   * queue did. `opener` is the button pressed.
   */
  const startRun = async (
    target: RunTarget,
    fallback: string,
    afterQueue: () => void,
    opener: HTMLElement | null,
    start: () => Promise<{ request: QueueTestRunRequest; advisory: MismatchAdvisory | null }>,
  ): Promise<"queued" | "asked" | "dropped" | "held"> => {
    const release = useTestingStore.getState().beginStart(target, currentUserId());
    if (release === false) return "held";
    let asking = false;
    try {
      const { request, advisory } = await start();
      // Left mid-read: nothing queues on a version no longer open (D14b Ruling 50). For a question, this
      // is belt and braces: the effect above would close one shown for a version left (D14b Ruling 45).
      if (!isOpen(useEditorStore.getState(), target)) return "dropped";
      if (advisory !== null) {
        if (!mounted.current) return "dropped";
        asking = true;
        setQuestion({ advisory, target, request, fallback, release, afterQueue, opener });
        return "asked";
      }
      await queue(target, request);
      return "queued";
    } finally {
      if (!asking) release();
    }
  };

  // The dialog's Run: the run's snapshot from the editor as it is now, the
  // fixture-shape check, then the queue (or the check's question first).
  const handleRun = async ({ input, pipelineName, durationSeconds }: RunTestValues) => {
    // The playground's lock (D31-1 decision 31): nothing remembered, nothing queued; the dialog closes, then the prompt.
    if (locked) {
      lockedRun.current = true;
      return;
    }
    const editor = useEditorStore.getState();
    const pipeline = editor.graph.pipelines.find((candidate) => candidate.name === pipelineName);
    if (pipeline === undefined) throw new Error("Select a pipeline to test");
    const { target, yaml, collectorVersion } = currentVersion();
    const testing = useTestingStore.getState();
    testing.setLastRunDurationSeconds(durationSeconds);
    const outcome = await startRun(target, "Failed to start test run", requestFocus, playRef.current, async () => {
      const request: QueueTestRunRequest = {
        ...(input.kind === "file" ? { inputFileId: input.id } : { templateId: input.id }),
        pipeline: pipeline.name,
        signal: pipeline.signalType,
        durationSeconds,
        yaml,
        collectorVersion,
      };
      const head =
        input.kind === "file"
          ? await testing.headFor(target.organizationId, input.id)
          : await headOf((signal) => getTestTemplateFileHead(input.id, { signal }));
      return { request, advisory: adviceFor(head, yaml, pipeline.signalType, pipeline.name) };
    });
    // Held after all (a run of the person's appeared since the dialog opened): the dialog stays, saying so.
    if (outcome === "held") throw new Error(HELD_TITLE);
    queuedFromDialog.current = outcome === "queued";
  };

  // A row's ↺: the run's input, pipeline, signal and duration against the
  // text as it is now (decision 18), with the fixture-shape check. Nothing
  // queued: the focus back to the ↺ pressed (D14b Ruling 50).
  const handleRerun = async (run: TestRunSummary, opener: HTMLElement) => {
    try {
      const { target, yaml, collectorVersion } = currentVersion();
      const queued = await startRun(target, "Failed to re-run test", requestFocus, opener, async () => ({
        request: {
          sourceRunId: run.id,
          pipeline: run.pipeline,
          signal: run.signal,
          durationSeconds: run.durationSeconds,
          yaml,
          collectorVersion,
        },
        advisory: adviceFor(
          await headOf((signal) =>
            getTestRunInputHead(target.organizationId, target.configurationId, target.versionId, run.id, { signal }),
          ),
          yaml,
          run.signal,
          run.pipeline,
        ),
      }));
      if (queued === "queued") focusAfterQueue();
      else if (queued === "dropped") requestFocusBack(opener);
    } catch (error) {
      const message = failureMessage(error, "Failed to re-run test");
      if (message !== null) toast.error(message);
      requestFocusBack(opener);
    }
  };

  // A definition's Run test (Play one, D14b decision 10): queued from the
  // definition with the text and pin as they are now, after the
  // fixture-shape question on the definition's own input; the Tests subtab
  // shows once it is queued. Nothing queued: the focus back to the Run test
  // pressed (D14b Ruling 50).
  const handlePlayOne = async (suite: TestSuite, definition: TestDefinition, opener: HTMLElement) => {
    try {
      const { target, yaml, collectorVersion } = currentVersion();
      const queued = await startRun(target, "Failed to start test run", showQueued, opener, async () => ({
        request: { definitionId: definition.id, yaml, collectorVersion },
        advisory: adviceFor(
          await headOf((signal) =>
            getTestDefinitionInputHead(target.organizationId, target.configurationId, target.versionId, suite.id, definition.id, {
              signal,
            }),
          ),
          yaml,
          definition.signal,
          definition.pipeline,
        ),
      }));
      if (queued === "queued") showQueued();
      else if (queued === "dropped") requestFocusBack(opener);
    } catch (error) {
      const message = failureMessage(error, "Failed to start test run");
      if (message !== null) toast.error(message);
      requestFocusBack(opener);
    }
  };

  // A card's Play all (D14b decision 10): the text, pin, version and suite
  // as they are at the click; the loop is the store's, so the panel
  // collapsing doesn't stop it. The Tests subtab shows once the definitions
  // are read and there is one (D14b Ruling 40): an empty
  // suite's toast or a failed read leaves the person on Suites; so does a
  // Suites dialog showing (D14b Ruling 50). Nothing queued: the focus back
  // to the Play all pressed, else the active subtab's trigger.
  const handlePlayAll = (suite: TestSuite, mode: PlayAllMode, opener: HTMLElement) => {
    let current: ReturnType<typeof currentVersion>;
    try {
      current = currentVersion();
    } catch (error) {
      toast.error(failureMessage(error, "Failed to start test run") ?? "Failed to start test run");
      return;
    }
    playAll({
      userId: currentUserId(),
      target: current.target,
      suiteId: suite.id,
      mode,
      yaml: current.yaml,
      collectorVersion: current.collectorVersion,
      onFirstSelected: requestFocus,
      onDefinitionsKnown: showTestsForPlay,
      onNothingQueued: () => requestFocusBack(opener),
    });
  };

  return (
    <div className="flex-1 flex flex-col p-6 gap-4 overflow-hidden">
      <Tabs
        value={subtab}
        onValueChange={(value) => showSubtab(value === "suites" ? "suites" : value === "validation" ? "validation" : "tests")}
        className="flex-1 flex flex-col min-h-0"
      >
        <TabsList className="flex w-full">
          <TabsTrigger ref={testsTriggerRef} value="tests" className="flex-1">
            Tests
          </TabsTrigger>
          <TabsTrigger ref={validationTriggerRef} value="validation" className="flex-1">
            Validation
          </TabsTrigger>
          <TabsTrigger ref={suitesTriggerRef} value="suites" className="flex-1">
            Suites
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tests" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
          <div ref={testsRef} className="flex flex-col gap-3 flex-1 min-h-0">
            <div className="flex items-center justify-between">
              <HelpPopover label="What is this panel?" title="Tests">
                <p>
                  Run tests and review past runs for this configuration version. Select a row to see its status, output,
                  and validation results in the detail pane below.
                </p>
                <p>
                  Tests ran from a suite carry a <span className="font-medium">Suite › Configuration</span> breadcrumb;
                  one-off runs don&apos;t. Use a row&apos;s ↺ button to re-run that test against the current YAML.
                </p>
              </HelpPopover>
              <div className="flex items-center gap-0.5">
                <button
                  ref={playRef}
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  disabled={disableRun}
                  title={held ? HELD_TITLE : "Configure and run"}
                  aria-label="Configure and run"
                  className={TOOLBAR_BTN_CLASS}
                >
                  <Play className="w-4 h-4" />
                </button>
              </div>
            </div>
            <TestRunsPanel
              onRerun={(run, opener) => void handleRerun(run, opener)}
              disableRerun={disableRun}
              focusRequest={focusRequests}
              takeFocus={takeFocus}
            />
          </div>
        </TabsContent>
        <TabsContent value="validation" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
          <ValidationPipelinesPanel onDialogShown={dialogShown} />
        </TabsContent>
        <TabsContent value="suites" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
          <SuitesPanel
            onPlayOne={(suite, definition, opener) => void handlePlayOne(suite, definition, opener)}
            onPlayAll={handlePlayAll}
            onDialogShown={dialogShown}
          />
        </TabsContent>
      </Tabs>

      <RunTestDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onRun={handleRun}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (lockedRun.current) {
            lockedRun.current = false;
            locked?.("run a test against your config", playRef.current);
            return;
          }
          if (queuedFromDialog.current) {
            queuedFromDialog.current = false;
            focusAfterQueue();
            return;
          }
          // Cancelled: back to the button that opened it, explicitly, as a click
          // doesn't focus a button in every browser (D14b Ruling 38). With a
          // question to ask, its dialog takes the focus.
          if (pendingRef.current === null && playRef.current?.disabled === false) playRef.current.focus();
        }}
      />

      <FixtureMismatchDialog
        open={pendingRun !== null}
        advisory={pendingRun?.advisory ?? null}
        onCancel={() => {
          closedQuestion.current = { how: "cancelled", opener: pendingRun?.opener ?? null };
          pendingRun?.release();
          setQuestion(null);
        }}
        onConfirm={() => {
          const resume = pendingRun;
          closedQuestion.current = { how: "confirmed", opener: null };
          setQuestion(null);
          if (resume === null) return;
          queue(resume.target, resume.request)
            .then(resume.afterQueue, (error: unknown) => {
              const message = failureMessage(error, resume.fallback);
              if (message !== null) toast.error(message);
              // Refused: nothing queued, the focus back to the button pressed, released first (D14b Ruling 50).
              resume.release();
              requestFocusBack(resume.opener);
            })
            .finally(resume.release);
        }}
        onCloseAutoFocus={(event) => {
          // No Radix trigger to go back to: Radix would leave the focus on the body.
          event.preventDefault();
          const closed = closedQuestion.current;
          closedQuestion.current = null;
          // Run Anyway: the queue's answer moves it (to the run's row, or back to the button pressed).
          if (closed === null || closed.how === "confirmed") return;
          // The editor left the version: the button pressed went with it; the active subtab's trigger (D14b Ruling 46).
          if (closed.how === "left") {
            if (focusLost(null)) activeTrigger()?.focus();
            return;
          }
          giveFocusBack(closed.opener);
        }}
      />
    </div>
  );
}
