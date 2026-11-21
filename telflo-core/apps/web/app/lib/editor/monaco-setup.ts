import { loader, type Monaco } from "@monaco-editor/react";
import type { JSONSchema, MonacoYaml } from "monaco-yaml";

import { monacoYamlOptions, type CollectorSchemaEntry } from "./collector-schema.js";

/*
 * Monaco from the app's own bundle, never a CDN, without otelbin's OTel
 * schema and without the JSON worker.
 *
 * The collector's schema: the YAML tab's pin picks one (`schemaPathFor`), and
 * setMonacoSchema below fetches that file from the app's own origin, keeps it
 * for the tab, and gives it to monaco-yaml inline, with schema requests off,
 * so nothing is ever requested from anywhere else. With a schema, completion,
 * hover and the schema's Warning markers; without one (a null or retired pin,
 * a distribution without schemas, a fetch that failed), YAML's syntax markers
 * only.
 *
 * monaco-yaml only works with Monaco's ESM build. @monaco-editor/react loads
 * the UMD build from cdn.jsdelivr.net unless `loader.config({ monaco })` has
 * run first, so YamlEditor never mounts its `Editor` before initMonaco()
 * resolves: a mount before that fetches from the CDN.
 *
 * The three packages are pinned exactly in package.json, which can't carry a
 * comment, so the reason is here. From 0.56, monaco-editor's exports map
 * sends `monaco-editor/esm/vs/editor/editor.worker.js` to `esm/vs/esm/vs/…`,
 * which doesn't exist. monaco-yaml's worker imports exactly that path
 * through monaco-worker-manager 2.0.1 (last published in 2022), so a build
 * with a newer monaco-editor fails. Before raising monaco-editor, a
 * monaco-yaml (or monaco-worker-manager) that imports a path 0.56's exports
 * map allows must exist. The production build
 * (`npm run build --workspace=@telflo/web`) is one test; the other is a YAML
 * syntax error showing its marker in a browser, since the worker manager
 * also needs withPre055WebWorkers below.
 *
 * `import("monaco-editor")` also builds the CSS, HTML, JSON and TypeScript
 * workers into the bundle (Monaco's language contributions name them), but
 * nothing here starts them: getWorker below returns only the editor's and
 * YAML's. No CSS, HTML or TypeScript model is ever made.
 *
 * JSON models are: the Testing tab's sample editor and its viewers show test
 * inputs and outputs as JSON. Monaco's JSON language features run in the
 * JSON worker, which isn't registered here (`vite.config.ts` is untouched),
 * and a JSON model with them on throws uncaught page errors in every
 * browser. So initMonaco switches them all off before any model exists, but
 * the tokenizer, which runs on the page: coloring stays, folding falls back
 * to indentation, and the side-by-side DiffEditor works. No completion,
 * hover, validation or formatting reaches a JSON model.
 */

let initPromise: Promise<void> | null = null;

/**
 * JSON's mode configuration: every language feature off, since each needs the
 * JSON worker, which isn't registered; the tokens on, for coloring.
 */
export const JSON_MODE_CONFIGURATION = {
  documentFormattingEdits: false,
  documentRangeFormattingEdits: false,
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  tokens: true,
  colors: false,
  foldingRanges: false,
  diagnostics: false,
  selectionRanges: false,
} as const;

/** monaco-yaml, once initMonaco configured it; null before, and always on the server. */
let monacoYaml: MonacoYaml | null = null;
/** The schema the editor on screen wants: its pin's path (`schemaPathFor`), or null for syntax only. */
let desiredPath: string | null = null;
/** The path whose schema monaco-yaml has now, or null while it has syntax only. */
let appliedPath: string | null = null;
/** Counts the schema changes asked for: an answer for an earlier one is stale, and dropped. */
let sequence = 0;
/** Each path's schema once it arrived, for this tab: a pin switched back reuses it. */
const fetched = new Map<string, JSONSchema>();
/**
 * Each path's fetch while it runs, so a second ask shares it. Every fetch
 * settles (the hang guard below), and a failure is never kept, so the next
 * pin change or mount asks again.
 */
const fetching = new Map<string, Promise<JSONSchema | null>>();

/**
 * How long a schema's fetch may take before it is given up as failed: a
 * generous hang guard (the file is about 200 KB gzipped, from the app's own
 * origin), so a request that never answers is tried again on the next pin
 * change or mount instead of being waited on for the tab's life.
 */
export const SCHEMA_FETCH_TIMEOUT_MS = 15_000;

/**
 * Loads Monaco and monaco-yaml, once, in the browser; on the server it
 * returns at once and imports nothing. The only way the app reaches Monaco:
 * the import is dynamic, so no route's chunk and no server-rendered module
 * pulls monaco-editor in.
 *
 * The order, with the JSON mode's step:
 * 1. import the local ESM Monaco;
 * 2. set MonacoEnvironment.getWorker (after the import, before monaco-yaml);
 * 3. JSON's language features off but its tokens, before any model can
 *    exist (no editor mounts before step 4);
 * 4. `loader.config({ monaco })`, so @monaco-editor/react uses it;
 * 5. configure monaco-yaml.
 *
 * The schema setMonacoSchema last asked for is fetched alongside Monaco's
 * import (and a pin changed while it loads has its file asked for at once),
 * but never waited on: the editor mounts as soon as Monaco is ready.
 * monaco-yaml is configured with that schema if it has arrived by then, else
 * with syntax only, and the schema is given to it with `update` when it
 * arrives. No YAML worker exists before a model mounts, so a late schema
 * costs at most one worker restart. A schema for a pin changed meanwhile is
 * never applied; a pin whose fetch failed while Monaco loaded is asked for
 * again once Monaco is ready.
 *
 * A failure (a chunk that didn't arrive, say) rejects, and is forgotten: the
 * next call loads again, so YamlEditor's "Try again" can work without a
 * reload of the page, which would lose unsaved text. A schema that didn't
 * arrive isn't a failure: the editor has syntax markers only.
 */
export function initMonaco(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (desiredPath !== null) void loadSchema(desiredPath);
    const monaco = await import("monaco-editor");

    // The worker files sit next to this one; vite.config.ts lists them in
    // optimizeDeps.entries.
    self.MonacoEnvironment = {
      getWorker(_moduleId: string, label: string) {
        if (label === "yaml") {
          return new Worker(new URL("./yaml.worker.ts", import.meta.url), { type: "module" });
        }
        return new Worker(new URL("./editor.worker.ts", import.meta.url), { type: "module" });
      },
    };

    // Only the tokenizer, which needs no worker (see above). `monaco.json` is
    // the namespace 0.55 types; `monaco.languages.json` is the same object
    // under its deprecated name.
    monaco.json.jsonDefaults.setModeConfiguration(JSON_MODE_CONFIGURATION);

    loader.config({ monaco });

    const { configureMonacoYaml } = await import("monaco-yaml");
    const path = desiredPath;
    const schema = path === null ? null : (fetched.get(path) ?? null);
    const applied = schema === null ? null : path;
    monacoYaml = configureMonacoYaml(withPre055WebWorkers(monaco), monacoYamlOptions(schemaEntry(applied, schema)));
    appliedPath = applied;
    // Whenever the pin's schema isn't the one configured: still on its way
    // (the update shares that fetch), a pin changed since the fetch began, or
    // a fetch that failed while Monaco loaded (asked again now, so a pin
    // bounced A → B → A during the load isn't left with syntax only).
    if (path !== applied) void applyDesiredSchema();
  })().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });

  return initPromise;
}

/**
 * The collector schema for the YAML tab: `path` is the pin's (`schemaPathFor`:
 * `/schemas/<distribution>/v<version>.json`), or null for syntax only.
 * Recorded at once, and its file asked for at once while Monaco loads; once
 * monaco-yaml is configured, applied when it differs from what monaco-yaml
 * has: the file is fetched from the app's own origin (a path naming any other
 * origin is never requested), kept for the tab, and given to monaco-yaml
 * inline. A pin change switches at once: to a schema already kept, or to
 * syntax only until the new one arrives, never keeping the previous pin's.
 * monaco-yaml's `update` restarts its worker, so it is called only when what
 * it has actually changes.
 *
 * An answer for a path asked for before the last call is dropped (a pin
 * switched A → B while A's file was on its way ends on B). A fetch that
 * fails, answers anything but a JSON object, or doesn't answer within
 * SCHEMA_FETCH_TIMEOUT_MS leaves syntax markers only, without a message, and
 * is tried again on the next change or mount. On the server it does
 * nothing.
 */
export function setMonacoSchema(path: string | null): void {
  if (typeof window === "undefined") return;
  desiredPath = path;
  if (monacoYaml !== null) {
    void applyDesiredSchema();
  } else if (initPromise !== null && path !== null) {
    // Monaco still loading: initMonaco configures for this path when it is
    // ready, and this path's file is asked for now, alongside the load.
    // Nothing of Monaco's is touched, so no worker starts.
    void loadSchema(path);
  }
}

/**
 * Gives monaco-yaml the desired path's schema, unless a later change
 * overtakes it. A schema already in memory (or none, for a null path) is
 * applied at once, in one update. One still to be fetched leaves syntax only
 * at once, so the previous pin's names are never offered for this one, and
 * is applied when it arrives (a pin change switches it at once).
 */
async function applyDesiredSchema(): Promise<void> {
  const ticket = ++sequence;
  const path = desiredPath;
  if (path === appliedPath) return;
  const kept = path === null ? undefined : fetched.get(path);
  if (path === null || kept !== undefined) {
    applySchema(path, kept ?? null);
    return;
  }
  applySchema(null, null);
  const schema = await loadSchema(path);
  if (ticket !== sequence) return;
  applySchema(schema === null ? null : path, schema);
}

/** Gives monaco-yaml `path`'s schema (null for syntax only), unless it has it already: each update restarts its worker. */
function applySchema(path: string | null, schema: JSONSchema | null): void {
  if (monacoYaml === null || path === appliedPath) return;
  appliedPath = path;
  // Its revalidation's outcome is the markers themselves; nothing to report.
  monacoYaml.update(monacoYamlOptions(schemaEntry(path, schema))).catch(() => undefined);
}

/** The schema monaco-yaml gets for `path`, under the URI the app serves it at; null for syntax only. */
function schemaEntry(path: string | null, schema: JSONSchema | null): CollectorSchemaEntry | null {
  return path === null || schema === null ? null : { uri: new URL(path, window.location.origin).href, schema };
}

/** `path`'s schema: the tab's copy, the fetch already running, or fetched now; null when it couldn't be had. */
function loadSchema(path: string): Promise<JSONSchema | null> {
  const kept = fetched.get(path);
  if (kept !== undefined) return Promise.resolve(kept);
  const running = fetching.get(path);
  if (running !== undefined) return running;
  const loading = fetchSchema(path).then((schema) => {
    fetching.delete(path);
    if (schema !== null) fetched.set(path, schema);
    return schema;
  });
  fetching.set(path, loading);
  return loading;
}

/**
 * `path`'s file, fetched from the app's own origin and parsed, or null: a
 * path that resolves to another origin (never requested), a redirect
 * (refused, so it can't lead elsewhere), an error status, a network
 * failure, an answer that isn't a JSON object, or no answer within
 * SCHEMA_FETCH_TIMEOUT_MS (the request is aborted).
 */
async function fetchSchema(path: string): Promise<JSONSchema | null> {
  const abort = new AbortController();
  const guard = setTimeout(() => abort.abort(), SCHEMA_FETCH_TIMEOUT_MS);
  try {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const response = await fetch(url, { redirect: "error", signal: abort.signal });
    if (!response.ok) return null;
    const schema: unknown = await response.json();
    return typeof schema === "object" && schema !== null && !Array.isArray(schema) ? (schema as JSONSchema) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(guard);
  }
}

/**
 * Monaco as monaco-yaml's worker manager expects it. monaco-worker-manager
 * 2.0.1 starts the YAML worker with `monaco.editor.createWebWorker({
 * moduleId, label, createData })`, the form before 0.55. In 0.55 that
 * function takes a Worker instead (a descriptor-less call throws "Cannot use
 * 'in' operator to search for 'then' in undefined", Monaco logs "Could not
 * create web worker(s)", and no marker ever appears), and the old form is the
 * top-level `monaco.createWebWorker`. It calls MonacoEnvironment.getWorker
 * with the label, then posts "ignore" and the createData, the two messages
 * the worker manager's worker side waits for.
 *
 * So monaco-yaml gets a Monaco whose `editor.createWebWorker` sends only a
 * call in the old form (no `worker`) to the top-level one; a call in 0.55's
 * form still reaches the editor namespace's own, so a monaco-yaml that starts
 * using it keeps working. Everything else is Monaco's own. The fix lives
 * here, not as a patch to monaco-worker-manager in node_modules, in the one
 * file that knows why the versions are pinned. The root package.json's
 * `overrides` pins monaco-worker-manager at 2.0.1, the version this was
 * written against.
 *
 * Remove this, and that override, once monaco-worker-manager (or
 * monaco-yaml without it) calls 0.55's `createWebWorker({ worker })`: then
 * pass monaco-yaml Monaco itself, and check that a YAML syntax error still
 * shows its marker in the browser tests.
 */
export function withPre055WebWorkers(monaco: Monaco): Monaco {
  type CurrentOptions = Parameters<Monaco["editor"]["createWebWorker"]>[0];
  type PreviousOptions = Parameters<Monaco["createWebWorker"]>[0];
  const createWebWorker = (options: CurrentOptions | PreviousOptions) =>
    "worker" in options ? monaco.editor.createWebWorker(options) : monaco.createWebWorker(options);
  const editor: Monaco["editor"] = Object.assign(Object.create(monaco.editor), { createWebWorker });
  return { ...monaco, editor };
}
