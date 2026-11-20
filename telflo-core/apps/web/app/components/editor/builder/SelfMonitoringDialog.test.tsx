import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { CanvasActions } from "./CanvasActions.js";
import { UNSHOWABLE_VALUE_MESSAGE } from "./config-forms/form-context.js";
import { ATTRIBUTE_EXISTS_MESSAGE, TEXT_CHANGED_MESSAGE } from "./SelfMonitoringDialog.js";
import { useUndoRedo } from "~/hooks/useUndoRedo.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { EDIT_SELF_MONITORING, selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The Self-monitoring dialog, opened from the canvas action as a person
 * would. Its fields read `service.telemetry` from the text (`0750`,
 * references, aliases); Apply writes only what the person changed, by key
 * path, as one entry "Edit self-monitoring"; a draft with no differences
 * writes nothing; nothing the dialog doesn't show is touched (a console
 * reader, an unknown key); readers and processors are appended and removed by
 * item; a resource attribute is renamed in place; Remove Section removes the
 * section's lines; a telemetry that isn't a mapping is read-only.
 */

const TEXT = [
  "receivers:",
  "  otlp: {}",
  "exporters:",
  "  debug: {}",
  "x-level: &level detailed",
  "service:",
  "  telemetry: # self-monitoring",
  "    metrics:",
  "      level: *level # through an alias",
  "      readers:",
  "        # the console reader",
  "        - periodic:",
  "            interval: ${env:INTERVAL}",
  "            exporter:",
  "              console: {}",
  "        - pull:",
  "            exporter:",
  "              prometheus:",
  "                host: ${env:HOST} # the host",
  "                port: 0750",
  "                without_units: true",
  "    logs:",
  "      level: info",
  "      encoding: json # structured",
  "      output_paths: [stderr, /var/log/otelcol.log]",
  "      some_future_field: {nested: 42}",
  "    resource:",
  "      service.name: my-collector # the name",
  "      service.instance.id: null",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");

const BARE = [
  "receivers:",
  "  otlp: {}",
  "exporters:",
  "  debug: {}",
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name });
/** A checkbox by its label; `index` among several with the same label (the rows' "unset"). */
const box = (name: string, index?: number) =>
  index === undefined ? screen.getByRole("checkbox", { name }) : screen.getAllByRole("checkbox", { name })[index]!;
const ACTION = "Collector self-monitoring (service::telemetry)";

type Tree = Record<string, unknown>;
/** `service.telemetry`, as the collector's YAML reads it. */
const telemetryOf = (written: string) => (parseYaml(written) as { service?: { telemetry?: Tree } }).service?.telemetry;

/** Opens `yaml`, renders the canvas actions, and opens the dialog. */
async function openDialog(yaml = TEXT): Promise<UserEvent> {
  openText(yaml);
  const user = userEvent.setup();
  render(<CanvasActions />);
  await user.click(button(ACTION));
  await screen.findByRole("dialog", { name: "Collector Self-Monitoring" });
  return user;
}

async function pick(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** Replaces `element`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, element: HTMLElement, typed: string) {
  await user.clear(element);
  if (typed !== "") await user.type(element, typed.replace(/[{[]/g, "$&$&"));
  await user.tab();
}

const openSection = (user: UserEvent, title: string) => user.click(button(title));
const apply = (user: UserEvent) => user.click(button("Apply"));

describe("the dialog shows the text", () => {
  it("has its title, description, sections and footer", async () => {
    await openDialog();
    const dialog = screen.getByRole("dialog", { name: "Collector Self-Monitoring" });
    expect(dialog).toHaveAccessibleDescription(
      "Configure service::telemetry — the metrics, logs, and traces the collector emits about itself. Fields not shown here are preserved as-is.",
    );
    expect(within(dialog).getAllByRole("button", { expanded: true }).map((b) => b.textContent)).toEqual(["Metrics"]);
    expect(within(dialog).getAllByRole("button", { expanded: false }).map((b) => b.textContent)).toEqual([
      "Logs",
      "Traces",
      "Resource Attributes",
    ]);
    expect(within(dialog).getByRole("button", { name: "Remove Section" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(dialog).toHaveAttribute("data-own-keys", "");
    expect(dialog).toHaveAttribute("data-own-history", "");
  });

  it("reads every field from the text: aliases, references and 0750 as written", async () => {
    const user = await openDialog();
    expect(byId("sm-metrics-level")).toHaveTextContent("detailed");
    expect(box("Expose Prometheus Endpoint (pull)")).toBeChecked();
    expect(byId("sm-prom-host")).toHaveValue("${env:HOST}");
    expect(byId("sm-prom-port")).toHaveValue("0750");
    // The console reader isn't an OTLP reader.
    expect(box("Push Metrics via OTLP (periodic)")).not.toBeChecked();
    expect(document.getElementById("sm-otlp-interval")).toBeNull();

    await openSection(user, "Logs");
    expect(byId("sm-logs-level")).toHaveTextContent("info");
    expect(byId("sm-logs-encoding")).toHaveTextContent("json");
    expect(byId("sm-logs-output")).toHaveValue("stderr,/var/log/otelcol.log");
    expect(box("Push Logs via OTLP")).not.toBeChecked();

    await openSection(user, "Traces");
    expect(byId("sm-traces-level")).toHaveTextContent("basic");
    expect(byId("sm-traces-level")).toHaveAttribute("data-placeholder");
    expect(byId("sm-traces-propagators")).toHaveValue("");

    await openSection(user, "Resource Attributes");
    const keys = screen.getAllByRole("textbox", { name: "Attribute key" });
    const values = screen.getAllByRole("textbox", { name: "Attribute value" });
    expect(keys.map((k) => (k as HTMLInputElement).value)).toEqual(["service.name", "service.instance.id"]);
    expect(values.map((v) => (v as HTMLInputElement).value)).toEqual(["my-collector", ""]);
    expect(values[1]).toBeDisabled();
    expect(values[1]).toHaveAttribute("placeholder", "unset");
    expect(box("unset", 0)).not.toBeChecked();
    expect(box("unset", 1)).toBeChecked();
    expect(text()).toBe(TEXT);
    expect(entries()).toBe(0);
  });

  it("shows the collector's defaults as hints and placeholders when unset", async () => {
    const user = await openDialog(`${BARE}`.replace("service:\n", "service:\n  telemetry:\n    metrics:\n      readers:\n        - pull:\n            exporter:\n              prometheus: {}\n"));
    expect(byId("sm-metrics-level")).toHaveAttribute("data-placeholder");
    expect(byId("sm-metrics-level")).toHaveTextContent("normal");
    expect(byId("sm-prom-host")).toHaveValue("");
    expect(byId("sm-prom-host")).toHaveAttribute("placeholder", "0.0.0.0");
    expect(byId("sm-prom-port")).toHaveAttribute("placeholder", "8888");
    const hint = (whole: string) =>
      screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
    expect(hint("Verbosity of the collector's own metrics; none disables them. · Default normal")).toBeInTheDocument();
    expect(hint("Default localhost")).toBeInTheDocument();
    expect(hint("Default 8888")).toBeInTheDocument();
    await openSection(user, "Logs");
    expect(hint("Default info")).toBeInTheDocument();
    expect(hint("Default console")).toBeInTheDocument();
    expect(hint("Comma-separated file paths or stderr/stdout. · Default stderr")).toBeInTheDocument();
    await openSection(user, "Traces");
    expect(hint("Internal tracing is experimental upstream; none disables it. · Default basic")).toBeInTheDocument();
  });
});

describe("Apply writes only what changed", () => {
  it("writes only the changed keys, in place, as one entry 'Edit self-monitoring', and toasts", async () => {
    const user = await openDialog();
    await retypeInto(user, byId("sm-prom-port"), "9090");
    await openSection(user, "Logs");
    await pick(user, byId("sm-logs-level"), "debug");
    expect(text()).toBe(TEXT);

    await apply(user);

    expect(text()).toBe(TEXT.replace("port: 0750", "port: 9090").replace("level: info", "level: debug"));
    expect(entries()).toBe(1);
    expect(selectUndoDescription(builderStore())).toBe(EDIT_SELF_MONITORING);
    expect(selectIsDirty(builderStore())).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("Self-monitoring updated");
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      builderStore().undo();
    });
    expect(text()).toBe(TEXT);
  });

  it("with no change writes nothing: no entry, not dirty, no toast (also a change undone in the draft)", async () => {
    const user = await openDialog();
    await apply(user);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(text()).toBe(TEXT);
    expect(entries()).toBe(0);
    expect(selectIsDirty(builderStore())).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();

    await user.click(button(ACTION));
    await retypeInto(user, byId("sm-prom-port"), "9090");
    await retypeInto(user, byId("sm-prom-port"), "0750");
    await user.click(box("Push Metrics via OTLP (periodic)"));
    await user.click(box("Push Metrics via OTLP (periodic)"));
    await apply(user);
    expect(text()).toBe(TEXT);
    expect(entries()).toBe(0);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("over a text without telemetry, a reader turned on and off again writes nothing", async () => {
    const user = await openDialog(BARE);
    expect(button("Remove Section")).toBeDisabled();
    await user.click(box("Expose Prometheus Endpoint (pull)"));
    expect(byId("sm-prom-host")).toHaveValue("0.0.0.0");
    await user.click(box("Expose Prometheus Endpoint (pull)"));
    await apply(user);
    expect(text()).toBe(BARE);
    expect(entries()).toBe(0);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("Cancel discards the draft", async () => {
    const user = await openDialog();
    await retypeInto(user, byId("sm-prom-port"), "9090");
    await user.click(button("Cancel"));
    expect(text()).toBe(TEXT);
    expect(entries()).toBe(0);

    // The next opening takes the text again.
    await user.click(button(ACTION));
    expect(byId("sm-prom-port")).toHaveValue("0750");
  });

  it("a write the store refuses keeps the dialog open with the draft, and no success toast", async () => {
    const user = await openDialog();
    await retypeInto(user, byId("sm-prom-port"), "9090");
    const { setTelemetryValues } = builderStore();
    const refuse = vi.fn(() => false);
    useEditorStore.setState({ setTelemetryValues: refuse });

    await apply(user);
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Collector Self-Monitoring" })).toBeInTheDocument();
    expect(byId("sm-prom-port")).toHaveValue("9090");
    expect(toast.success).not.toHaveBeenCalled();
    expect(text()).toBe(TEXT);

    // The draft is still there to apply once the store takes it.
    useEditorStore.setState({ setTelemetryValues });
    await apply(user);
    expect(text()).toBe(TEXT.replace("port: 0750", "port: 9090"));
    expect(toast.success).toHaveBeenCalledWith("Self-monitoring updated");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("writes what a field still holds when Apply is clicked without the field losing focus", async () => {
    await openDialog();
    const port = byId("sm-prom-port");
    port.focus();
    // Typed, still held (no blur, no pause), then Apply clicked without a mousedown's blur (Safari).
    fireEvent.change(port, { target: { value: "9090" } });
    expect(document.activeElement).toBe(port);
    fireEvent.click(button("Apply"));

    expect(text()).toBe(TEXT.replace("port: 0750", "port: 9090"));
    expect(entries()).toBe(1);
    expect(toast.success).toHaveBeenCalledWith("Self-monitoring updated");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the body stays mounted with the draft until Radix unmounts it, so a close animation added later wouldn't blank it; the next opening takes the text again", async () => {
    // A guard, not the app's behaviour: neither app has a close animation (ui/dialog's `animate-out` classes have no CSS),
    // so the dialog closes at once. Stubbed here, an exit animation makes Radix keep the closed content mounted until it ends.
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const styles = computed(element, pseudo);
      if (!(element instanceof HTMLElement) || element.getAttribute("role") !== "dialog") return styles;
      return new Proxy(styles, {
        get: (target, property) => {
          if (property === "animationName") return element.dataset.state === "closed" ? "exit" : "enter";
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    });
    const user = await openDialog();
    await retypeInto(user, byId("sm-prom-port"), "9090");
    await user.click(button("Cancel"));

    // Closed, still mounted while the stubbed animation runs: the sections and the draft still show.
    const closing = screen.getByRole("dialog", { hidden: true });
    expect(closing).toHaveAttribute("data-state", "closed");
    expect(within(closing).getByRole("button", { name: "Metrics", hidden: true })).toBeInTheDocument();
    expect(byId("sm-prom-port")).toHaveValue("9090");
    expect(text()).toBe(TEXT);

    // jsdom's events carry no animationName: the stubbed animation's end, as a browser would send it.
    const end = Object.assign(new Event("animationend", { bubbles: true }), { animationName: "exit" });
    act(() => void closing.dispatchEvent(end));
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    expect(text()).toBe(TEXT);
    expect(entries()).toBe(0);

    // Opened again, the draft is the text's.
    await user.click(button(ACTION));
    expect(byId("sm-prom-port")).toHaveValue("0750");
  });

  it("touches nothing the dialog doesn't show: the console reader and an unknown key are kept byte for byte", async () => {
    const user = await openDialog();
    await user.click(box("Push Metrics via OTLP (periodic)"));
    await openSection(user, "Logs");
    await pick(user, byId("sm-logs-encoding"), "console");
    await apply(user);

    const written = text();
    const consoleReader = TEXT.slice(TEXT.indexOf("        # the console reader"), TEXT.indexOf("        - pull:"));
    expect(written).toContain(consoleReader);
    expect(written).toContain("      some_future_field: {nested: 42}\n");
    const readers = (telemetryOf(written)!.metrics as Tree).readers as Tree[];
    expect(readers).toHaveLength(3);
    expect(readers[0]).toEqual({ periodic: { interval: "${env:INTERVAL}", exporter: { console: {} } } });
    expect(readers[2]).toEqual({
      periodic: { exporter: { otlp: { protocol: "http/protobuf", endpoint: "https://backend:4318" } } },
    });
    // Only the reader's lines were added, after the last reader, and the encoding changed.
    expect(written).toBe(
      TEXT.replace("encoding: json # structured", "encoding: console # structured").replace(
        "    logs:\n",
        [
          "        - periodic:",
          "            exporter:",
          "              otlp:",
          "                protocol: http/protobuf",
          "                endpoint: https://backend:4318",
          "    logs:",
          "",
        ].join("\n"),
      ),
    );
  });
});

describe("the lists are written by item", () => {
  it("a reader turned off removes that item's lines; turned on appends the reader", async () => {
    const user = await openDialog();
    await user.click(box("Expose Prometheus Endpoint (pull)"));
    expect(document.getElementById("sm-prom-host")).toBeNull();
    await apply(user);
    const prometheus = TEXT.slice(TEXT.indexOf("        - pull:"), TEXT.indexOf("    logs:"));
    expect(text()).toBe(TEXT.replace(prometheus, ""));

    await user.click(button(ACTION));
    await user.click(box("Expose Prometheus Endpoint (pull)"));
    await user.click(box("Push Metrics via OTLP (periodic)"));
    expect(byId("sm-otlp-metrics-endpoint")).toHaveValue("https://backend:4318");
    expect(byId("sm-otlp-metrics-protocol")).toHaveTextContent("http/protobuf");
    await retypeInto(user, byId("sm-otlp-interval"), "30000");
    await pick(user, byId("sm-otlp-temporality"), "delta");
    await apply(user);

    const written = text();
    expect(written.startsWith(TEXT.slice(0, TEXT.indexOf("        - pull:")))).toBe(true);
    expect(written.endsWith(TEXT.slice(TEXT.indexOf("    logs:")))).toBe(true);
    expect(((telemetryOf(written)!.metrics as Tree).readers as Tree[]).slice(1)).toEqual([
      { pull: { exporter: { prometheus: { host: "0.0.0.0", port: 8888 } } } },
      {
        periodic: {
          exporter: { otlp: { protocol: "http/protobuf", endpoint: "https://backend:4318", temporality_preference: "delta" } },
          interval: 30000,
        },
      },
    ]);
    expect(entries()).toBe(2);
  });

  it("turning off the only reader removes the list's key, and a mapping the dialog added goes with it", async () => {
    const yaml = BARE.replace("service:\n", "service:\n  telemetry:\n    logs:\n      level: warn # quiet\n");
    const user = await openDialog(yaml);
    await user.click(box("Expose Prometheus Endpoint (pull)"));
    await user.click(box("Push Metrics via OTLP (periodic)"));
    await user.click(box("Expose Prometheus Endpoint (pull)"));
    await user.click(box("Push Metrics via OTLP (periodic)"));
    await apply(user);
    expect(text()).toBe(yaml);
    expect(entries()).toBe(0);
  });

  it("the logs and traces OTLP processors are appended and removed by item, other processors kept", async () => {
    const yaml = BARE.replace(
      "service:\n",
      "service:\n  telemetry:\n    traces:\n      processors:\n        - simple: # keep me\n            exporter:\n              console: {}\n",
    );
    const user = await openDialog(yaml);
    await openSection(user, "Logs");
    await user.click(box("Push Logs via OTLP"));
    await retypeInto(user, byId("sm-logs-otlp-endpoint"), "https://logs:4318");
    await pick(user, byId("sm-logs-otlp-protocol"), "grpc");
    await openSection(user, "Traces");
    await user.click(box("Push Traces via OTLP"));
    await apply(user);

    const telemetry = telemetryOf(text())!;
    expect(telemetry.logs).toEqual({ processors: [{ batch: { exporter: { otlp: { protocol: "grpc", endpoint: "https://logs:4318" } } } }] });
    expect((telemetry.traces as Tree).processors).toEqual([
      { simple: { exporter: { console: {} } } },
      { batch: { exporter: { otlp: { protocol: "http/protobuf", endpoint: "https://backend:4318" } } } },
    ]);
    expect(text()).toContain("        - simple: # keep me\n            exporter:\n              console: {}\n");

    await user.click(button(ACTION));
    await openSection(user, "Traces");
    await user.click(box("Push Traces via OTLP"));
    await apply(user);
    expect((telemetryOf(text())!.traces as Tree).processors).toEqual([{ simple: { exporter: { console: {} } } }]);
  });

  it("a key typed under a mapping the text holds as null, then cleared, keeps that mapping's line and comment", async () => {
    const yaml = BARE.replace("service:\n", "service:\n  telemetry:\n    logs: # keep me\n    traces:\n      level: basic\n");
    const user = await openDialog(yaml);
    await openSection(user, "Logs");
    await retypeInto(user, byId("sm-logs-output"), "stdout");
    await retypeInto(user, byId("sm-logs-output"), "");
    await apply(user);
    // Only the emptied key goes: `logs` was in the text, so it stays, emptied (nothing else is pruned).
    expect(text()).toBe(yaml.replace("    logs: # keep me\n", "    logs: {} # keep me\n"));
  });

  it("Output Paths and Propagators write lists by item; emptied, the key goes", async () => {
    const user = await openDialog();
    await openSection(user, "Logs");
    await retypeInto(user, byId("sm-logs-output"), "stdout, /var/log/otelcol.log, /tmp/more.log");
    await openSection(user, "Traces");
    await retypeInto(user, byId("sm-traces-propagators"), "tracecontext, b3");
    await apply(user);
    expect(text()).toBe(
      TEXT.replace(
        "output_paths: [stderr, /var/log/otelcol.log]",
        "output_paths: [stdout, /var/log/otelcol.log, /tmp/more.log]",
      ).replace("  pipelines:", "    traces:\n      propagators:\n        - tracecontext\n        - b3\n  pipelines:"),
    );

    await user.click(button(ACTION));
    await openSection(user, "Logs");
    await retypeInto(user, byId("sm-logs-output"), "stdout");
    await openSection(user, "Traces");
    await retypeInto(user, byId("sm-traces-propagators"), "");
    await apply(user);
    // `traces` was in the text this time: only the emptied key goes (nothing else is pruned).
    expect(text()).toBe(
      TEXT.replace("output_paths: [stderr, /var/log/otelcol.log]", "output_paths: [stdout]").replace(
        "  pipelines:",
        "    traces: {}\n  pipelines:",
      ),
    );
  });
});

describe("resource attributes", () => {
  it("a key renamed in place keeps its comment and its place", async () => {
    const user = await openDialog();
    await openSection(user, "Resource Attributes");
    const key = screen.getAllByRole("textbox", { name: "Attribute key" })[0]!;
    await retypeInto(user, key, "service.namespace");
    await apply(user);
    expect(text()).toBe(TEXT.replace("service.name: my-collector", "service.namespace: my-collector"));
  });

  it("a key another attribute has, or an empty one, isn't a rename", async () => {
    const user = await openDialog();
    await openSection(user, "Resource Attributes");
    const key = () => screen.getAllByRole("textbox", { name: "Attribute key" })[0]!;
    await retypeInto(user, key(), "service.instance.id");
    expect(key()).toHaveValue("service.name");
    await retypeInto(user, key(), "");
    expect(key()).toHaveValue("service.name");
    await apply(user);
    expect(text()).toBe(TEXT);
  });

  it("a key another attribute has is refused with the message under the row, as text; the row shows its key", async () => {
    const user = await openDialog();
    await openSection(user, "Resource Attributes");
    const key = () => screen.getAllByRole("textbox", { name: "Attribute key" })[0]!;
    expect(screen.queryByText(ATTRIBUTE_EXISTS_MESSAGE)).toBeNull();
    await retypeInto(user, key(), "service.instance.id");
    expect(key()).toHaveValue("service.name");
    const message = screen.getByText(ATTRIBUTE_EXISTS_MESSAGE);
    expect(message.tagName).toBe("P");
    expect(screen.getAllByText(ATTRIBUTE_EXISTS_MESSAGE)).toHaveLength(1);

    // Typing again clears it; a key no other attribute has is a rename.
    await user.type(key(), "x");
    expect(screen.queryByText(ATTRIBUTE_EXISTS_MESSAGE)).toBeNull();
    await user.tab();
    expect(key()).toHaveValue("service.namex");
    await apply(user);
    expect(text()).toBe(TEXT.replace("service.name: my-collector", "service.namex: my-collector"));
  });

  it('"unset" writes null; unchecking writes "" and the row stays', async () => {
    const user = await openDialog();
    await openSection(user, "Resource Attributes");
    await user.click(box("unset", 0));
    expect(screen.getAllByRole("textbox", { name: "Attribute value" })[0]).toBeDisabled();
    await user.click(box("unset", 0));
    await user.click(box("unset", 1));
    await apply(user);

    const resource = telemetryOf(text())!.resource as Tree;
    expect(resource).toEqual({ "service.name": "", "service.instance.id": "" });
    expect(text()).toContain('      service.name: "" # the name\n');
    expect(entries()).toBe(1);
  });

  it("Add Attribute then Apply with nothing typed writes nothing: no entry, no toast", async () => {
    const user = await openDialog(BARE);
    await openSection(user, "Resource Attributes");
    await user.click(button("Add Attribute"));
    expect(screen.getAllByRole("textbox", { name: "Attribute key" })).toHaveLength(1);
    await apply(user);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(text()).toBe(BARE);
    expect(entries()).toBe(0);
    expect(selectIsDirty(builderStore())).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a row whose key is still empty is dropped at Apply, a value typed or unset included; the rest is written", async () => {
    const user = await openDialog();
    await openSection(user, "Resource Attributes");
    await user.click(button("Add Attribute"));
    await retypeInto(user, screen.getAllByRole("textbox", { name: "Attribute value" })[2]!, "orphan");
    await retypeInto(user, byId("sm-prom-port"), "9090");
    await apply(user);
    expect(text()).toBe(TEXT.replace("port: 0750", "port: 9090"));
    expect(entries()).toBe(1);

    // The last row removed and a blank one added: `resource` goes with it, as the row's × takes it.
    await user.click(button(ACTION));
    await openSection(user, "Resource Attributes");
    await user.click(screen.getAllByRole("button", { name: "×" })[1]!);
    await user.click(screen.getAllByRole("button", { name: "×" })[0]!);
    await user.click(button("Add Attribute"));
    await user.click(box("unset", 0));
    await apply(user);
    expect(telemetryOf(text())!.resource).toBeUndefined();
    expect(text()).toBe(
      TEXT.replace("port: 0750", "port: 9090").replace(
        "    resource:\n      service.name: my-collector # the name\n      service.instance.id: null\n",
        "",
      ),
    );
  });

  it("a blank row dropped at Apply keeps a resource the text had, with its comment: {} as it was, null as {}", async () => {
    const withResource = (resource: string) =>
      BARE.replace("service:\n", `service:\n  telemetry:\n    resource: ${resource}# keep me\n    logs:\n      level: info\n`);
    // `{}`: nothing written, no entry, no toast.
    let user = await openDialog(withResource("{} "));
    await openSection(user, "Resource Attributes");
    await user.click(button("Add Attribute"));
    await apply(user);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(text()).toBe(withResource("{} "));
    expect(entries()).toBe(0);
    expect(toast.success).not.toHaveBeenCalled();
    cleanup();

    // An explicit null: the line and its comment stay, emptied as `{}`.
    user = await openDialog(withResource(""));
    await openSection(user, "Resource Attributes");
    await user.click(button("Add Attribute"));
    await apply(user);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(text()).toBe(withResource("{} "));
    expect(entries()).toBe(1);
  });

  it("a held key another attribute has, at Apply, keeps the dialog open with the message: nothing written", async () => {
    const user = await openDialog();
    await openSection(user, "Resource Attributes");
    await retypeInto(user, byId("sm-prom-port"), "9090");
    await user.click(button("Add Attribute"));
    const key = screen.getAllByRole("textbox", { name: "Attribute key" })[2]!;
    key.focus();
    // Typed, still held (no blur), then Apply clicked without a mousedown's blur (Safari).
    fireEvent.change(key, { target: { value: "service.name" } });
    fireEvent.click(button("Apply"));

    expect(screen.getByRole("dialog", { name: "Collector Self-Monitoring" })).toBeInTheDocument();
    expect(screen.getByText(ATTRIBUTE_EXISTS_MESSAGE)).toBeInTheDocument();
    expect(byId("sm-prom-port")).toHaveValue("9090");
    expect(text()).toBe(TEXT);
    expect(entries()).toBe(0);
    expect(toast.success).not.toHaveBeenCalled();

    // The row named, Apply writes the draft.
    await retypeInto(user, screen.getAllByRole("textbox", { name: "Attribute key" })[2]!, "host.name");
    await apply(user);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(telemetryOf(text())!.resource).toEqual({ "service.name": "my-collector", "service.instance.id": null, "host.name": "" });
    expect(text()).toContain("port: 9090");
    expect(entries()).toBe(1);
  });

  it("adds, edits and removes attributes by their own lines", async () => {
    const user = await openDialog();
    await openSection(user, "Resource Attributes");
    await user.click(button("Add Attribute"));
    const keys = () => screen.getAllByRole("textbox", { name: "Attribute key" });
    const values = () => screen.getAllByRole("textbox", { name: "Attribute value" });
    expect(keys()).toHaveLength(3);
    await retypeInto(user, keys()[2]!, "deployment.environment");
    await retypeInto(user, values()[2]!, "prod");
    await retypeInto(user, values()[0]!, "edge-collector");
    const removes = screen.getAllByRole("button", { name: "×" });
    await user.click(removes[1]!);
    await apply(user);
    expect(telemetryOf(text())!.resource).toEqual({ "service.name": "edge-collector", "deployment.environment": "prod" });
    expect(text()).toContain("      service.name: edge-collector # the name\n");
    expect(text().replace(/\n {6}service\.instance\.id: null|\n {6}"?deployment\.environment"?: "?prod"?/g, "")).toBe(
      TEXT.replace("\n      service.instance.id: null", "").replace("my-collector", "edge-collector"),
    );
  });
});

describe("Remove Section", () => {
  it("removes service.telemetry's lines as one entry, and toasts", async () => {
    const user = await openDialog();
    await user.click(button("Remove Section"));
    expect(text()).toBe(TEXT.slice(0, TEXT.indexOf("  telemetry:")) + TEXT.slice(TEXT.indexOf("  pipelines:")));
    expect(entries()).toBe(1);
    expect(selectUndoDescription(builderStore())).toBe(EDIT_SELF_MONITORING);
    expect(toast.success).toHaveBeenCalledWith("Self-monitoring removed");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button(ACTION)).toHaveAttribute("data-configured", "false");

    // Now there is nothing to remove.
    await user.click(button(ACTION));
    expect(button("Remove Section")).toBeDisabled();
  });

  it("is enabled for an explicit null telemetry, which it removes, though that isn't configured", async () => {
    const yaml = BARE.replace("service:\n", "service:\n  telemetry: null # nothing\n");
    openText(yaml);
    const user = userEvent.setup();
    render(<CanvasActions />);
    expect(button(ACTION)).toHaveAttribute("data-configured", "false");
    await user.click(button(ACTION));
    expect(button("Remove Section")).toBeEnabled();
    await user.click(button("Remove Section"));
    expect(text()).toBe(BARE);
    expect(entries()).toBe(1);
    expect(toast.success).toHaveBeenCalledWith("Self-monitoring removed");
    await user.click(button(ACTION));
    expect(button("Remove Section")).toBeDisabled();
  });

  it("refused by the store, keeps the dialog open with its draft, and no success toast", async () => {
    const user = await openDialog();
    await retypeInto(user, byId("sm-prom-port"), "9090");
    const refuse = vi.fn(() => false);
    useEditorStore.setState({ removeTelemetry: refuse });
    await user.click(button("Remove Section"));
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Collector Self-Monitoring" })).toBeInTheDocument();
    expect(byId("sm-prom-port")).toHaveValue("9090");
    expect(toast.success).not.toHaveBeenCalled();
    expect(text()).toBe(TEXT);
  });

  it("leaves service: {} when telemetry was service's only key", async () => {
    const user = await openDialog("receivers:\n  otlp: {}\nservice:\n  telemetry:\n    logs:\n      level: info\n");
    await user.click(button("Remove Section"));
    expect(text()).toBe("receivers:\n  otlp: {}\nservice: {}\n");
  });
});

describe("a service.telemetry that isn't a mapping", () => {
  it("shows the fields read-only with the hint; Apply is disabled; Remove Section works", async () => {
    const yaml = BARE.replace("service:\n", "service:\n  telemetry: [metrics]\n");
    const user = await openDialog(yaml);
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(byId("sm-metrics-level")).toBeDisabled();
    expect(box("Expose Prometheus Endpoint (pull)")).toBeDisabled();
    expect(box("Push Metrics via OTLP (periodic)")).toBeDisabled();
    expect(button("Apply")).toBeDisabled();
    await openSection(user, "Resource Attributes");
    expect(button("Add Attribute")).toBeDisabled();

    await user.click(button("Remove Section"));
    expect(text()).toBe(BARE);
    expect(toast.success).toHaveBeenCalledWith("Self-monitoring removed");
  });
});

describe("a text changed while the dialog is open", () => {
  function WithShortcuts() {
    useUndoRedo();
    return <CanvasActions />;
  }

  it("the review's reproducer: Apply, reopen, change Level, Ctrl+Z on the page, Apply writes nothing and says so", async () => {
    const yaml = BARE.replace("service:\n", "service:\n  telemetry:\n    logs:\n      level: warn\n");
    openText(yaml);
    const user = userEvent.setup();
    render(<WithShortcuts />);
    await user.click(button(ACTION));
    await openSection(user, "Logs");
    await retypeInto(user, byId("sm-logs-output"), "stdout");
    await apply(user);
    const applied = text();
    expect(telemetryOf(applied)).toEqual({ logs: { level: "warn", output_paths: ["stdout"] } });

    await user.click(button(ACTION));
    await openSection(user, "Logs");
    await pick(user, byId("sm-logs-level"), "error");
    // An undo from outside the dialog (the page itself): the text goes back under the draft.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(text()).toBe(yaml);
    vi.mocked(toast.success).mockClear();

    await apply(user);
    expect(text()).toBe(yaml);
    expect(entries()).toBe(0);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Collector Self-Monitoring" })).toBeInTheDocument();
    expect(screen.getByText(TEXT_CHANGED_MESSAGE)).toBeInTheDocument();
    // The draft is taken again from the text as it is now.
    expect(byId("sm-logs-level")).toHaveTextContent("warn");
    expect(byId("sm-logs-output")).toHaveValue("");

    await pick(user, byId("sm-logs-level"), "error");
    await apply(user);
    expect(text()).toBe(yaml.replace("level: warn", "level: error"));
    expect(toast.success).toHaveBeenCalledWith("Self-monitoring updated");
    expect(screen.queryByRole("dialog")).toBeNull();

    // The message goes with the dialog.
    await user.click(button(ACTION));
    expect(screen.queryByText(TEXT_CHANGED_MESSAGE)).toBeNull();
  });

  it("a change to the text by another path (the store's undo) is caught at Apply", async () => {
    const user = await openDialog();
    await retypeInto(user, byId("sm-prom-port"), "9090");
    await apply(user);
    expect(entries()).toBe(1);

    await user.click(button(ACTION));
    await retypeInto(user, byId("sm-prom-port"), "9191");
    act(() => {
      builderStore().undo();
    });
    expect(text()).toBe(TEXT);

    await apply(user);
    expect(text()).toBe(TEXT);
    expect(builderStore().history.past).toHaveLength(0);
    expect(builderStore().history.future).toHaveLength(1);
    expect(screen.getByText(TEXT_CHANGED_MESSAGE)).toBeInTheDocument();
    expect(byId("sm-prom-port")).toHaveValue("0750");
  });

  it("Cmd/Ctrl+Z, Shift+Z and Y inside the dialog don't reach the editor's undo and redo", async () => {
    openText(TEXT);
    const user = userEvent.setup();
    render(<WithShortcuts />);
    for (const port of ["9090", "9191"]) {
      await user.click(button(ACTION));
      await retypeInto(user, byId("sm-prom-port"), port);
      await apply(user);
    }
    act(() => {
      builderStore().undo();
    });
    const before = text();
    expect(before).toBe(TEXT.replace("port: 0750", "port: 9090"));

    await user.click(button(ACTION));
    await openSection(user, "Logs");
    const keys = [
      { key: "z", ctrlKey: true },
      { key: "z", metaKey: true },
      { key: "z", ctrlKey: true, shiftKey: true },
      { key: "z", metaKey: true, shiftKey: true },
      { key: "y", ctrlKey: true },
      { key: "y", metaKey: true },
    ];
    const press = (target: HTMLElement) => {
      target.focus();
      for (const init of keys) fireEvent.keyDown(target, init);
    };
    press(box("Expose Prometheus Endpoint (pull)"));
    press(button("Remove Section"));
    press(byId("sm-prom-port"));
    // A select's menu renders outside the dialog's content.
    await user.click(byId("sm-logs-level"));
    press(screen.getByRole("option", { name: "debug" }));
    await user.keyboard("{Escape}");

    expect(text()).toBe(before);
    expect(builderStore().history.past).toHaveLength(1);
    expect(builderStore().history.future).toHaveLength(1);
    await user.click(button("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the legacy metrics.address", () => {
  it("shows the legacy banner, and converts it to a Prometheus reader, removing the address", async () => {
    const yaml = BARE.replace("service:\n", "service:\n  telemetry:\n    metrics:\n      address: 127.0.0.1:9999\n      level: basic\n");
    const user = await openDialog(yaml);
    const banner = screen.getByText((_content, element) => element?.tagName === "P" && element.textContent!.startsWith("metrics::address"));
    expect(banner).toHaveTextContent(
      "metrics::address (127.0.0.1:9999) is ignored by collector v0.123.0 and later — every version Telflo supports. Use a Prometheus reader instead.",
    );
    await user.click(button("Convert to Prometheus reader"));
    expect(screen.queryByRole("button", { name: "Convert to Prometheus reader" })).toBeNull();
    expect(byId("sm-prom-host")).toHaveValue("127.0.0.1");
    expect(byId("sm-prom-port")).toHaveValue("9999");
    await apply(user);

    expect(telemetryOf(text())).toEqual({
      metrics: { level: "basic", readers: [{ pull: { exporter: { prometheus: { host: "127.0.0.1", port: 9999 } } } }] },
    });
    expect(entries()).toBe(1);
  });

  it("keeps an existing Prometheus reader, adding none", async () => {
    const yaml = BARE.replace(
      "service:\n",
      "service:\n  telemetry:\n    metrics:\n      address: :oops\n      readers:\n        - pull:\n            exporter:\n              prometheus:\n                port: 7777\n",
    );
    const user = await openDialog(yaml);
    await user.click(button("Convert to Prometheus reader"));
    await apply(user);
    expect(text()).toBe(yaml.replace("      address: :oops\n", ""));
  });

  it("falls back to the default host and port when the address has neither", async () => {
    const yaml = BARE.replace("service:\n", "service:\n  telemetry:\n    metrics:\n      address: nowhere\n");
    const user = await openDialog(yaml);
    await user.click(button("Convert to Prometheus reader"));
    await apply(user);
    expect(telemetryOf(text())).toEqual({
      metrics: { readers: [{ pull: { exporter: { prometheus: { host: "nowhere", port: 8888 } } } }] },
    });
  });
});

describe("the canvas's shortcuts stay out of the dialog", () => {
  function WithShortcuts() {
    useUndoRedo();
    return <CanvasActions />;
  }

  it("Delete, Backspace and Cmd/Ctrl+D on a focused checkbox or button don't delete or duplicate the selected node", async () => {
    openText(TEXT);
    const user = userEvent.setup();
    render(<WithShortcuts />);
    const debug = componentNamed("exporters.debug");
    act(() => {
      builderStore().selectNode(debug.id);
    });
    await user.click(button(ACTION));
    const nodes = builderStore().graph.nodes.length;

    for (const target of [box("Expose Prometheus Endpoint (pull)"), button("Remove Section")]) {
      target.focus();
      for (const init of [{ key: "Delete" }, { key: "Backspace" }, { key: "d", ctrlKey: true }, { key: "d", metaKey: true }]) {
        fireEvent.keyDown(target, init);
      }
    }

    expect(builderStore().pendingDelete).toBeNull();
    expect(builderStore().graph.nodes).toHaveLength(nodes);
    expect(builderStore().selectedNode?.id).toBe(debug.id);
    expect(text()).toBe(TEXT);
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("privacy", () => {
  it("no value reaches an attribute, and no field sits inside a <form>", async () => {
    const MARK = "MARKER";
    const yaml = TEXT.replace("${env:HOST}", `${MARK}-host`)
      .replace("service.name: my-collector", `${MARK}-key: ${MARK}-value`)
      .replace("/var/log/otelcol.log", `/${MARK}/path`)
      .replace("      level: *level # through an alias", `      level: ${MARK}-level\n      address: ${MARK}:9999`)
      .replace("        # the console reader", "        - periodic:\n            exporter:\n              otlp:\n                endpoint: " + `${MARK}-endpoint`);
    const user = await openDialog(yaml);
    await openSection(user, "Logs");
    await openSection(user, "Traces");
    await openSection(user, "Resource Attributes");
    expect(byId("sm-otlp-metrics-endpoint")).toHaveValue(`${MARK}-endpoint`);
    await user.click(byId("sm-metrics-level"));
    expect(screen.getByRole("option", { name: `${MARK}-level` })).toBeInTheDocument();

    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        // A controlled field's value property is its content, not an attribute: the replay masks inputs.
        if (attribute.name === "value" && element instanceof HTMLInputElement) continue;
        if (attribute.value.includes(MARK)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("select")).toBeNull();
  });
});

describe("Clear canvas keeps telemetry", () => {
  it("the action stays configured after the canvas is cleared", async () => {
    openText(corpusText("service-telemetry.yaml"));
    const user = userEvent.setup();
    render(<CanvasActions />);
    await user.click(button("Clear canvas"));
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    expect(button(ACTION)).toHaveAttribute("data-configured", "true");
  });
});

describe("the resource attribute rows, keyed by their attributes", () => {
  it("a key renamed to an integer-like one as another row's × is pressed: the × removes its own attribute", async () => {
    const user = await openDialog(BARE.replace("service:\n", "service:\n  telemetry:\n    resource:\n      b: x\n      a: y\n"));
    await openSection(user, "Resource Attributes");
    const keys = () => screen.getAllByRole("textbox", { name: "Attribute key" }) as HTMLInputElement[];
    expect(keys().map((key) => key.value)).toEqual(["b", "a"]);
    await user.clear(keys()[1]!);
    await user.type(keys()[1]!, "5");
    const dialog = screen.getByRole("dialog");
    // Row 0's ×: pressing it leaves the key field, which renames a to 5, and 5 goes first.
    await user.click(within(dialog).getAllByRole("button", { name: "×" })[0]!);
    expect(keys().map((key) => key.value)).toEqual(["5"]);
    await user.click(button("Apply"));
    expect(telemetryOf(text())?.resource).toEqual({ 5: "y" });
  });
});
