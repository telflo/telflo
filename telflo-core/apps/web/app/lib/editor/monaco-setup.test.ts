/**
 * initMonaco and setMonacoSchema, with monaco-editor, monaco-yaml, the
 * React wrapper's loader and `fetch` replaced by fakes: the real Monaco
 * needs a canvas and workers jsdom doesn't provide. The browser tests cover
 * the real one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { monacoYamlOptions } from "./collector-schema.js";

/** monaco-yaml's handle, as configureMonacoYaml returns it: `update` restarts its worker. */
function fakeMonacoYaml() {
  return { update: vi.fn((_options: unknown) => Promise.resolve(undefined)), dispose: vi.fn(), getOptions: vi.fn() };
}

const fake = vi.hoisted(() => ({
  configureMonacoYaml: vi.fn(),
  loaderConfig: vi.fn(),
  /** JSON's mode configuration, as Monaco's `json.jsonDefaults` takes it. */
  setModeConfiguration: vi.fn(),
  /** What Monaco's import waits on: at once, unless a test holds Monaco loading. */
  monacoLoaded: () => Promise.resolve(),
}));

/** Monaco's module, once `fake.monacoLoaded` lets it load. */
async function fakeMonacoEditor() {
  await fake.monacoLoaded();
  return { editor: {}, createWebWorker: vi.fn(), json: { jsonDefaults: { setModeConfiguration: fake.setModeConfiguration } } };
}

vi.mock("monaco-editor", fakeMonacoEditor);
vi.mock("monaco-yaml", () => ({ configureMonacoYaml: fake.configureMonacoYaml }));
vi.mock("@monaco-editor/react", () => ({ loader: { config: fake.loaderConfig } }));

let monacoYaml = fakeMonacoYaml();
const fetchMock = vi.fn<(url: URL | string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.resetModules();
  monacoYaml = fakeMonacoYaml();
  fake.configureMonacoYaml.mockReset();
  fake.configureMonacoYaml.mockImplementation(() => monacoYaml);
  fake.loaderConfig.mockReset();
  fake.setModeConfiguration.mockReset();
  fake.monacoLoaded = () => Promise.resolve();
  // vi.resetModules doesn't run vi.mock's factory again: registered afresh,
  // each test's first import of Monaco waits on its own monacoLoaded.
  vi.doMock("monaco-editor", fakeMonacoEditor);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.reject(new Error("no answer set for this request")));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // Whatever a test did, nothing was requested from another origin.
  for (const [url] of fetchMock.mock.calls) {
    expect(new URL(String(url)).origin).toBe(window.location.origin);
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A fresh copy of the module, so each test starts with nothing loaded. */
async function freshInitMonaco() {
  return (await import("./monaco-setup.js")).initMonaco;
}

describe("initMonaco", () => {
  it("loads once, however often it is called", async () => {
    const initMonaco = await freshInitMonaco();

    await Promise.all([initMonaco(), initMonaco()]);
    await initMonaco();

    expect(fake.loaderConfig).toHaveBeenCalledTimes(1);
    expect(fake.configureMonacoYaml).toHaveBeenCalledTimes(1);
  });

  it("rejects when loading fails, and the next call loads again rather than failing forever", async () => {
    const initMonaco = await freshInitMonaco();
    fake.configureMonacoYaml.mockImplementationOnce(() => {
      throw new Error("monaco-yaml failed");
    });

    await expect(initMonaco()).rejects.toThrow("monaco-yaml failed");
    await expect(initMonaco()).resolves.toBeUndefined();

    expect(fake.configureMonacoYaml).toHaveBeenCalledTimes(2);
    // Loaded now: a third call reuses it.
    await initMonaco();
    expect(fake.configureMonacoYaml).toHaveBeenCalledTimes(2);
  });
});

describe("initMonaco's JSON mode", () => {
  it("switches every JSON language feature off but the tokens, once, before the React wrapper can mount an editor", async () => {
    const initMonaco = await freshInitMonaco();
    const order: string[] = [];
    fake.setModeConfiguration.mockImplementation(() => order.push("json mode"));
    fake.loaderConfig.mockImplementation(() => order.push("loader.config"));

    await Promise.all([initMonaco(), initMonaco()]);

    expect(fake.setModeConfiguration).toHaveBeenCalledOnce();
    expect(fake.setModeConfiguration).toHaveBeenCalledWith({
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
    });
    // No editor (so no JSON model) mounts before loader.config, and this comes first.
    expect(order).toEqual(["json mode", "loader.config"]);
  });
});

describe("withPre055WebWorkers (the Monaco monaco-yaml gets)", () => {
  /** Monaco's two createWebWorker functions, each answering which it is. */
  function fakeMonaco() {
    const editorCreateWebWorker = vi.fn((_options: unknown) => "the editor namespace's (0.55's form)");
    const topLevelCreateWebWorker = vi.fn((_options: unknown) => "the top-level one (the form before 0.55)");
    const monaco = {
      createWebWorker: topLevelCreateWebWorker,
      editor: { createWebWorker: editorCreateWebWorker, setTheme: vi.fn() },
      languages: { register: vi.fn() },
    };
    return { monaco, editorCreateWebWorker, topLevelCreateWebWorker };
  }

  async function wrap(monaco: ReturnType<typeof fakeMonaco>["monaco"]) {
    const { withPre055WebWorkers } = await import("./monaco-setup.js");
    return withPre055WebWorkers(monaco as never) as unknown as typeof monaco;
  }

  it("sends a call in the old form (moduleId, label, createData) to the top-level createWebWorker", async () => {
    const { monaco, editorCreateWebWorker, topLevelCreateWebWorker } = fakeMonaco();
    const wrapped = await wrap(monaco);
    const options = { moduleId: "vs/language/yaml/yamlWorker", label: "yaml", createData: { validate: true } };

    expect(wrapped.editor.createWebWorker(options as never)).toBe("the top-level one (the form before 0.55)");

    expect(topLevelCreateWebWorker).toHaveBeenCalledWith(options);
    expect(editorCreateWebWorker).not.toHaveBeenCalled();
  });

  it("sends a call in 0.55's form (a worker) to the editor namespace's own createWebWorker", async () => {
    const { monaco, editorCreateWebWorker, topLevelCreateWebWorker } = fakeMonaco();
    const wrapped = await wrap(monaco);
    const options = { worker: { postMessage: vi.fn() }, keepIdleModels: true };

    expect(wrapped.editor.createWebWorker(options as never)).toBe("the editor namespace's (0.55's form)");

    expect(editorCreateWebWorker).toHaveBeenCalledWith(options);
    expect(topLevelCreateWebWorker).not.toHaveBeenCalled();
  });

  it("leaves the rest of Monaco, and Monaco itself, as they were", async () => {
    const { monaco, editorCreateWebWorker } = fakeMonaco();
    const wrapped = await wrap(monaco);

    expect(wrapped.editor.setTheme).toBe(monaco.editor.setTheme);
    expect(wrapped.languages).toBe(monaco.languages);
    expect(wrapped.createWebWorker).toBe(monaco.createWebWorker);
    expect(monaco.editor.createWebWorker).toBe(editorCreateWebWorker);
  });

  it("is what initMonaco gives monaco-yaml", async () => {
    const monacoEditor = await import("monaco-editor");
    const initMonaco = await freshInitMonaco();

    await initMonaco();

    const given = fake.configureMonacoYaml.mock.calls[0]![0] as typeof monacoEditor;
    given.editor.createWebWorker({ moduleId: "vs/language/yaml/yamlWorker", label: "yaml" } as never);
    expect(monacoEditor.createWebWorker).toHaveBeenCalledWith({ moduleId: "vs/language/yaml/yamlWorker", label: "yaml" });
  });
});

// ── The pin's schema ──

const A = "/schemas/otelcol-contrib/v0.161.0.json";
const B = "/schemas/otelcol-contrib/v0.162.0.json";
const SCHEMA_A = { $comment: "A", properties: { receivers: { type: "object" } } };
const SCHEMA_B = { $comment: "B", properties: { exporters: { type: "object" } } };

/** What `fetch` resolves to for a JSON file. */
function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

/** The options for `path`'s schema, as the editor builds them. */
function optionsFor(path: string, schema: object) {
  return monacoYamlOptions({ uri: `${window.location.origin}${path}`, schema });
}

const SYNTAX_ONLY = monacoYamlOptions(null);

/** The paths `fetch` was asked for, in order. */
function fetchedPaths(): string[] {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
}

/** Each path's answer, by default its file. */
function answer(files: Record<string, unknown>) {
  fetchMock.mockImplementation((url) => {
    const path = new URL(String(url)).pathname;
    return Object.hasOwn(files, path) ? Promise.resolve(jsonResponse(files[path])) : Promise.reject(new Error(`no file at ${path}`));
  });
}

/** A request whose answer the test gives later. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => (resolve = done));
  return { promise, resolve };
}

/** Lets every pending promise settle (the fakes answer within microtasks). */
async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function freshModule() {
  return import("./monaco-setup.js");
}

/** A request that never answers, until its signal aborts it, as the browser's fetch does. */
function hanging(_url: URL | string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

/** Holds Monaco's import until `release`, so a test can act while it loads. */
function holdMonaco() {
  let release!: () => void;
  const loaded = new Promise<void>((done) => (release = done));
  fake.monacoLoaded = () => loaded;
  return { release };
}

/** The signal the latest request was made with. */
function lastSignal(): AbortSignal {
  return fetchMock.mock.calls.at(-1)![1]!.signal!;
}

describe("initMonaco and the pin's schema", () => {
  it("never waits for the schema: configures syntax only while it is on its way, then updates when it arrives", async () => {
    const request = deferred();
    fetchMock.mockImplementation(() => request.promise);
    const { initMonaco, setMonacoSchema } = await freshModule();

    setMonacoSchema(A);
    const loading = initMonaco();
    // Configured with the request unanswered (waiting on it, this fails here, not by timing out).
    await vi.waitFor(() => expect(fake.configureMonacoYaml).toHaveBeenCalledTimes(1));
    await loading;

    expect(fake.configureMonacoYaml.mock.calls[0]![1]).toEqual(SYNTAX_ONLY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(new URL(A, window.location.origin), expect.objectContaining({ redirect: "error" }));

    request.resolve(jsonResponse(SCHEMA_A));
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    expect(monacoYaml.update).toHaveBeenLastCalledWith(optionsFor(A, SCHEMA_A));
    // One fetch: the update reused the one initMonaco started.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves while the schema's request hangs, so the editor never stays loading because of it", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hanging);
    const { initMonaco, setMonacoSchema } = await freshModule();

    setMonacoSchema(A);

    let resolved = false;
    void initMonaco().then(() => (resolved = true));
    // Well inside the hang guard: polled for about a second of fake time.
    await vi.waitFor(() => expect(resolved).toBe(true));
    expect(fake.configureMonacoYaml.mock.calls[0]![1]).toEqual(SYNTAX_ONLY);
    expect(lastSignal().aborted).toBe(false);
  });

  it("configures with the schema when it has already arrived: no update, so the worker starts once", async () => {
    answer({ [A]: SCHEMA_A });
    const { initMonaco, setMonacoSchema } = await freshModule();
    setMonacoSchema(A);
    // A first load fails after the schema's fetch began; "Try again" loads again.
    fake.configureMonacoYaml.mockImplementationOnce(() => {
      throw new Error("monaco-yaml failed");
    });
    await expect(initMonaco()).rejects.toThrow("monaco-yaml failed");
    await settle();

    await initMonaco();
    await settle();

    expect(fake.configureMonacoYaml).toHaveBeenCalledTimes(2);
    expect(fake.configureMonacoYaml.mock.calls[1]![1]).toEqual(optionsFor(A, SCHEMA_A));
    expect(monacoYaml.update).not.toHaveBeenCalled();
    expect(fetchedPaths()).toEqual([A]);
  });

  it("configures syntax only when no schema was asked for, fetching nothing", async () => {
    const { initMonaco } = await freshModule();

    await initMonaco();

    expect(fake.configureMonacoYaml.mock.calls[0]![1]).toEqual(SYNTAX_ONLY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("configures syntax only when the schema can't be had, asks once more when Monaco is ready, and the next mount asks again", async () => {
    const monaco = holdMonaco();
    const { initMonaco, setMonacoSchema } = await freshModule();
    setMonacoSchema(A);

    const loading = initMonaco();
    // A's request fails while Monaco loads.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    monaco.release();
    await loading;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await settle();
    expect(fake.configureMonacoYaml.mock.calls[0]![1]).toEqual(SYNTAX_ONLY);
    expect(monacoYaml.update).not.toHaveBeenCalled();

    answer({ [A]: SCHEMA_A });
    // The editor mounting again asks for its pin's schema again.
    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    expect(monacoYaml.update).toHaveBeenCalledWith(optionsFor(A, SCHEMA_A));
    expect(fetchedPaths()).toEqual([A, A, A]);
  });

  it("asks again for a pin bounced A → B → A while Monaco loaded, after A's first request failed (Rulings T3-b and F-2)", async () => {
    vi.useFakeTimers();
    const monaco = holdMonaco();
    const { initMonaco, setMonacoSchema } = await freshModule();
    setMonacoSchema(A);

    const loading = initMonaco();
    // A's first request fails before Monaco is ready…
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    // …and the pin moves to B and back while it is still loading: each asked for at once.
    answer({ [A]: SCHEMA_A, [B]: SCHEMA_B });
    setMonacoSchema(B);
    setMonacoSchema(A);
    expect(fetchedPaths()).toEqual([A, B, A]);
    await settle();
    monaco.release();
    await loading;
    await settle();

    // A's schema arrived while Monaco loaded: configured with it, no update.
    expect(fake.configureMonacoYaml).toHaveBeenCalledTimes(1);
    expect(fake.configureMonacoYaml.mock.calls[0]![1]).toEqual(optionsFor(A, SCHEMA_A));
    expect(monacoYaml.update).not.toHaveBeenCalled();
    expect(fetchedPaths()).toEqual([A, B, A]);
  });

  it("starts the fetch for a pin changed while Monaco loads at once, before Monaco is ready, touching nothing of Monaco's", async () => {
    vi.useFakeTimers();
    const requests = { [A]: deferred(), [B]: deferred() };
    fetchMock.mockImplementation((url) => requests[new URL(String(url)).pathname as typeof A]!.promise);
    const monaco = holdMonaco();
    const { initMonaco, setMonacoSchema } = await freshModule();

    // Before initMonaco, a pin is only recorded.
    setMonacoSchema(A);
    expect(fetchMock).not.toHaveBeenCalled();
    const loading = initMonaco();
    expect(fetchedPaths()).toEqual([A]);

    setMonacoSchema(B);
    // B asked for at once, with Monaco still loading: nothing configured, no worker.
    expect(fetchedPaths()).toEqual([A, B]);
    await settle();
    expect(fake.loaderConfig).not.toHaveBeenCalled();
    expect(fake.configureMonacoYaml).not.toHaveBeenCalled();
    // Back to null: nothing more is requested.
    setMonacoSchema(null);
    setMonacoSchema(B);
    expect(fetchedPaths()).toEqual([A, B]);

    requests[B].resolve(jsonResponse(SCHEMA_B));
    await settle();
    monaco.release();
    await loading;
    await settle();

    // B's schema arrived while Monaco loaded: configured with it, no update; A's answer never applied.
    expect(fake.configureMonacoYaml.mock.calls[0]![1]).toEqual(optionsFor(B, SCHEMA_B));
    requests[A].resolve(jsonResponse(SCHEMA_A));
    await settle();
    expect(monacoYaml.update).not.toHaveBeenCalled();
    expect(fetchedPaths()).toEqual([A, B]);
  });

  it("clears the hang guard's timer once the schema answers", async () => {
    vi.useFakeTimers();
    answer({ [A]: SCHEMA_A });
    const monaco = holdMonaco();
    const { initMonaco, setMonacoSchema } = await freshModule();
    setMonacoSchema(A);

    const loading = initMonaco();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    monaco.release();
    await loading;

    // The schema answered while Monaco loaded, and was configured.
    expect(fake.configureMonacoYaml.mock.calls[0]![1]).toEqual(optionsFor(A, SCHEMA_A));
    expect(fetchedPaths()).toEqual([A]);
    // No guard left to fire 15 s later: the fast answer cleared it.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up a request that hangs after the guard, and the next mount asks again", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hanging);
    const { initMonaco, setMonacoSchema, SCHEMA_FETCH_TIMEOUT_MS } = await freshModule();
    setMonacoSchema(A);
    await initMonaco();

    await vi.advanceTimersByTimeAsync(SCHEMA_FETCH_TIMEOUT_MS - 1);
    expect(lastSignal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastSignal().aborted).toBe(true);
    await settle();
    expect(monacoYaml.update).not.toHaveBeenCalled();

    answer({ [A]: SCHEMA_A });
    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    expect(monacoYaml.update).toHaveBeenLastCalledWith(optionsFor(A, SCHEMA_A));
    expect(fetchedPaths()).toEqual([A, A]);
  });

  it("never applies the first pin's schema once the pin changed while Monaco loaded", async () => {
    const requests = { [A]: deferred(), [B]: deferred() };
    fetchMock.mockImplementation((url) => requests[new URL(String(url)).pathname as typeof A]!.promise);
    const { initMonaco, setMonacoSchema } = await freshModule();

    setMonacoSchema(A);
    const loading = initMonaco();
    setMonacoSchema(B);
    await loading;

    expect(fake.configureMonacoYaml.mock.calls[0]![1]).toEqual(SYNTAX_ONLY);
    requests[B].resolve(jsonResponse(SCHEMA_B));
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    expect(monacoYaml.update).toHaveBeenLastCalledWith(optionsFor(B, SCHEMA_B));

    requests[A].resolve(jsonResponse(SCHEMA_A));
    await settle();
    expect(monacoYaml.update.mock.calls).toEqual([[optionsFor(B, SCHEMA_B)]]);
    expect(fetchedPaths()).toEqual([A, B]);
  });

  it("never applies the schema initMonaco began fetching once the pin moved on after Monaco loaded", async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockImplementation((url) => (new URL(String(url)).pathname === A ? first.promise : second.promise));
    const { initMonaco, setMonacoSchema } = await freshModule();
    setMonacoSchema(A);
    await initMonaco();

    setMonacoSchema(B);
    second.resolve(jsonResponse(SCHEMA_B));
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    first.resolve(jsonResponse(SCHEMA_A));
    await settle();

    expect(monacoYaml.update.mock.calls).toEqual([[optionsFor(B, SCHEMA_B)]]);
  });
});

describe("setMonacoSchema", () => {
  /** A loaded Monaco with syntax only, and the module's setMonacoSchema. */
  async function loaded() {
    const { initMonaco, setMonacoSchema } = await freshModule();
    await initMonaco();
    return setMonacoSchema;
  }

  it("switches the schema with the editor mounted: monaco-yaml's update, never a second configure", async () => {
    answer({ [A]: SCHEMA_A, [B]: SCHEMA_B });
    const setMonacoSchema = await loaded();

    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    expect(monacoYaml.update).toHaveBeenLastCalledWith(optionsFor(A, SCHEMA_A));

    // B not fetched yet: syntax only at once, then B's schema.
    setMonacoSchema(B);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(3));
    expect(monacoYaml.update).toHaveBeenLastCalledWith(optionsFor(B, SCHEMA_B));

    // A retired or null pin: syntax only.
    setMonacoSchema(null);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(4));
    expect(monacoYaml.update.mock.calls).toEqual([[optionsFor(A, SCHEMA_A)], [SYNTAX_ONLY], [optionsFor(B, SCHEMA_B)], [SYNTAX_ONLY]]);

    expect(fake.configureMonacoYaml).toHaveBeenCalledTimes(1);
    expect(fake.loaderConfig).toHaveBeenCalledTimes(1);
  });

  it("calls update only when the schema changes: each update restarts the worker", async () => {
    answer({ [A]: SCHEMA_A });
    const setMonacoSchema = await loaded();

    // Syntax only already.
    setMonacoSchema(null);
    await settle();
    expect(monacoYaml.update).not.toHaveBeenCalled();

    setMonacoSchema(A);
    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    setMonacoSchema(A);
    await settle();

    expect(monacoYaml.update).toHaveBeenCalledTimes(1);
    expect(fetchedPaths()).toEqual([A]);
  });

  it("drops a stale answer: A asked for, then B, A answering late ends on B", async () => {
    const requests = { [A]: deferred(), [B]: deferred() };
    fetchMock.mockImplementation((url) => requests[new URL(String(url)).pathname as typeof A]!.promise);
    const setMonacoSchema = await loaded();

    setMonacoSchema(A);
    setMonacoSchema(B);
    requests[B].resolve(jsonResponse(SCHEMA_B));
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    requests[A].resolve(jsonResponse(SCHEMA_A));
    await settle();

    expect(monacoYaml.update.mock.calls).toEqual([[optionsFor(B, SCHEMA_B)]]);
  });

  it("drops a stale answer that comes first: A answering before B is never applied", async () => {
    const requests = { [A]: deferred(), [B]: deferred() };
    fetchMock.mockImplementation((url) => requests[new URL(String(url)).pathname as typeof A]!.promise);
    const setMonacoSchema = await loaded();

    setMonacoSchema(A);
    setMonacoSchema(B);
    requests[A].resolve(jsonResponse(SCHEMA_A));
    await settle();
    expect(monacoYaml.update).not.toHaveBeenCalled();
    requests[B].resolve(jsonResponse(SCHEMA_B));

    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    expect(monacoYaml.update).toHaveBeenLastCalledWith(optionsFor(B, SCHEMA_B));
  });

  it("a pin switched back while its successor loads goes straight back to its kept schema, and drops the successor's answer", async () => {
    const later = deferred();
    fetchMock.mockImplementation((url) =>
      new URL(String(url)).pathname === A ? Promise.resolve(jsonResponse(SCHEMA_A)) : later.promise,
    );
    const setMonacoSchema = await loaded();
    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));

    setMonacoSchema(B);
    setMonacoSchema(A);
    later.resolve(jsonResponse(SCHEMA_B));
    await settle();

    expect(monacoYaml.update.mock.calls).toEqual([[optionsFor(A, SCHEMA_A)], [SYNTAX_ONLY], [optionsFor(A, SCHEMA_A)]]);
  });

  describe("a pin change switches at once", () => {
    it("picking a pin whose schema isn't fetched yet gives syntax only at once, never the previous pin's, then its schema when it arrives", async () => {
      vi.useFakeTimers();
      const later = deferred();
      fetchMock.mockImplementation((url) =>
        new URL(String(url)).pathname === A ? Promise.resolve(jsonResponse(SCHEMA_A)) : later.promise,
      );
      const setMonacoSchema = await loaded();
      setMonacoSchema(A);
      await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));

      setMonacoSchema(B);
      // In the same turn: no wait on B's file.
      expect(monacoYaml.update).toHaveBeenCalledTimes(2);
      expect(monacoYaml.update).toHaveBeenLastCalledWith(SYNTAX_ONLY);
      // However long B's file takes (inside the hang guard), syntax only meanwhile.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(monacoYaml.update).toHaveBeenCalledTimes(2);

      later.resolve(jsonResponse(SCHEMA_B));
      await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(3));
      expect(monacoYaml.update.mock.calls).toEqual([[optionsFor(A, SCHEMA_A)], [SYNTAX_ONLY], [optionsFor(B, SCHEMA_B)]]);
      expect(fetchedPaths()).toEqual([A, B]);
    });

    it("picking a pin whose schema is already fetched switches to it directly, in one update", async () => {
      vi.useFakeTimers();
      answer({ [A]: SCHEMA_A, [B]: SCHEMA_B });
      const setMonacoSchema = await loaded();
      setMonacoSchema(A);
      await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
      setMonacoSchema(B);
      await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(3));
      monacoYaml.update.mockClear();

      setMonacoSchema(A);
      // In the same turn, and only once: no syntax-only step between.
      expect(monacoYaml.update.mock.calls).toEqual([[optionsFor(A, SCHEMA_A)]]);
      await settle();
      expect(monacoYaml.update.mock.calls).toEqual([[optionsFor(A, SCHEMA_A)]]);
      expect(fetchedPaths()).toEqual([A, B]);
    });

    it("never applies a late answer for a pin that was changed again meanwhile", async () => {
      vi.useFakeTimers();
      const later = deferred();
      fetchMock.mockImplementation((url) =>
        new URL(String(url)).pathname === A ? Promise.resolve(jsonResponse(SCHEMA_A)) : later.promise,
      );
      const setMonacoSchema = await loaded();
      setMonacoSchema(A);
      await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));

      setMonacoSchema(B);
      // A retired pin picked while B's file is on its way: syntax only already, no update.
      setMonacoSchema(null);
      later.resolve(jsonResponse(SCHEMA_B));
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(monacoYaml.update.mock.calls).toEqual([[optionsFor(A, SCHEMA_A)], [SYNTAX_ONLY]]);
    });
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["an error status", () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response)],
    ["an answer that isn't JSON", () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token <")) } as Response)],
    ["JSON that isn't an object", () => Promise.resolve(jsonResponse(["not", "a", "schema"]))],
  ])("%s falls back to syntax only, silently, and the next change asks again", async (_name, failure) => {
    answer({ [A]: SCHEMA_A });
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const setMonacoSchema = await loaded();
    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));

    fetchMock.mockImplementationOnce(failure);
    setMonacoSchema(B);
    // A's schema would be the wrong version's: syntax only, at once, and after the failure.
    expect(monacoYaml.update).toHaveBeenCalledTimes(2);
    expect(monacoYaml.update).toHaveBeenLastCalledWith(SYNTAX_ONLY);
    await settle();
    expect(monacoYaml.update).toHaveBeenCalledTimes(2);

    answer({ [A]: SCHEMA_A, [B]: SCHEMA_B });
    setMonacoSchema(B);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(3));
    expect(monacoYaml.update).toHaveBeenLastCalledWith(optionsFor(B, SCHEMA_B));
    expect(fetchedPaths()).toEqual([A, B, B]);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("calls no update for a failed fetch while monaco-yaml already has syntax only", async () => {
    const setMonacoSchema = await loaded();

    setMonacoSchema(A);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();

    expect(monacoYaml.update).not.toHaveBeenCalled();
  });

  it("gives up a request that hangs after the guard: syntax only, silently, and the next change asks again", async () => {
    vi.useFakeTimers();
    answer({ [B]: SCHEMA_B });
    const error = vi.spyOn(console, "error");
    const { initMonaco, setMonacoSchema, SCHEMA_FETCH_TIMEOUT_MS } = await freshModule();
    await initMonaco();
    setMonacoSchema(B);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));

    fetchMock.mockImplementationOnce(hanging);
    setMonacoSchema(A);
    // B's schema would be the wrong version's: syntax only, at once, while A's request hangs and after it is given up.
    expect(monacoYaml.update).toHaveBeenCalledTimes(2);
    expect(monacoYaml.update).toHaveBeenLastCalledWith(SYNTAX_ONLY);
    await vi.advanceTimersByTimeAsync(SCHEMA_FETCH_TIMEOUT_MS - 1);
    expect(lastSignal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastSignal().aborted).toBe(true);
    await settle();
    expect(monacoYaml.update).toHaveBeenCalledTimes(2);

    answer({ [A]: SCHEMA_A, [B]: SCHEMA_B });
    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(3));
    expect(monacoYaml.update).toHaveBeenLastCalledWith(optionsFor(A, SCHEMA_A));
    expect(fetchedPaths()).toEqual([B, A, A]);
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps each fetched schema for the tab: a pin switched back reuses it", async () => {
    answer({ [A]: SCHEMA_A, [B]: SCHEMA_B });
    const setMonacoSchema = await loaded();

    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));
    setMonacoSchema(B);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(3));
    setMonacoSchema(null);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(4));
    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(5));
    await settle();

    // A kept: straight back to it, without a syntax-only step or a request.
    expect(monacoYaml.update.mock.calls.slice(3)).toEqual([[SYNTAX_ONLY], [optionsFor(A, SCHEMA_A)]]);
    expect(monacoYaml.update).toHaveBeenCalledTimes(5);
    expect(fetchedPaths()).toEqual([A, B]);
  });

  it.each([
    ["an absolute URL", "https://elsewhere.example/schemas/otelcol-contrib/v0.162.0.json"],
    ["a protocol-relative URL", "//elsewhere.example/schemas/otelcol-contrib/v0.162.0.json"],
  ])("never fetches from another origin: %s gets syntax only, and nothing is requested", async (_name, url) => {
    answer({ [A]: SCHEMA_A });
    const setMonacoSchema = await loaded();
    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));

    setMonacoSchema(url);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(2));

    expect(monacoYaml.update).toHaveBeenLastCalledWith(SYNTAX_ONLY);
    expect(fetchedPaths()).toEqual([A]);
  });

  it("refuses a redirect, so a same-origin request can't be led elsewhere, and gives the request its hang guard", async () => {
    answer({ [A]: SCHEMA_A });
    const setMonacoSchema = await loaded();

    setMonacoSchema(A);
    await vi.waitFor(() => expect(monacoYaml.update).toHaveBeenCalledTimes(1));

    expect(fetchMock.mock.calls[0]![1]).toEqual({ redirect: "error", signal: expect.any(AbortSignal) });
  });
});
