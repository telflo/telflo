import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { BatchProcessorForm } from "./BatchProcessorForm.js";
import { DebugExporterForm } from "./DebugExporterForm.js";
import { FormProvider, useComponentForm } from "./form-context.js";
import { ForwardConnectorForm } from "./ForwardConnectorForm.js";
import { HealthCheckForm } from "./HealthCheckForm.js";
import { MemoryLimiterForm } from "./MemoryLimiterForm.js";
import { PprofForm } from "./PprofForm.js";
import { ZPagesForm } from "./ZPagesForm.js";
import { paletteDefaultConfig, findPaletteEntry } from "~/lib/graph/palette.js";
import { parse } from "~/lib/graph/parse.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The small forms (D9b Task 5): the debug, batch, memory_limiter,
 * forward, health_check, pprof and zpages forms over the form's fields.
 * Each field is driven as a person would (typing, clicking) and writes only
 * its key: the text changes in that key's lines only, on a text with
 * comments, an anchor and a merge, `0750`, and CRLF line endings (decision
 * 2). What they show follows decision 3. Six batch processor cases close
 * the file.
 */

const FORMS = [
  "# The small forms (D9b Task 5).",
  "receivers:",
  "  otlp:",
  "    protocols:",
  "      grpc: {}",
  "processors:",
  "  batch: # the batch",
  "    timeout: 10s # every ten seconds",
  "    send_batch_size: 0750 # octal to the collector",
  "    metadata_keys:",
  "      - tenant # the tenant",
  "    metadata_cardinality_limit: 500",
  "  memory_limiter/base: &limits",
  "    check_interval: 5s # the base's",
  "    limit_mib: 2048",
  "  memory_limiter/merged:",
  "    <<: *limits # shared limits",
  "    spike_limit_mib: 256",
  "  memory_limiter:",
  "    check_interval: 1s # often",
  "    limit_mib: 512",
  "exporters:",
  "  debug:",
  "    verbosity: detailed # loud",
  "    sampling_initial: 5",
  "connectors:",
  "  forward: {}",
  "extensions:",
  "  health_check:",
  "    endpoint: localhost:13133 # probes",
  "    path: /health",
  "    response_body:",
  "      healthy: ok # all good",
  "  pprof:",
  "    endpoint: localhost:1777 # profiles",
  "  zpages:",
  "service:",
  "  extensions: [health_check, pprof, zpages]",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      processors: [memory_limiter, batch]",
  "      exporters: [forward]",
  "    traces/2:",
  "      receivers: [forward]",
  "      processors: [memory_limiter/merged]",
  "      exporters: [debug]",
  "",
].join("\n");

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderForm(key: string, form: ReactNode, text = FORMS) {
  openText(text);
  const user = userEvent.setup();
  render(<ComponentForm nodeId={componentNamed(key).id}>{form}</ComponentForm>);
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
/** A hint line, by its whole text ("… · Default 200ms" spans elements). */
const hint = (whole: string) =>
  screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
const valueOf = (written: string, section: string, name: string) =>
  (parseYaml(written, { merge: true }) as Record<string, Record<string, unknown>>)[section]![name];

/** Replaces `field`'s text with `typed` and leaves it, as a person does. */
async function retype(user: UserEvent, name: string, typed: string) {
  await user.clear(field(name));
  if (typed !== "") await user.type(field(name), typed);
  await user.tab();
}

async function pick(user: UserEvent, name: string, option: string) {
  await user.click(screen.getByRole("combobox", { name }));
  await user.click(screen.getByRole("option", { name: option }));
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
}

interface FieldCase {
  /** What is edited, for the test's name. */
  name: string;
  key: string;
  form: ReactNode;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** The component's value after, as parsed. */
  value: unknown;
}

const CASES: FieldCase[] = [
  // batch
  {
    name: "batch Timeout (a Go duration)",
    key: "processors.batch",
    form: <BatchProcessorForm />,
    edit: (user) => retype(user, "Timeout", "1m30s"),
    from: "    timeout: 10s # every ten seconds\n",
    to: "    timeout: 1m30s # every ten seconds\n",
    value: { timeout: "1m30s", send_batch_size: 750, metadata_keys: ["tenant"], metadata_cardinality_limit: 500 },
  },
  {
    name: "batch Timeout cleared (the key goes)",
    key: "processors.batch",
    form: <BatchProcessorForm />,
    edit: (user) => retype(user, "Timeout", ""),
    from: "    timeout: 10s # every ten seconds\n",
    to: "",
    value: { send_batch_size: 750, metadata_keys: ["tenant"], metadata_cardinality_limit: 500 },
  },
  {
    name: "batch Send Batch Size (0 can be entered)",
    key: "processors.batch",
    form: <BatchProcessorForm />,
    edit: (user) => retype(user, "Send Batch Size", "0"),
    from: "    send_batch_size: 0750 # octal to the collector\n",
    to: "    send_batch_size: 0 # octal to the collector\n",
    value: { timeout: "10s", send_batch_size: 0, metadata_keys: ["tenant"], metadata_cardinality_limit: 500 },
  },
  {
    name: "batch Send Batch Max Size (added)",
    key: "processors.batch",
    form: <BatchProcessorForm />,
    edit: (user) => retype(user, "Send Batch Max Size", "8192"),
    from: "    metadata_cardinality_limit: 500\n",
    to: "    metadata_cardinality_limit: 500\n    send_batch_max_size: 8192\n",
    value: {
      timeout: "10s",
      send_batch_size: 750,
      metadata_keys: ["tenant"],
      metadata_cardinality_limit: 500,
      send_batch_max_size: 8192,
    },
  },
  {
    name: "batch Metadata Keys, a row retyped",
    key: "processors.batch",
    form: <BatchProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Metadata Batching");
      const row = screen.getByDisplayValue("tenant");
      await user.clear(row);
      await user.type(row, "tenant.id");
      await user.tab();
    },
    from: "      - tenant # the tenant\n",
    to: "      - tenant.id # the tenant\n",
    value: { timeout: "10s", send_batch_size: 750, metadata_keys: ["tenant.id"], metadata_cardinality_limit: 500 },
  },
  {
    name: "batch Metadata Keys, a row added",
    key: "processors.batch",
    form: <BatchProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Metadata Batching");
      await user.click(screen.getByRole("button", { name: "Add Metadata Key" }));
    },
    from: "      - tenant # the tenant\n",
    to: '      - tenant # the tenant\n      - ""\n',
    value: { timeout: "10s", send_batch_size: 750, metadata_keys: ["tenant", ""], metadata_cardinality_limit: 500 },
  },
  {
    name: "batch Metadata Keys, a row removed",
    key: "processors.batch",
    form: <BatchProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Metadata Batching");
      await user.click(screen.getByRole("button", { name: "Remove" }));
    },
    from: "    metadata_keys:\n      - tenant # the tenant\n",
    to: "    metadata_keys: []\n",
    value: { timeout: "10s", send_batch_size: 750, metadata_keys: [], metadata_cardinality_limit: 500 },
  },
  {
    name: "batch Metadata Cardinality Limit",
    key: "processors.batch",
    form: <BatchProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Metadata Batching");
      await retype(user, "Metadata Cardinality Limit", "${{env:LIMIT}");
    },
    from: "    metadata_cardinality_limit: 500\n",
    to: "    metadata_cardinality_limit: ${env:LIMIT}\n",
    value: {
      timeout: "10s",
      send_batch_size: 750,
      metadata_keys: ["tenant"],
      metadata_cardinality_limit: "${env:LIMIT}",
    },
  },
  // memory_limiter
  {
    name: "memory_limiter Check Interval",
    key: "processors.memory_limiter",
    form: <MemoryLimiterForm />,
    edit: (user) => retype(user, "Check Interval", "2s"),
    from: "    check_interval: 1s # often\n",
    to: "    check_interval: 2s # often\n",
    value: { check_interval: "2s", limit_mib: 512 },
  },
  {
    name: "memory_limiter Memory Limit",
    key: "processors.memory_limiter",
    form: <MemoryLimiterForm />,
    edit: (user) => retype(user, "Memory Limit", "1024"),
    from: "    limit_mib: 512\nexporters:",
    to: "    limit_mib: 1024\nexporters:",
    value: { check_interval: "1s", limit_mib: 1024 },
  },
  {
    name: "memory_limiter Spike Limit (added, 0 can be entered)",
    key: "processors.memory_limiter",
    form: <MemoryLimiterForm />,
    edit: (user) => retype(user, "Spike Limit", "0"),
    from: "    limit_mib: 512\nexporters:",
    to: "    limit_mib: 512\n    spike_limit_mib: 0\nexporters:",
    value: { check_interval: "1s", limit_mib: 512, spike_limit_mib: 0 },
  },
  // debug
  {
    name: "debug Verbosity",
    key: "exporters.debug",
    form: <DebugExporterForm />,
    edit: (user) => pick(user, "Verbosity", "Normal"),
    from: "    verbosity: detailed # loud\n",
    to: "    verbosity: normal # loud\n",
    value: { verbosity: "normal", sampling_initial: 5 },
  },
  {
    name: "debug Sampling Initial (0 can be entered)",
    key: "exporters.debug",
    form: <DebugExporterForm />,
    edit: (user) => retype(user, "Sampling Initial", "0"),
    from: "    sampling_initial: 5\n",
    to: "    sampling_initial: 0\n",
    value: { verbosity: "detailed", sampling_initial: 0 },
  },
  {
    name: "debug Sampling Thereafter (added)",
    key: "exporters.debug",
    form: <DebugExporterForm />,
    edit: (user) => retype(user, "Sampling Thereafter", "10"),
    from: "    sampling_initial: 5\n",
    to: "    sampling_initial: 5\n    sampling_thereafter: 10\n",
    value: { verbosity: "detailed", sampling_initial: 5, sampling_thereafter: 10 },
  },
  {
    name: "debug Use Internal Logger (unset shows on; unticked writes false)",
    key: "exporters.debug",
    form: <DebugExporterForm />,
    edit: async (user) => {
      const box = screen.getByRole("checkbox", { name: "Use Internal Logger" });
      expect(box).toBeChecked();
      await user.click(box);
    },
    from: "    sampling_initial: 5\n",
    to: "    sampling_initial: 5\n    use_internal_logger: false\n",
    value: { verbosity: "detailed", sampling_initial: 5, use_internal_logger: false },
  },
  // health_check
  {
    name: "health_check Endpoint",
    key: "extensions.health_check",
    form: <HealthCheckForm />,
    edit: (user) => retype(user, "Endpoint", "0.0.0.0:13133"),
    from: "    endpoint: localhost:13133 # probes\n",
    to: "    endpoint: 0.0.0.0:13133 # probes\n",
    value: { endpoint: "0.0.0.0:13133", path: "/health", response_body: { healthy: "ok" } },
  },
  {
    name: "health_check Path",
    key: "extensions.health_check",
    form: <HealthCheckForm />,
    edit: (user) => retype(user, "Path", "/"),
    from: "    path: /health\n",
    to: "    path: /\n",
    value: { endpoint: "localhost:13133", path: "/", response_body: { healthy: "ok" } },
  },
  {
    name: "health_check Healthy Response",
    key: "extensions.health_check",
    form: <HealthCheckForm />,
    edit: async (user) => {
      await openSection(user, "Response Body");
      await retype(user, "Healthy Response", "fine");
    },
    from: "      healthy: ok # all good\n",
    to: "      healthy: fine # all good\n",
    value: { endpoint: "localhost:13133", path: "/health", response_body: { healthy: "fine" } },
  },
  {
    name: "health_check Unhealthy Response (added)",
    key: "extensions.health_check",
    form: <HealthCheckForm />,
    edit: async (user) => {
      await openSection(user, "Response Body");
      await retype(user, "Unhealthy Response", "down");
    },
    from: "      healthy: ok # all good\n",
    to: "      healthy: ok # all good\n      unhealthy: down\n",
    value: { endpoint: "localhost:13133", path: "/health", response_body: { healthy: "ok", unhealthy: "down" } },
  },
  {
    name: "health_check TLS turned on (the server section)",
    key: "extensions.health_check",
    form: <HealthCheckForm />,
    edit: async (user) => {
      await openSection(user, "TLS");
      expect(screen.queryByText("HTTPS required")).toBeNull();
      await user.click(screen.getByRole("checkbox", { name: "Enable TLS for HTTP" }));
      expect(screen.getByText("HTTPS required")).toBeInTheDocument();
    },
    from: "      healthy: ok # all good\n",
    to: '      healthy: ok # all good\n    tls:\n      min_version: "1.2"\n      max_version: "1.3"\n',
    value: {
      endpoint: "localhost:13133",
      path: "/health",
      response_body: { healthy: "ok" },
      tls: { min_version: "1.2", max_version: "1.3" },
    },
  },
  // pprof, zpages
  {
    name: "pprof Endpoint",
    key: "extensions.pprof",
    form: <PprofForm />,
    edit: (user) => retype(user, "Endpoint", "0.0.0.0:1777"),
    from: "    endpoint: localhost:1777 # profiles\n",
    to: "    endpoint: 0.0.0.0:1777 # profiles\n",
    value: { endpoint: "0.0.0.0:1777" },
  },
  {
    name: "zpages Endpoint (added under an empty value)",
    key: "extensions.zpages",
    form: <ZPagesForm />,
    edit: (user) => retype(user, "Endpoint", "0.0.0.0:55679"),
    from: "  zpages:\n",
    to: "  zpages:\n    endpoint: 0.0.0.0:55679\n",
    value: { endpoint: "0.0.0.0:55679" },
  },
];

const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

describe("every field of each form writes only its key (decision 2)", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const before = crlf ? CRLF(FORMS) : FORMS;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, c.form, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      const [section, name] = c.key.split(".") as [string, string];
      expect(valueOf(text(), section, name)).toEqual(c.value);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );

  it("a merged key edited copies the merge first; the anchor and its owner don't change", async () => {
    const user = renderForm("processors.memory_limiter/merged", <MemoryLimiterForm />);
    // Merged values show as the text holds them.
    expect(field("Check Interval")).toHaveValue("5s");
    expect(field("Memory Limit")).toHaveValue("2048");

    await retype(user, "Check Interval", "10s");

    expect(valueOf(text(), "processors", "memory_limiter/merged")).toEqual({
      check_interval: "10s",
      limit_mib: 2048,
      spike_limit_mib: 256,
    });
    expect(valueOf(text(), "processors", "memory_limiter/base")).toEqual({ check_interval: "5s", limit_mib: 2048 });
    expect(text()).toContain(
      "  memory_limiter/base: &limits\n    check_interval: 5s # the base's\n    limit_mib: 2048\n",
    );
    expect(entries()).toBe(1);
  });

  it("forward writes nothing: its form is a note", () => {
    renderForm("connectors.forward", <ForwardConnectorForm />);
    expect(screen.getByText(/Routing is defined by the pipeline wiring on the canvas\./)).toHaveTextContent(
      "Emitted as an empty forward: {} block. Routing is defined by the pipeline wiring on the canvas.",
    );
    expect(document.querySelectorAll("input, textarea, button")).toHaveLength(0);
    expect(text()).toBe(FORMS);
  });

  it("each edit is one undo entry named after the component", async () => {
    const user = renderForm("exporters.debug", <DebugExporterForm />);
    await retype(user, "Sampling Initial", "7");
    expect(selectUndoDescription(builderStore())).toBe("Update Debug");
    expect(selectIsDirty(builderStore())).toBe(true);
  });
});

describe("what the small forms show (decision 3)", () => {
  it("values as the text writes them: 0750 as 0750, a duration as written", () => {
    renderForm("processors.batch", <BatchProcessorForm />);
    expect(field("Timeout")).toHaveValue("10s");
    expect(field("Send Batch Size")).toHaveValue("0750");
    expect(field("Send Batch Max Size")).toHaveValue("");
    expect(text()).toBe(FORMS);
  });

  it("unset keys show empty, with the collector's default as placeholder and hint", () => {
    const empty =
      "processors:\n  batch:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n";

    renderForm("processors.batch", <BatchProcessorForm />, empty);
    expect(field("Timeout")).toHaveValue("");
    expect(field("Timeout")).toHaveAttribute("placeholder", "200ms");
    expect(hint("Send a batch after this long, regardless of size. · Default 200ms")).toBeInTheDocument();
    expect(field("Send Batch Size")).toHaveAttribute("placeholder", "8192");
    expect(hint("Send a batch once it holds this many items. · Default 8192")).toBeInTheDocument();
    expect(field("Send Batch Max Size")).toHaveAttribute("placeholder", "0");
    expect(hint("Hard cap per batch; must be at least the batch size. · Default 0 (no limit)")).toBeInTheDocument();
  });

  it("debug's defaults: basic, 2, 1, and the internal logger on", () => {
    const empty =
      "exporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";
    renderForm("exporters.debug", <DebugExporterForm />, empty);
    const verbosity = screen.getByRole("combobox", { name: "Verbosity" });
    expect(verbosity).toHaveTextContent("Basic");
    expect(verbosity).toHaveAttribute("data-placeholder");
    expect(hint("How much of each item is printed. · Default basic")).toBeInTheDocument();
    expect(field("Sampling Initial")).toHaveAttribute("placeholder", "2");
    expect(field("Sampling Thereafter")).toHaveAttribute("placeholder", "1");
    expect(hint("After that, log every Nth message. · Default 1")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Use Internal Logger" })).toBeChecked();
    expect(screen.getByText("When off, prints directly to stdout.")).toBeInTheDocument();
  });

  it("memory_limiter: required limits, and the spike limit's default of 20%", () => {
    renderForm("processors.memory_limiter", <MemoryLimiterForm />);
    expect(screen.getByText("Check Interval").querySelector("span")).toHaveTextContent("*");
    expect(screen.getByText("Memory Limit").querySelector("span")).toHaveTextContent("*");
    expect(field("Check Interval")).toHaveAttribute("placeholder", "e.g. 1s");
    expect(field("Memory Limit")).toHaveAttribute("placeholder", "e.g. 512");
    expect(field("Spike Limit")).toHaveAttribute("placeholder", "e.g. 128");
    expect(hint("Expected max memory spike in MiB between checks. · Default 20% of limit_mib")).toBeInTheDocument();
  });

  it("health_check: localhost:13133 and / as defaults; the sections count what is set", async () => {
    const user = renderForm("extensions.health_check", <HealthCheckForm />);
    expect(hint("Address the health check HTTP server listens on. · Default localhost:13133")).toBeInTheDocument();
    expect(field("Endpoint")).toHaveAttribute("placeholder", "localhost:13133");
    expect(hint("Default /")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Response Body 1" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "TLS" })).toBeInTheDocument();

    await openSection(user, "Response Body");
    expect(screen.getByRole("textbox", { name: "Healthy Response" })).toHaveAttribute(
      "placeholder",
      'e.g. {"status": "healthy"}',
    );
    expect(screen.getByText("Body returned with HTTP 503.")).toBeInTheDocument();
  });

  it("pprof's and zpages' endpoints default to localhost, the collector's (Preflight ruling 8)", () => {
    renderForm("extensions.pprof", <PprofForm />);
    expect(field("Endpoint")).toHaveAttribute("placeholder", "localhost:1777");
    expect(hint("Address the pprof HTTP server listens on. · Default localhost:1777")).toBeInTheDocument();
  });

  it("zpages' endpoint defaults to localhost:55679", () => {
    renderForm("extensions.zpages", <ZPagesForm />);
    expect(field("Endpoint")).toHaveValue("");
    expect(field("Endpoint")).toHaveAttribute("placeholder", "localhost:55679");
    expect(hint("Address the zPages HTTP server listens on. · Default localhost:55679")).toBeInTheDocument();
  });
});

describe("BatchProcessorForm cases", () => {
  /** The palette's batch, as a text. */
  function paletteBatchText(): string {
    const config = paletteDefaultConfig(findPaletteEntry("processor", "batch")!) as Record<string, unknown>;
    const lines = Object.entries(config).map(
      ([k, v]) => `    ${k}: ${Array.isArray(v) ? "[]" : typeof v === "string" ? `'${v}'` : String(v)}`,
    );
    return [
      "processors:",
      "  batch:",
      ...lines,
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      processors: [batch]",
      "",
    ].join("\n");
  }

  it("renders default config values in the form fields", () => {
    renderForm("processors.batch", <BatchProcessorForm />, paletteBatchText());
    expect(field("Timeout")).toHaveValue("200ms");
    expect(field("Send Batch Size")).toHaveValue("8192");
    expect(field("Send Batch Max Size")).toHaveValue("0");
  });

  it("renders custom config values", () => {
    const custom =
      "processors:\n  batch:\n    timeout: 500ms\n    send_batch_size: 4096\n    send_batch_max_size: 8192\n    metadata_keys: []\n    metadata_cardinality_limit: 500\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n";
    renderForm("processors.batch", <BatchProcessorForm />, custom);
    expect(field("Timeout")).toHaveValue("500ms");
    expect(field("Send Batch Size")).toHaveValue("4096");
    expect(field("Send Batch Max Size")).toHaveValue("8192");
  });

  it("shows the zero timeout warning when timeout is 0, and it goes when the timeout does", async () => {
    const user = renderForm("processors.batch", <BatchProcessorForm />);
    expect(screen.queryByText("Zero timeout")).toBeNull();

    await retype(user, "Timeout", "0s");
    expect(screen.getByText("Zero timeout")).toBeInTheDocument();
    expect(screen.getByText(/Batches are sent only when/)).toHaveTextContent(
      "Batches are sent only when send_batch_size is reached.",
    );

    await retype(user, "Timeout", "0");
    expect(screen.getByText("Zero timeout")).toBeInTheDocument();
    await retype(user, "Timeout", "1s");
    expect(screen.queryByText("Zero timeout")).toBeNull();
  });

  it("shows the max size conflict warning, quoting the sizes as written", async () => {
    const user = renderForm("processors.batch", <BatchProcessorForm />);
    await retype(user, "Send Batch Size", "8192");
    expect(screen.queryByText("Size conflict")).toBeNull();

    await retype(user, "Send Batch Max Size", "100");
    expect(screen.getByText("Size conflict")).toBeInTheDocument();
    expect(screen.getByText("Size conflict").nextElementSibling).toHaveTextContent(
      "send_batch_max_size (100) must be at least send_batch_size (8192).",
    );

    // 0 is no limit, not a conflict.
    await retype(user, "Send Batch Max Size", "0");
    expect(screen.queryByText("Size conflict")).toBeNull();
  });

  it("generates valid YAML: a field's edit changes only its line, and the text parses to the value", async () => {
    const before = paletteBatchText();
    const user = renderForm("processors.batch", <BatchProcessorForm />, before);

    await retype(user, "Send Batch Size", "4096");

    expect(text()).toBe(before.replace("    send_batch_size: 8192\n", "    send_batch_size: 4096\n"));
    expect(parse(text()).ok).toBe(true);
    expect(valueOf(text(), "processors", "batch")).toEqual({
      timeout: "200ms",
      send_batch_size: 4096,
      send_batch_max_size: 0,
      metadata_keys: [],
      metadata_cardinality_limit: 1000,
    });
  });

  it("survives a round trip: the written text, read again, shows the same values", async () => {
    const user = renderForm("processors.batch", <BatchProcessorForm />, paletteBatchText());
    await retype(user, "Timeout", "1m30s");
    const written = text();

    // Reopened from the written text, as a load does.
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm("processors.batch", <BatchProcessorForm />, written);

    expect(field("Timeout")).toHaveValue("1m30s");
    expect(field("Send Batch Size")).toHaveValue("8192");
    expect(text()).toBe(written);
  });
});

describe("privacy (decision 10)", () => {
  it("puts no config value in any attribute of the seven forms, their sections opened", async () => {
    const MARK = "zq-mark";
    const marked = [
      "processors:",
      "  batch:",
      `    timeout: ${MARK}-timeout`,
      `    send_batch_size: ${MARK}-size`,
      `    metadata_keys: [${MARK}-key]`,
      `    metadata_cardinality_limit: ${MARK}-limit`,
      "  memory_limiter:",
      `    check_interval: ${MARK}-interval`,
      `    limit_mib: ${MARK}-mib`,
      "exporters:",
      "  debug:",
      `    verbosity: ${MARK}-verbosity`,
      `    sampling_initial: ${MARK}-initial`,
      "connectors:",
      "  forward: {}",
      "extensions:",
      "  health_check:",
      `    endpoint: ${MARK}-endpoint`,
      "    response_body:",
      `      healthy: ${MARK}-healthy`,
      "    tls:",
      `      cert_file: ${MARK}-cert`,
      "  pprof:",
      `    endpoint: ${MARK}-pprof`,
      "  zpages:",
      `    endpoint: ${MARK}-zpages`,
      "service:",
      "  extensions: [health_check, pprof, zpages]",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      processors: [memory_limiter, batch]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    const forms: [string, ReactNode][] = [
      ["processors.batch", <BatchProcessorForm key="batch" />],
      ["processors.memory_limiter", <MemoryLimiterForm key="memory_limiter" />],
      ["exporters.debug", <DebugExporterForm key="debug" />],
      ["extensions.health_check", <HealthCheckForm key="health_check" />],
      ["extensions.pprof", <PprofForm key="pprof" />],
      ["extensions.zpages", <ZPagesForm key="zpages" />],
    ];
    const leaks: string[] = [];
    for (const [key, form] of forms) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, form, marked);
      for (const button of screen.queryAllByRole("button", { expanded: false })) {
        if (!button.hasAttribute("role")) await user.click(button);
      }
      if (key === "exporters.debug") await user.click(screen.getByRole("combobox", { name: "Verbosity" }));
      expect(
        document.body.textContent +
          [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join(),
      ).toContain(MARK);
      for (const element of document.querySelectorAll("*")) {
        // A controlled field's value property is its content, not an attribute: the replay masks inputs.
        for (const attribute of element.attributes) {
          if (attribute.name !== "value" && attribute.value.includes(MARK)) {
            leaks.push(`${key}: ${element.tagName}[${attribute.name}]`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(text()).toBe(marked);
  });
});
