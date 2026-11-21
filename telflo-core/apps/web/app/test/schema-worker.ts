import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JSONSchema, MonacoYamlOptions } from "monaco-yaml";
import { vi } from "vitest";

import { monacoYamlOptions } from "~/lib/editor/collector-schema.js";

/*
 * monaco-yaml's own worker (yaml-language-server inside, as the editor
 * bundles it), run in Node over a collector schema: what the YAML tab would
 * mark, complete and show on hover for a text.
 *
 * `vitest.config.ts` inlines `monaco-yaml/yaml.worker.js`, so its import of
 * `monaco-worker-manager/worker` reaches the mock below, whose `initialize`
 * hands over the worker's factory. The factory is what Monaco's worker
 * manager calls with the editor's options (`configureMonacoYaml`'s
 * `createData`); the object it returns is the API the editor calls
 * (`doValidation`, `doComplete`, `doHover`), each taking a model's URI.
 *
 * The options are the editor's own (`monacoYamlOptions`), and the
 * `createData` is what monaco-yaml makes of them: its own
 * `configureMonacoYaml`, given a stand-in Monaco, merges them into its
 * defaults, and `getOptions()` hands over the result, so nothing here copies
 * either.
 *
 * yaml-language-server keeps parsed documents at module level, by URI and
 * version, shared by every worker in the file: so every check gets a model
 * URI no other check has used (a second text under a reused URI, at the
 * same version, is answered from the first text's parse: seen while
 * building this). Schemas are kept per worker (each language service has
 * its own schema service), so a fresh schema URI per worker is a
 * precaution, not a necessity. One worker serves every check of one schema
 * in a file: loading a 2 MB schema is the slow part.
 */

/** An LSP diagnostic's severity: monaco-yaml turns 1 into an Error marker (8) and 2 into a Warning (4). */
export const ERROR = 1;
export const WARNING = 2;

export interface Position {
  line: number;
  character: number;
}

export interface Diagnostic {
  message: string;
  severity?: number;
  source?: string;
  range: { start: Position; end: Position };
}

export interface CompletionItem {
  label: string;
  kind?: number;
  insertText?: string;
  documentation?: string | { kind: string; value: string };
}

export interface CompletionList {
  items: CompletionItem[];
}

export interface Hover {
  contents: string | { kind: string; value: string } | (string | { language: string; value: string })[];
}

interface WorkerApi {
  doValidation(uri: string): Promise<Diagnostic[]>;
  doComplete(uri: string, position: Position): Promise<CompletionList | null>;
  doHover(uri: string, position: Position): Promise<Hover | null>;
}

interface MirrorModel {
  uri: { toString(): string };
  version: number;
  getValue(): string;
}

type WorkerFactory = (ctx: { getMirrorModels(): MirrorModel[] }, createData: Record<string, unknown>) => WorkerApi;

let factoryPromise: Promise<WorkerFactory> | undefined;

/** The worker's factory, captured once per test file (the worker module calls `initialize` once). */
function workerFactory(): Promise<WorkerFactory> {
  factoryPromise ??= (async () => {
    let captured: WorkerFactory | undefined;
    vi.doMock("monaco-worker-manager/worker", () => ({
      initialize: (factory: WorkerFactory) => {
        captured = factory;
      },
    }));
    await import("monaco-yaml/yaml.worker.js");
    if (captured === undefined) throw new Error("monaco-yaml's worker never called initialize");
    return captured;
  })();
  return factoryPromise;
}

/**
 * What monaco-yaml's worker is started with for `options`: monaco-yaml's own
 * `configureMonacoYaml` (the real one) merging them into its defaults, read
 * back with `getOptions()`. The Monaco it is given only takes registrations;
 * the worker manager would start a worker on first use, which never comes,
 * and `dispose` stops its idle timer.
 */
async function workerCreateData(options: MonacoYamlOptions): Promise<Record<string, unknown>> {
  const { configureMonacoYaml } = await import("monaco-yaml");
  const disposable = { dispose: () => undefined };
  const register = () => disposable;
  const standIn = {
    languages: new Proxy({}, { get: () => register }),
    editor: {
      getModels: () => [],
      onDidCreateModel: register,
      onWillDisposeModel: register,
      onDidChangeModelLanguage: register,
      setModelMarkers: () => undefined,
    },
  };
  const monacoYaml = configureMonacoYaml(standIn as unknown as Parameters<typeof configureMonacoYaml>[0], options);
  try {
    return { ...monacoYaml.getOptions() };
  } finally {
    monacoYaml.dispose();
  }
}

/** Each worker's schema URI and each check's model URI, never reused in a test file (see above). */
let schemaSequence = 0;
let modelSequence = 0;

export interface SchemaWorker {
  /** Every diagnostic the worker gives for `text`: syntax (Errors) and the schema's (Warnings). */
  validate(text: string): Promise<Diagnostic[]>;
  /** The completion list at `position` (0-based line and character). */
  complete(text: string, position: Position): Promise<CompletionItem[]>;
  /** Hover's text at `position`, as markdown, or null when nothing shows. */
  hover(text: string, position: Position): Promise<string | null>;
}

/**
 * A worker matching `schema` to every model, with the options the editor gives
 * monaco-yaml for it (`monacoYamlOptions`: completion and hover on, no schema
 * request, the schema's file name kept out of hover), as monaco-yaml passes
 * them to its worker.
 */
export async function schemaWorker(schema: unknown): Promise<SchemaWorker> {
  const factory = await workerFactory();
  const models = new Map<string, MirrorModel>();
  const createData = await workerCreateData(
    monacoYamlOptions({ uri: `inmemory://schema/${++schemaSequence}/otelcol.json`, schema: schema as JSONSchema }),
  );
  const api = factory({ getMirrorModels: () => [...models.values()] }, createData);

  async function withModel<T>(text: string, check: (uri: string) => Promise<T>): Promise<T> {
    const uri = `inmemory://model/${++modelSequence}`;
    models.set(uri, { uri: { toString: () => uri }, version: 1, getValue: () => text });
    try {
      return await check(uri);
    } finally {
      models.delete(uri);
    }
  }

  return {
    validate: (text) => withModel(text, (uri) => api.doValidation(uri)),
    complete: async (text, position) => (await withModel(text, (uri) => api.doComplete(uri, position)))?.items ?? [],
    hover: async (text, position) => {
      const hover = await withModel(text, (uri) => api.doHover(uri, position));
      if (hover === null || hover === undefined) return null;
      const { contents } = hover;
      if (typeof contents === "string") return contents;
      if (Array.isArray(contents)) return contents.map((part) => (typeof part === "string" ? part : part.value)).join("\n");
      return contents.value;
    },
  };
}

/** A distribution's committed schema for `version` (`public/schemas/<distribution>/v<version>.json`), parsed. */
export function committedSchema(distribution: string, version: string): unknown {
  const file = fileURLToPath(new URL(`../../public/schemas/${distribution}/v${version}.json`, import.meta.url));
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** The worker for a distribution's committed schema for `version`. */
export function committedSchemaWorker(distribution: string, version: string): Promise<SchemaWorker> {
  return schemaWorker(committedSchema(distribution, version));
}

/** The diagnostics that are the schema's (Warnings), not the YAML's own. */
export function schemaWarnings(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === WARNING);
}

/** The 0-based position of the first `needle` in `text`, plus `offset` characters into it. */
export function positionOf(text: string, needle: string, offset = 0): Position {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`${JSON.stringify(needle)} isn't in the text`);
  const before = text.slice(0, index + offset).split("\n");
  return { line: before.length - 1, character: before[before.length - 1]!.length };
}
