import {
  TEST_RUN_DURATION_MAXIMUM_SECONDS,
  TEST_RUN_DURATION_MINIMUM_SECONDS,
  TestRunSummarySchema,
  type QueueTestRunRequest,
  type TestFile,
  type TestRunDetail,
  type TestRunSummary,
  type TestSampleFormat,
  type TestTemplate,
} from "@telflo/contracts";
import { create } from "zustand";
import {
  ApiError,
  deleteTestFile,
  isSessionEnded,
  queueTestRun,
  saveTestSample,
  uploadTestFile,
} from "~/lib/api-client.js";
import { abortAfter } from "~/lib/abort-after.js";
import { blobBytes } from "~/lib/blob-bytes.js";
import { SNIFF_BYTES } from "~/lib/test-runs/fixture-shape.js";
import { readsFor } from "~/lib/workspace-reads.js";

// The hang guard lives in its own module (`lib/abort-after.ts`); the Testing
// tab's components and the suites' and pipelines' stores import it from here.
export { abortAfter };

/*
 * The Testing tab's memory: the runs (the selection, the remembered
 * duration, My Files and the runs) and the templates (`templateFiles`,
 * `loadTemplateFiles`), with the hold over every Play
 * (`selectIsPlayHeld`) and the Play all under way (`playAll`, whose loops
 * are `lib/test-suites/play-all.ts`'s). Suites and definitions are
 * `test-suites-store.ts`'s; validation pipelines and their rules are
 * `validation-pipelines-store.ts`'s.
 * - My Files are read afresh each time the run dialog opens (`loadFiles`),
 *   never once a session; they are the person's in the organization they were
 *   read in, and a read for another organization starts from none;
 * - the selection is cleared when its file is deleted, and when a fresh
 *   read no longer lists it (another tab deleted it);
 * - the remembered duration refuses anything but an integer, read or
 *   written (a written 1.5 is refused, never rounded): stored, it is
 *   clamped to 1-60;
 * - a run is queued by the API (`queueRun`), which answers with the run; it
 *   joins the version's runs at once, selected unless a Play all chooses
 *   otherwise (`{select}`), so every Play is held while it waits
 *   (`selectIsPlayHeld`), unless the tab has left that version by the time
 *   the API answers;
 * - one hold for every Play: "Configure and run", ↺, a definition's Run
 *   test and both Play alls are held while the person's own run on the
 *   version is queued or running, while a Play all on it is under way
 *   (`playAll`), and while a single run is starting (`starting`: its head
 *   read, the fixture-shape question and its queue request), so a double
 *   click, or a Play during a head read, can't start two; each start
 *   checks and sets it at once, before anything is awaited (`beginStart`,
 *   `beginPlayAll`);
 * - the templates are read afresh each time the run dialog's Templates step
 *   shows (`loadTemplates`), never once a session; the remembered template
 *   leaves the selection when a fresh read no longer lists it; a read that
 *   never answers is aborted after 10 s, as the runs' reads are, and fails;
 * - the version's runs are polled here (`watchRuns`): the list every second
 *   while any run it lists, a teammate's included, is queued or running;
 *   stopped when none is, when the tab unmounts and when the version changes;
 *   each request aborted after 10 s, and the polling stopped after 30 failures
 *   in a row with "Failed to refresh test runs" and a retry (`retryRuns`).
 *   There is no total-time cap: every run ends by its lease or the down rule.
 *   A refusal (a 4xx but 408 and 429: the version gone, the organization left)
 *   stops it at once with the API's words, and a failed first read says
 *   "Failed to load test runs" at once: only a poll's failures, after
 *   something was shown, wait for 30;
 * - the selected run is read in full once it has ended (`runDetails`); an
 *   ended run never changes, so it is read once;
 * - a list answer to a request sent before this tab queued a run never
 *   drops that run (nor releases the hold it keeps): only a later answer
 *   speaks for it.
 *
 * Each file's first SNIFF_BYTES, for the fixture-shape check before a run, is
 * kept in memory when this tab uploads or saves it (`heads`), and read from
 * the API's `GET …/test-files/:fileId/head` for a file from an earlier
 * session (`headFor`).
 *
 * Its files' names, descriptions and heads, and the runs' text, logs and
 * inputs' names, are private text: they never reach an attribute, a log
 * line or an analytics event, and signing out forgets them (`reset`, from
 * useLogout). An upload, a sample or a queue that answers after signing out
 * adds nothing back.
 */

/** Where the remembered duration lives. */
export const LAST_RUN_DURATION_KEY = "telflo:lastRunDurationSeconds";

/** The duration before one is remembered. */
export const DEFAULT_RUN_DURATION_SECONDS = 5;

/** How often the version's runs are read while any is queued or running. */
export const RUNS_POLL_INTERVAL_MS = 1_000;

/** How long one read of the runs (or of a run) may take before it is aborted: the hang guard. */
export const RUNS_REQUEST_TIMEOUT_MS = 10_000;

/** How many failed reads of the runs in a row stop the polling. */
export const RUNS_FAILURES_BEFORE_STOP = 30;

/** What the tab says once the polling has stopped on failures. */
export const RUNS_REFRESH_FAILED_MESSAGE = "Failed to refresh test runs";

/** What the tab says at once when the first read of a version's runs fails. */
export const RUNS_LOAD_FAILED_MESSAGE = "Failed to load test runs";

/** The file the run dialog has chosen: its id and the name it showed. */
export interface SelectedTestFile {
  id: string;
  displayName: string;
}

/** The template the run dialog has chosen: its id and the name it showed. */
export interface SelectedTestTemplate {
  id: string;
  name: string;
}

/** The input a run or a definition is made from: one of the person's files, or a template. */
export type SelectedTestInput = ({ kind: "file" } & SelectedTestFile) | ({ kind: "template" } & SelectedTestTemplate);

/** How a Play all queues its suite's definitions. */
export type PlayAllMode = "parallel" | "serial";

/** A Play all under way, as the hold reads it. */
export interface PlayAllUnderWay {
  target: RunTarget;
  suiteId: string;
  mode: PlayAllMode;
}

/**
 * A Play all's own handle (`beginPlayAll`), for its loop
 * (`lib/test-suites/play-all.ts`): `stopped` once it has ended or been
 * stopped; `onStop`, while set, is called once when something else stops
 * it (signing out, the editor leaving its version).
 */
export interface PlayAllRun extends PlayAllUnderWay {
  stopped: boolean;
  onStop: (() => void) | null;
}

/** Where a run is queued: the version open in the editor, in the organization it was loaded in. */
export interface RunTarget {
  organizationId: string;
  configurationId: string;
  versionId: string;
}

export interface TestingState {
  /** The organization `files` and `selectedFile` belong to; null before a read. */
  filesOrganizationId: string | null;
  /** The person's own files in that organization, newest first. */
  files: TestFile[];
  filesLoading: boolean;
  /** Whether `files` holds an answer for `filesOrganizationId` (a refresh keeps showing it). */
  filesLoaded: boolean;
  /** The file the run dialog last ran with, as it opens next; null for none. */
  selectedFile: SelectedTestFile | null;
  /** The pipeline the run dialog last ran, by its name in the text; null for none (the first then). */
  selectedPipelineName: string | null;
  /** The remembered duration, 1-60. */
  lastRunDurationSeconds: number;
  /** Each file's first SNIFF_BYTES, kept when this tab uploaded or saved it, or read it from the API (`headFor`). Private text. */
  heads: Record<string, Uint8Array>;
  /** The version `runs` belong to; null before any. */
  runsVersionId: string | null;
  /** The version's runs, newest first, polled while any is queued or running; a queued run joins at once. */
  runs: TestRunSummary[];
  /** Whether a read of the runs is under way with none read yet for `runsVersionId`. */
  runsLoading: boolean;
  /** Whether `runs` holds an answer for `runsVersionId`. */
  runsLoaded: boolean;
  /**
   * Why the polling stopped, shown with Retry: the API's words for a refusal
   * (a 4xx), RUNS_LOAD_FAILED_MESSAGE when the first read failed, or
   * RUNS_REFRESH_FAILED_MESSAGE after 30 failures in a row; null otherwise.
   */
  runsError: string | null;
  /** The run the results show; null for none. */
  selectedRunId: string | null;
  /** Ended runs read in full, by id: each is read once, when selected. Private text. */
  runDetails: Record<string, TestRunDetail>;
  /** The selected run whose full read failed (shown with a retry); null otherwise. */
  runDetailFailedId: string | null;
  /** The live templates, newest first, as last read. Their names are private text. */
  templates: TestTemplate[];
  templatesLoading: boolean;
  /** Whether `templates` holds an answer. */
  templatesLoaded: boolean;
  /** The template the run dialog last ran with, as it opens next; null for none (a file then, or nothing). */
  selectedTemplate: SelectedTestTemplate | null;
  /** The Play all under way, if any: from its click until its last queue answer (parallel), or until its loop ends or stops (serial). */
  playAll: PlayAllUnderWay | null;
  /** The version a single run is starting on (Configure and run's Run, ↺, a definition's Run test), from its click until its queue request answers or its question is cancelled; null otherwise. */
  starting: RunTarget | null;

  /** Reads the person's files afresh (each time the run dialog opens); rejects as the API did. */
  loadFiles: (organizationId: string) => Promise<TestFile[]>;
  /** Uploads a file; the saved file joins the list's top. Rejects as the API did. */
  uploadFile: (organizationId: string, upload: { displayName: string; description: string; file: File }) => Promise<TestFile>;
  /** Saves a pasted sample as a file; it joins the list's top. Rejects as the API did. */
  saveSample: (organizationId: string, sample: { displayName: string; text: string; format: TestSampleFormat }) => Promise<TestFile>;
  /** Deletes a file: gone from the list, and from the selection when it was the one selected. */
  deleteFile: (organizationId: string, fileId: string) => Promise<void>;
  setSelectedFile: (file: SelectedTestFile | null) => void;
  setSelectedTemplate: (template: SelectedTestTemplate | null) => void;
  /**
   * Reads the live templates afresh (each time the Templates step shows), aborted after RUNS_REQUEST_TIMEOUT_MS;
   * rejects as the API did. The templates are the product's, read for no organization; `organizationId` (the
   * editor's) only says whose reads answer: the sample workspace's answer from the sample.
   */
  loadTemplates: (organizationId?: string | null) => Promise<TestTemplate[]>;
  setSelectedPipelineName: (name: string | null) => void;
  /** Remembers a duration (an integer, 1-60, else ignored), in the browser too when it can. */
  setLastRunDurationSeconds: (seconds: number) => void;
  /**
   * A file's first SNIFF_BYTES for the fixture-shape check: kept, or read from
   * the API; null when it can't be read (the check is then skipped).
   */
  headFor: (organizationId: string, fileId: string) => Promise<Uint8Array | null>;
  /**
   * Queues a run of the target version; the run joins `runs` at once, when
   * the target is the version watched, selected unless `select` is false (a
   * parallel Play all selects one itself). Rejects as the API did.
   */
  queueRun: (target: RunTarget, request: QueueTestRunRequest, options?: { select?: boolean }) => Promise<TestRunDetail>;
  /** A run read in full (a serial Play all follows its own): its row takes its state, when it is listed. */
  noteRun: (run: TestRunDetail) => void;
  /**
   * Starts a single run on `target`: false when Play is held for `userId`
   * there; otherwise `starting` is set at once, before anything is
   * awaited, and the answer releases it (once; a later start's hold is
   * never released by an earlier one's).
   */
  beginStart: (target: RunTarget, userId: string | null) => false | (() => void);
  /**
   * Starts a Play all of `suiteId` on `target`: null when Play is held for
   * `userId` there; otherwise `playAll` is set at once, before anything is
   * awaited, and the handle given to its loop.
   */
  beginPlayAll: (target: RunTarget, suiteId: string, mode: PlayAllMode, userId: string | null) => PlayAllRun | null;
  /** Ends a Play all: `playAll` is cleared when it is still this one's. */
  endPlayAll: (run: PlayAllRun) => void;
  /** Stops a Play all from outside its loop: it queues nothing more, and its wait and read are cut short. */
  stopPlayAll: (run: PlayAllRun) => void;
  /** Reads the target version's runs and polls them while any is queued or running; the returned function stops it. */
  watchRuns: (target: RunTarget) => () => void;
  /** Reads the runs again, and polls again, after the polling stopped on failures. */
  retryRuns: () => void;
  /** Shows a run's results: an ended run is read in full, once. */
  selectRun: (runId: string | null) => void;
  /** Reads the selected run in full again, after that read failed. */
  retryRunDetail: () => void;
  /** Forgets everything but the remembered duration, and stops the polling and any Play all (signing out). */
  reset: () => void;
}

/**
 * The browser's localStorage when it is usable, else null: on the server;
 * where the property access itself throws (Safari's private mode, storage
 * blocked); where it lacks its methods (Node's own Web Storage global under
 * vitest).
 */
function usableLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    return typeof storage?.getItem === "function" && typeof storage?.setItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

/** Whether `seconds` is a duration a run may have: an integer, 1-60. */
export function isRunDuration(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= TEST_RUN_DURATION_MINIMUM_SECONDS && seconds <= TEST_RUN_DURATION_MAXIMUM_SECONDS;
}

/**
 * The remembered duration: the stored whole number, clamped to 1-60 (a
 * hand-edited value can't reach a queue request); the default when there is
 * none, it isn't a whole number, or storage can't be read.
 */
export function readRememberedDuration(): number {
  try {
    const raw = usableLocalStorage()?.getItem(LAST_RUN_DURATION_KEY);
    if (raw == null || !/^\s*-?\d+\s*$/.test(raw)) return DEFAULT_RUN_DURATION_SECONDS;
    const stored = Number(raw);
    return Math.max(TEST_RUN_DURATION_MINIMUM_SECONDS, Math.min(TEST_RUN_DURATION_MAXIMUM_SECONDS, stored));
  } catch {
    return DEFAULT_RUN_DURATION_SECONDS;
  }
}

/** Stores a duration, when storage can be written; a failure (full, blocked) keeps it for this page only. */
function storeRememberedDuration(seconds: number): void {
  try {
    usableLocalStorage()?.setItem(LAST_RUN_DURATION_KEY, String(seconds));
  } catch {
    // Remembered for this page alone.
  }
}

/** A file's head for the fixture-shape check, or null when it couldn't be read (the check is then skipped). */
async function headOf(file: Blob): Promise<Uint8Array | null> {
  try {
    return await blobBytes(file.slice(0, SNIFF_BYTES));
  } catch {
    return null;
  }
}

/** Whether a run is waiting or running: the polling goes on while any listed run is. */
export function isRunActive(run: Pick<TestRunSummary, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

/** Newest first, as the API lists them: by when they were queued, then by id (time-ordered UUIDv7). */
function newestFirst(left: TestRunSummary, right: TestRunSummary): number {
  if (left.queuedAt !== right.queuedAt) return left.queuedAt < right.queuedAt ? 1 : -1;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/** The list's fields, from the contract's own shape: a field the list gains can't be left out here. */
const SUMMARY_KEYS = Object.keys(TestRunSummarySchema.shape) as Array<keyof TestRunSummary>;

/** A run's summary, as the version's list carries it: exactly the summary's fields of the run. */
function summaryOf(run: TestRunDetail): TestRunSummary {
  return Object.fromEntries(SUMMARY_KEYS.map((key) => [key, run[key]])) as TestRunSummary;
}

const EMPTY_FILES = {
  filesOrganizationId: null,
  files: [],
  filesLoading: false,
  filesLoaded: false,
  selectedFile: null,
  selectedPipelineName: null,
  heads: {},
  runsVersionId: null,
  runs: [],
  runsLoading: false,
  runsLoaded: false,
  runsError: null,
  selectedRunId: null,
  runDetails: {},
  runDetailFailedId: null,
  templates: [],
  templatesLoading: false,
  templatesLoaded: false,
  selectedTemplate: null,
  playAll: null,
  starting: null,
} satisfies Partial<TestingState>;

/** The latest files read asked for: an answer to an earlier one is dropped. */
let filesRead = 0;

/** Counts sign-outs (`reset`): an answer to a request made before one adds nothing to the store. */
let session = 0;

/** The latest templates read asked for: an answer to an earlier one is dropped. */
let templatesRead = 0;

/** The single run starting, by its own token: only its own release clears `starting`. */
let startingToken: object | null = null;

/** The Play all under way, if any: its loop's handle. */
let playing: PlayAllRun | null = null;

/** The polling of one version's runs (`watchRuns`). */
interface RunsWatch {
  target: RunTarget;
  /** The next read's timer, while one waits. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The read under way, if any: only one at a time. */
  request: { abort: () => void } | null;
  /** Failed reads in a row. */
  failures: number;
  /** Stopped on failures, or because the session ended: only `retryRuns` (or a queued run) starts it again. */
  stopped: boolean;
  /** How many reads of the list have been sent. */
  sent: number;
  /** Runs this tab queued, each with how many reads had been sent then: an answer to one of those may not list it. */
  queued: Map<string, number>;
  /** Runs whose full read is under way. */
  detailsReading: Set<string>;
}

/** The version whose runs are watched, if any: one at a time, as one editor is open. */
let watch: RunsWatch | null = null;

/** Whether `left` and `right` name the same version in the same organization. */
function sameTarget(left: RunTarget, right: RunTarget): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.configurationId === right.configurationId &&
    left.versionId === right.versionId
  );
}

/** Answers a 4xx that time won't change: not 408 (a timeout) or 429 (too many requests), which pass. */
export function isRefusal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/** Stops the polling: no timer left, the read under way aborted, its answer dropped. */
function stopWatching(): void {
  const stopping = watch;
  if (stopping === null) return;
  watch = null;
  if (stopping.timer !== null) clearTimeout(stopping.timer);
  stopping.timer = null;
  stopping.request?.abort();
  stopping.request = null;
}

export const useTestingStore = create<TestingState>()((set, get) => {
  /** The state for `organizationId`'s files: as it is, or from none when they were another organization's. */
  const forOrganization = (organizationId: string): Partial<TestingState> =>
    get().filesOrganizationId === organizationId
      ? {}
      : { filesOrganizationId: organizationId, files: [], filesLoaded: false, selectedFile: null, heads: {} };

  /** A saved file joins the list's top, with its head; a list of another organization's is left for it. */
  const added = (organizationId: string, file: TestFile, head: Uint8Array | null) => {
    set((state) => {
      const same = state.filesOrganizationId === organizationId;
      const files = same ? state.files : [];
      const heads = same ? state.heads : {};
      return {
        ...(same ? {} : { filesOrganizationId: organizationId, filesLoaded: false, selectedFile: null }),
        files: [file, ...files.filter((listed) => listed.id !== file.id)],
        heads: head === null ? heads : { ...heads, [file.id]: head },
      };
    });
  };

  return {
    ...EMPTY_FILES,
    lastRunDurationSeconds: readRememberedDuration(),

    loadFiles: async (organizationId) => {
      const thisRead = ++filesRead;
      set({ ...forOrganization(organizationId), filesLoading: true });
      try {
        const { files } = await readsFor(organizationId).getTestFiles(organizationId);
        if (thisRead !== filesRead || get().filesOrganizationId !== organizationId) return files;
        const listed = new Set(files.map((file) => file.id));
        set((state) => ({
          files,
          filesLoaded: true,
          filesLoading: false,
          selectedFile: state.selectedFile !== null && listed.has(state.selectedFile.id) ? state.selectedFile : null,
          heads: Object.fromEntries(Object.entries(state.heads).filter(([id]) => listed.has(id))),
        }));
        return files;
      } catch (error) {
        if (thisRead === filesRead) set({ filesLoading: false });
        throw error;
      }
    },

    uploadFile: async (organizationId, upload) => {
      const at = session;
      const [{ file }, head] = await Promise.all([uploadTestFile(organizationId, upload), headOf(upload.file)]);
      if (session === at) added(organizationId, file, head);
      return file;
    },

    saveSample: async (organizationId, sample) => {
      const at = session;
      const { file } = await saveTestSample(organizationId, sample);
      // A copy of the head alone (`slice`), not a view keeping the whole encoded sample.
      if (session === at) added(organizationId, file, new TextEncoder().encode(sample.text).slice(0, SNIFF_BYTES));
      return file;
    },

    deleteFile: async (organizationId, fileId) => {
      await deleteTestFile(organizationId, fileId);
      set((state) => {
        if (state.filesOrganizationId !== organizationId) return {};
        const { [fileId]: _deleted, ...heads } = state.heads;
        return {
          files: state.files.filter((file) => file.id !== fileId),
          heads,
          selectedFile: state.selectedFile?.id === fileId ? null : state.selectedFile,
        };
      });
    },

    setSelectedFile: (file) => set({ selectedFile: file }),

    setSelectedTemplate: (template) => set({ selectedTemplate: template }),

    loadTemplates: async (organizationId = null) => {
      const thisRead = ++templatesRead;
      set({ templatesLoading: true });
      // A read that never answers ends after the hang guard, as a failure.
      const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
      try {
        const { templates } = await readsFor(organizationId).getTestTemplates({ signal: timeout.signal });
        if (thisRead !== templatesRead) return templates;
        const listed = new Set(templates.map((template) => template.id));
        set((state) => ({
          templates,
          templatesLoaded: true,
          templatesLoading: false,
          // A template deleted since leaves the remembered selection.
          selectedTemplate: state.selectedTemplate !== null && listed.has(state.selectedTemplate.id) ? state.selectedTemplate : null,
        }));
        return templates;
      } catch (error) {
        if (thisRead === templatesRead) set({ templatesLoading: false });
        throw error;
      } finally {
        timeout.clear();
      }
    },

    setSelectedPipelineName: (name) => set({ selectedPipelineName: name }),

    setLastRunDurationSeconds: (seconds) => {
      if (!isRunDuration(seconds)) return;
      storeRememberedDuration(seconds);
      set({ lastRunDurationSeconds: seconds });
    },

    headFor: async (organizationId, fileId) => {
      const state = get();
      const kept = state.filesOrganizationId === organizationId ? state.heads[fileId] : undefined;
      if (kept !== undefined) return kept;
      const at = session;
      const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
      try {
        const head = (await readsFor(organizationId).getTestFileHead(organizationId, fileId, { signal: timeout.signal })).slice(
          0,
          SNIFF_BYTES,
        );
        const now = get();
        if (session === at && now.filesOrganizationId === organizationId && now.files.some((file) => file.id === fileId)) {
          set((latest) => ({ heads: { ...latest.heads, [fileId]: head } }));
        }
        return head;
      } catch {
        return null;
      } finally {
        timeout.clear();
      }
    },

    queueRun: async (target, request, options = {}) => {
      const at = session;
      const { run } = await queueTestRun(target.organizationId, target.configurationId, target.versionId, request);
      if (session !== at) return run;
      // Shown only while its version is the one watched: an answer for a
      // version the tab has since left touches nothing, so the version now
      // shown keeps its runs, selection and polling.
      const watching = watch !== null && sameTarget(watch.target, target) ? watch : null;
      if (watching === null) return run;
      watching.queued.set(run.id, watching.sent);
      const select = options.select ?? true;
      set((state) => ({
        runsVersionId: target.versionId,
        runs: [summaryOf(run), ...(state.runsVersionId === target.versionId ? state.runs.filter((listed) => listed.id !== run.id) : [])],
        ...(select ? { selectedRunId: run.id } : {}),
      }));
      // The new run is waiting: poll until it ends, starting again if the polling had stopped.
      if (watching.stopped) resume(watching);
      else schedule(watching);
      return run;
    },

    noteRun: (run) => {
      set((state) =>
        state.runsVersionId === run.versionId && state.runs.some((listed) => listed.id === run.id)
          ? { runs: state.runs.map((listed) => (listed.id === run.id ? summaryOf(run) : listed)) }
          : {},
      );
    },

    beginStart: (target, userId) => {
      if (selectIsPlayHeld(get(), userId, target.versionId)) return false;
      const token = {};
      startingToken = token;
      set({ starting: target });
      return () => {
        if (startingToken !== token) return;
        startingToken = null;
        set({ starting: null });
      };
    },

    beginPlayAll: (target, suiteId, mode, userId) => {
      if (selectIsPlayHeld(get(), userId, target.versionId)) return null;
      // One at a time, as one editor is open: another version's (which its loop stops as the editor leaves it) ends here.
      if (playing !== null) get().stopPlayAll(playing);
      const run: PlayAllRun = { target, suiteId, mode, stopped: false, onStop: null };
      playing = run;
      set({ playAll: { target, suiteId, mode } });
      return run;
    },

    endPlayAll: (run) => {
      run.stopped = true;
      run.onStop = null;
      if (playing !== run) return;
      playing = null;
      set({ playAll: null });
    },

    stopPlayAll: (run) => {
      if (run.stopped) return;
      run.stopped = true;
      const onStop = run.onStop;
      run.onStop = null;
      onStop?.();
      get().endPlayAll(run);
    },

    watchRuns: (target) => {
      stopWatching();
      const watching: RunsWatch = {
        target,
        timer: null,
        request: null,
        failures: 0,
        stopped: false,
        sent: 0,
        queued: new Map(),
        detailsReading: new Set(),
      };
      watch = watching;
      set((state) =>
        state.runsVersionId === target.versionId
          ? { runsLoading: !state.runsLoaded, runsError: null }
          : {
              runsVersionId: target.versionId,
              runs: [],
              runsLoading: true,
              runsLoaded: false,
              runsError: null,
              selectedRunId: null,
              runDetails: {},
              runDetailFailedId: null,
            },
      );
      read(watching);
      return () => {
        if (watch === watching) stopWatching();
      };
    },

    retryRuns: () => {
      if (watch !== null) resume(watch);
    },

    selectRun: (runId) => {
      set((state) => ({ selectedRunId: runId, runDetailFailedId: state.runDetailFailedId === runId ? state.runDetailFailedId : null }));
      if (watch !== null) readSelectedIfEnded(watch);
    },

    retryRunDetail: () => {
      set({ runDetailFailedId: null });
      if (watch !== null) readSelectedIfEnded(watch);
    },

    reset: () => {
      filesRead++;
      templatesRead++;
      session++;
      stopWatching();
      if (playing !== null) get().stopPlayAll(playing);
      startingToken = null;
      set({ ...EMPTY_FILES });
    },
  };

  /** Reads the watched version's runs once (one read at a time), then polls on or stops. */
  function read(watching: RunsWatch): void {
    if (watch !== watching || watching.stopped || watching.request !== null) return;
    watching.sent += 1;
    const sentAs = watching.sent;
    const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
    watching.request = timeout;
    const { organizationId, configurationId, versionId } = watching.target;
    readsFor(organizationId).getTestRuns(organizationId, configurationId, versionId, { signal: timeout.signal }).then(
      ({ runs }) => {
        timeout.clear();
        if (watch !== watching) return;
        watching.request = null;
        watching.failures = 0;
        merge(watching, runs, sentAs);
        readSelectedIfEnded(watching);
        if (get().runs.some(isRunActive)) schedule(watching);
      },
      (error: unknown) => {
        timeout.clear();
        if (watch !== watching) return;
        watching.request = null;
        // The session-ended handler is taking the browser to sign in.
        if (isSessionEnded(error)) {
          watching.stopped = true;
          set({ runsLoading: false });
          return;
        }
        // A refusal (the version gone or no longer visible, the organization
        // left): reading again won't change it. A 408 or a 429 passes with
        // time, so it counts as transient.
        if (isRefusal(error)) {
          watching.stopped = true;
          set({ runsLoading: false, runsError: error.message });
          return;
        }
        // Nothing shown yet for this version: say so now, not 30 s from now.
        if (!get().runsLoaded) {
          watching.stopped = true;
          set({ runsLoading: false, runsError: RUNS_LOAD_FAILED_MESSAGE });
          return;
        }
        watching.failures += 1;
        if (watching.failures >= RUNS_FAILURES_BEFORE_STOP) {
          watching.stopped = true;
          set({ runsLoading: false, runsError: RUNS_REFRESH_FAILED_MESSAGE });
          return;
        }
        schedule(watching);
      },
    );
  }

  /** The next read in RUNS_POLL_INTERVAL_MS, unless one is under way or already waits. */
  function schedule(watching: RunsWatch): void {
    if (watch !== watching || watching.stopped || watching.timer !== null || watching.request !== null) return;
    watching.timer = setTimeout(() => {
      watching.timer = null;
      read(watching);
    }, RUNS_POLL_INTERVAL_MS);
  }

  /** Starts a stopped polling again, at once, with its failures forgotten. */
  function resume(watching: RunsWatch): void {
    watching.stopped = false;
    watching.failures = 0;
    set((state) => ({ runsError: null, runsLoading: !state.runsLoaded }));
    read(watching);
  }

  /**
   * The answer to the `sentAs`th read becomes the version's runs, but for a
   * run this tab queued after that read was sent: the answer may not list it
   * yet, so it stays as it is until a later answer speaks for it.
   */
  function merge(watching: RunsWatch, answer: TestRunSummary[], sentAs: number): void {
    const listed = new Set(answer.map((run) => run.id));
    set((state) => {
      const kept = state.runs.filter((run) => !listed.has(run.id) && (watching.queued.get(run.id) ?? 0) >= sentAs);
      return {
        runs: [...kept, ...answer].sort(newestFirst),
        runsLoading: false,
        runsLoaded: true,
        runsError: null,
      };
    });
    for (const [id, sentBefore] of watching.queued) if (sentAs > sentBefore) watching.queued.delete(id);
  }

  /** Reads the selected run in full once it has ended, unless it has been read, is being read, or its read failed. */
  function readSelectedIfEnded(watching: RunsWatch): void {
    const { selectedRunId: id, runs, runDetails, runDetailFailedId } = get();
    if (id === null || runDetails[id] !== undefined || runDetailFailedId === id || watching.detailsReading.has(id)) return;
    const summary = runs.find((run) => run.id === id);
    if (summary === undefined || isRunActive(summary)) return;
    watching.detailsReading.add(id);
    const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
    const { organizationId, configurationId, versionId } = watching.target;
    readsFor(organizationId).getTestRun(organizationId, configurationId, versionId, id, { signal: timeout.signal }).then(
      ({ run }) => {
        timeout.clear();
        watching.detailsReading.delete(id);
        if (watch !== watching || isRunActive(run)) return;
        set((state) => ({ runDetails: { ...state.runDetails, [id]: run } }));
      },
      (error: unknown) => {
        timeout.clear();
        watching.detailsReading.delete(id);
        if (watch !== watching || isSessionEnded(error)) return;
        set({ runDetailFailedId: id });
      },
    );
  }
});

/**
 * Whether every Play is held for `userId` on `versionId`: while a run of
 * theirs on that version is queued or running, while a Play all on it is under
 * way, and while a single run is starting on it. A teammate's runs never hold
 * it.
 */
export function selectIsPlayHeld(
  state: Pick<TestingState, "runs" | "runsVersionId" | "playAll" | "starting">,
  userId: string | null,
  versionId: string | null,
): boolean {
  if (versionId === null) return false;
  if (state.playAll !== null && state.playAll.target.versionId === versionId) return true;
  if (state.starting !== null && state.starting.versionId === versionId) return true;
  if (userId === null || state.runsVersionId !== versionId) return false;
  return state.runs.some((run) => run.queuedByUserId === userId && (run.status === "queued" || run.status === "running"));
}
