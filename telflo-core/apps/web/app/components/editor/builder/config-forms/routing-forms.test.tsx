import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FailoverConnectorForm, LEVEL_KEEPS_LAST_PIPELINE } from "./FailoverConnectorForm.js";
import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import {
  LAST_ATTRIBUTE_HINT,
  LoadBalancingExporterForm,
  REMOVED_ROUTING_ATTRIBUTES,
  removedResolverMessage,
} from "./LoadBalancingExporterForm.js";
import { ROUTE_KEEPS_LAST_PIPELINE, RoutingConnectorForm, STATEMENT_TO_CONDITION } from "./RoutingConnectorForm.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { componentValueText } from "~/lib/graph/text-edits.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The routing, failover and load-balancing forms: their forms over the form
 * contract. Each field is driven as a person would on the routing corpus text
 * (comments, an anchor and merges, flow and block lists, CRLF) with a `0750`,
 * LF and CRLF, and writes only its key. The routing (5) and failover (5)
 * cases: choosing a target writes the connector's entry and the pipeline's
 * receiver in one undo entry, with its toast; removing one removes the
 * receiver unless something still names the pipeline or it is the pipeline's
 * only receiver. Each of these has a test that fails if it breaks: held
 * routes, levels and rows, the cascades and their toasts, the defaults shown,
 * the choices added, privacy.
 *
 * Collector claims cite contrib v0.162.0: `connector/routingconnector`,
 * `connector/failoverconnector`, `exporter/loadbalancingexporter`.
 */

const LF = (text: string) => text.replace(/\r\n/g, "\n");
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

/** The routing corpus (LF), with a bare `0750` the forms must leave as it is. */
const CORPUS = LF(corpusText("forms-routing.yaml")).replace("receivers:\n  otlp:\n", "x-mode: 0750\nreceivers:\n  otlp:\n");

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The info toasts shown so far. */
const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

const ROUTING = "connectors.routing";
const SEVERITY = "connectors.routing/severity";
const FAILOVER = "connectors.failover";
const LB = "exporters.loadbalancing";
const LB_K8S = "exporters.loadbalancing/k8s";
const LB_DNS = "exporters.load_balancing/dns";

function formOf(key: string): ReactNode {
  if (key.startsWith("connectors.routing")) return <RoutingConnectorForm />;
  if (key.startsWith("connectors.failover")) return <FailoverConnectorForm />;
  return <LoadBalancingExporterForm />;
}

function renderForm(key: string, text = CORPUS) {
  openText(text);
  const user = userEvent.setup();
  render(<ComponentForm nodeId={componentNamed(key).id}>{formOf(key)}</ComponentForm>);
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const byId = (id: string) => document.getElementById(id) as HTMLElement;
type Value = Record<string, unknown>;
const parsed = (written = text()) => parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>;
const valueOf = (key: string, written = text()): Value => {
  const dot = key.indexOf(".");
  return parsed(written)[key.slice(0, dot)]![key.slice(dot + 1)]!;
};
const receiversOf = (pipeline: string, written = text()) =>
  (parsed(written).service!.pipelines as Record<string, { receivers: string[] }>)[pipeline]!.receivers;
/** A hint line, by its whole text ("… · Default ignore" spans elements). */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
const queryHint = (whole: string) =>
  screen.queryByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

/** Replaces `input`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, escapeKeys(typed));
  await user.tab();
}

/** `typed` with user-event's special characters (`{`, `[`) escaped. */
const escapeKeys = (typed: string) => typed.replace(/[{[]/g, (c) => c + c);

/** Types into an empty field and leaves it. */
async function typeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.click(input);
  await user.keyboard(escapeKeys(typed));
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

async function optionsOf(user: UserEvent, trigger: HTMLElement): Promise<string[]> {
  await user.click(trigger);
  const shown = screen.getAllByRole("option").map((option) => option.textContent ?? "");
  await user.keyboard("{Escape}");
  return shown;
}

/** Opens a section by its title (its name also holds its count); the form's own is the last of that name (the queue section has an Advanced too). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getAllByRole("button", { name: new RegExp(`^${title}\\s*\\d*$`) }).at(-1)!);
}

/** A labeled field's block (its ConfigField), by its label. */
function fieldOf(label: string): HTMLElement {
  return screen.getByText(label, { selector: "label" }).closest("div.space-y-1\\.5") as HTMLElement;
}

/** A card (a route or a level) by its title. */
function cardOf(title: string): HTMLElement {
  const label = screen.getByText(title, { selector: "div.font-medium" });
  return label.closest("div.rounded-md") as HTMLElement;
}

// ── Sortable cards by keyboard ──

const ROW_HEIGHT = 40;

/** The sortable card an element is in: a child of a `space-y-2` list whose children all hold a drag handle. */
function rowOf(element: Element): HTMLElement | null {
  for (let e: HTMLElement | null = element as HTMLElement; e; e = e.parentElement) {
    const parent = e.parentElement;
    if (parent?.classList.contains("space-y-2") && [...parent.children].every((child) => child.querySelector('[aria-roledescription="sortable"]'))) {
      return e;
    }
  }
  return null;
}

/** dnd-kit measures rows; jsdom's are all zero, so cards are laid out 40 px apart. */
function layOutRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = rowOf(this);
    const index = row ? [...row.parentElement!.children].indexOf(row) : 0;
    const top = index * ROW_HEIGHT;
    return { x: 0, y: top, top, left: 0, right: 200, bottom: top + ROW_HEIGHT, width: 200, height: ROW_HEIGHT, toJSON: () => ({}) } as DOMRect;
  });
}

async function press(element: Element, key: string, code = key) {
  await act(async () => {
    fireEvent.keyDown(element, { key, code });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Drags handle `handle` by keyboard: Space, `steps` arrows, Space. */
async function dragByKeyboard(handle: HTMLElement, steps: number) {
  act(() => handle.focus());
  await press(handle, " ", "Space");
  for (let i = 0; i < Math.abs(steps); i++) await press(handle, steps > 0 ? "ArrowDown" : "ArrowUp");
  await press(handle, " ", "Space");
}

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  key: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Checks the component's value after, as parsed. */
  check: (value: Value) => void;
}

const CASES: FieldCase[] = [
  // routing
  {
    name: "routing Context",
    key: ROUTING,
    edit: (user) => pickIn(user, byId("route-0-context"), "Span (traces, per span)"),
    from: "      - context: resource\n        condition: otelcol.client.metadata[\"X-Tenant\"][0] == \"acme\"\n",
    to: "      - context: span\n        condition: otelcol.client.metadata[\"X-Tenant\"][0] == \"acme\"\n",
    check: (v) => expect((v.table as Value[])[0]!.context).toBe("span"),
  },
  {
    name: "routing Condition, written as typed",
    key: ROUTING,
    edit: (user) => retypeInto(user, byId("route-0-expression"), 'resource.attributes["tenant"] == "acme"'),
    from: "        condition: otelcol.client.metadata[\"X-Tenant\"][0] == \"acme\"\n",
    to: "        condition: resource.attributes[\"tenant\"] == \"acme\"\n",
    check: (v) => expect((v.table as Value[])[0]!.condition).toBe('resource.attributes["tenant"] == "acme"'),
  },
  {
    name: "routing Match Using renames the condition in place",
    key: ROUTING,
    edit: (user) => pickIn(user, byId("route-0-match"), "Statement (route() where ...)"),
    from: "        condition: otelcol.client.metadata[\"X-Tenant\"][0] == \"acme\"\n",
    to: "        statement: otelcol.client.metadata[\"X-Tenant\"][0] == \"acme\"\n",
    check: (v) => expect((v.table as Value[])[0]).toEqual({ context: "resource", statement: 'otelcol.client.metadata["X-Tenant"][0] == "acme"', pipelines: ["logs/acme"] }),
  },
  {
    name: "routing Action (unset)",
    key: ROUTING,
    edit: (user) => pickIn(user, byId("route-0-action"), "Copy"),
    from: "        pipelines: [logs/acme]\n",
    to: "        pipelines: [logs/acme]\n        action: copy\n",
    check: (v) => expect((v.table as Value[])[0]!.action).toBe("copy"),
  },
  {
    name: "routing Error Mode (unset)",
    key: ROUTING,
    edit: async (user) => {
      await openSection(user, "Fallback & Errors");
      await pickIn(user, byId("routing-error-mode"), "Silent (use default)");
    },
    from: "          - logs/ecorp\n  routing/severity:\n",
    to: "          - logs/ecorp\n    error_mode: silent\n  routing/severity:\n",
    check: (v) => expect(v.error_mode).toBe("silent"),
  },
  {
    name: "routing/severity Error Mode (set)",
    key: SEVERITY,
    edit: async (user) => {
      await openSection(user, "Fallback & Errors");
      await pickIn(user, byId("routing-error-mode"), "Ignore (log, use default)");
    },
    from: "    error_mode: propagate\n",
    to: "    error_mode: ignore\n",
    check: (v) => expect(v.error_mode).toBe("ignore"),
  },
  // failover
  {
    name: "failover Retry Interval",
    key: FAILOVER,
    edit: async (user) => {
      await openSection(user, "Recovery & Queue");
      await retypeInto(user, byId("failover-retry-interval"), "30s");
    },
    from: "    retry_interval: 10s\n",
    to: "    retry_interval: 30s\n",
    check: (v) => expect(v.retry_interval).toBe("30s"),
  },
  {
    name: "failover Sending Queue unticked (on while unset)",
    key: FAILOVER,
    edit: async (user) => {
      await openSection(user, "Recovery & Queue");
      await user.click(byId("queue-enable"));
    },
    from: "    retry_interval: 10s\n",
    to: "    retry_interval: 10s\n    sending_queue:\n      enabled: false\n",
    check: (v) => expect(v.sending_queue).toEqual({ enabled: false }),
  },
  // load balancing
  {
    name: "loadbalancing Routing Key (unset)",
    key: LB,
    edit: (user) => pickIn(user, byId("lb-routing-key"), "Service Name"),
    from: "        hostnames: [backend-1:4317, backend-2:4317]\n",
    to: "        hostnames: [backend-1:4317, backend-2:4317]\n    routing_key: service\n",
    check: (v) => expect(v.routing_key).toBe("service"),
  },
  {
    name: "loadbalancing Routing Key randomness",
    key: LB_DNS,
    edit: (user) => pickIn(user, byId("lb-routing-key"), "Randomness (traces only)"),
    from: "    routing_key: service # metrics route by service\n",
    to: "    routing_key: randomness # metrics route by service\n",
    check: (v) => expect(v.routing_key).toBe("randomness"),
  },
  {
    name: "loadbalancing static endpoint row",
    key: LB,
    edit: (user) => retypeInto(user, screen.getAllByPlaceholderText("e.g. backend-1:4317")[1]!, "backend-3:4317"),
    from: "        hostnames: [backend-1:4317, backend-2:4317]\n",
    to: "        hostnames: [backend-1:4317, backend-3:4317]\n",
    check: (v) => expect((v.resolver as Value).static).toEqual({ hostnames: ["backend-1:4317", "backend-3:4317"] }),
  },
  {
    name: "loadbalancing OTLP Protocol Timeout",
    key: LB,
    edit: async (user) => {
      await openSection(user, "OTLP Protocol");
      await retypeInto(user, byId("lb-protocol-timeout"), "2s");
    },
    from: "        timeout: 1s\n        tls:\n",
    to: "        timeout: 2s\n        tls:\n",
    check: (v) => expect(((v.protocol as Value).otlp as Value).timeout).toBe("2s"),
  },
  {
    name: "loadbalancing OTLP Protocol Compression (unset)",
    key: LB,
    edit: async (user) => {
      await openSection(user, "OTLP Protocol");
      await pickIn(user, byId("lb-protocol-compression"), "none");
    },
    from: "          insecure: true\n    resolver:\n",
    to: "          insecure: true\n        compression: none\n    resolver:\n",
    check: (v) => expect(((v.protocol as Value).otlp as Value).compression).toBe("none"),
  },
  {
    name: "loadbalancing OTLP Protocol insecure unticked",
    key: LB,
    edit: async (user) => {
      await openSection(user, "OTLP Protocol");
      await user.click(byId("tls-insecure"));
    },
    from: "          insecure: true\n",
    to: "          insecure: false\n",
    check: (v) => expect((((v.protocol as Value).otlp as Value).tls as Value).insecure).toBe(false),
  },
  {
    name: "loadbalancing top-level Timeout (unset)",
    key: LB,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await typeInto(user, byId("lb-timeout"), "10s");
    },
    from: "        hostnames: [backend-1:4317, backend-2:4317]\n",
    to: "        hostnames: [backend-1:4317, backend-2:4317]\n    timeout: 10s\n",
    check: (v) => expect(v.timeout).toBe("10s"),
  },
  {
    name: "loadbalancing/k8s top-level Retry unticked (on with enabled: true)",
    key: LB_K8S,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await user.click(byId("lb-retry-enable"));
    },
    from: "    retry_on_failure:\n      enabled: true\n      initial_interval: 5s\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("retry_on_failure"),
  },
  {
    name: "loadbalancing/k8s Service",
    key: LB_K8S,
    edit: (user) => retypeInto(user, byId("lb-k8s-service"), "lb-svc.monitoring"),
    from: "        service: lb-svc.kube-public\n",
    to: "        service: lb-svc.monitoring\n",
    check: (v) => expect(((v.resolver as Value).k8s as Value).service).toBe("lb-svc.monitoring"),
  },
  {
    name: "loadbalancing/k8s port row, written plain",
    key: LB_K8S,
    edit: (user) => retypeInto(user, screen.getAllByPlaceholderText("4317")[1]!, "16318"),
    from: "        ports: [15317, 16317]\n",
    to: "        ports: [15317, 16318]\n",
    check: (v) => expect(((v.resolver as Value).k8s as Value).ports).toEqual([15317, 16318]),
  },
  {
    name: "loadbalancing/k8s Timeout (unset)",
    key: LB_K8S,
    edit: (user) => typeInto(user, byId("lb-k8s-timeout"), "30s"),
    from: "        ports: [15317, 16317]\n",
    to: "        ports: [15317, 16317]\n        timeout: 30s\n",
    check: (v) => expect(((v.resolver as Value).k8s as Value).timeout).toBe("30s"),
  },
  {
    name: "loadbalancing/k8s Return Hostnames",
    key: LB_K8S,
    edit: (user) => user.click(byId("return_hostnames")),
    from: "        ports: [15317, 16317]\n",
    to: "        ports: [15317, 16317]\n        return_hostnames: true\n",
    check: (v) => expect(((v.resolver as Value).k8s as Value).return_hostnames).toBe(true),
  },
  {
    name: "load_balancing/dns Hostname",
    key: LB_DNS,
    edit: (user) => retypeInto(user, byId("lb-dns-hostname"), "backend.example.com"),
    from: "        hostname: otelcol-backend.observability.svc.cluster.local\n",
    to: "        hostname: backend.example.com\n",
    check: (v) => expect(((v.resolver as Value).dns as Value).hostname).toBe("backend.example.com"),
  },
  {
    name: "load_balancing/dns Port, a string as the collector reads it",
    key: LB_DNS,
    edit: (user) => retypeInto(user, byId("lb-dns-port"), "4318"),
    from: "        port: 4317\n",
    to: '        port: "4318"\n',
    check: (v) => expect(((v.resolver as Value).dns as Value).port).toBe("4318"),
  },
  {
    name: "load_balancing/dns Refresh Interval",
    key: LB_DNS,
    edit: (user) => retypeInto(user, byId("lb-dns-interval"), "10s"),
    from: "        interval: 5s\n",
    to: "        interval: 10s\n",
    check: (v) => expect(((v.resolver as Value).dns as Value).interval).toBe("10s"),
  },
];

describe("every field of each form writes only its key", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const before = crlf ? CRLF(CORPUS) : CORPUS;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      c.check(valueOf(c.key));
      expect(infoToasts()).toEqual([]);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );
});

describe("opening writes nothing", () => {
  const KEYS = [ROUTING, SEVERITY, FAILOVER, LB, LB_K8S, LB_DNS];
  /** What each form shows once opened, at least: its text fields, every control, and a field. */
  const OPENED: Record<string, { textboxes: number; all: number; field: string }> = {
    [ROUTING]: { textboxes: 2, all: 12, field: "route-1-expression" },
    [SEVERITY]: { textboxes: 2, all: 11, field: "route-1-expression" },
    [FAILOVER]: { textboxes: 4, all: 11, field: "level-2-targets-0" },
    [LB]: { textboxes: 10, all: 18, field: "lb-static-hostnames" },
    [LB_K8S]: { textboxes: 10, all: 20, field: "lb-k8s-ports" },
    [LB_DNS]: { textboxes: 10, all: 17, field: "lb-dns-hostname" },
  };
  // One test per form and text, each with its own time limit.
  it.each(KEYS.flatMap((key) => [[key, "LF", CORPUS] as const, [key, "CRLF", CRLF(CORPUS)] as const]))(
    "opening %s (%s), every section and card, focusing every field, writes nothing and leaves the editor clean",
    async (key, _name, base) => {
      const user = renderForm(key, base);
      for (let round = 0; round < 3; round++) {
        for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      }
      for (const header of screen.queryAllByRole("button", { name: /^Route \d/ })) {
        if (!within(header.closest("div.rounded-md")!).queryByText("Context")) await user.click(header);
      }
      const { textboxes, all } = formControls();
      expect(textboxes.length).toBeGreaterThanOrEqual(OPENED[key]!.textboxes);
      expect(all).toBeGreaterThanOrEqual(OPENED[key]!.all);
      expect(document.getElementById(OPENED[key]!.field)).not.toBeNull();
      for (const field of textboxes) {
        await user.click(field);
        await user.tab();
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
      expect(selectIsDirty(builderStore())).toBe(false);
    },
    20_000,
  );
});

// ── Routing cases: a target wires its pipeline ──

const ROUTING_TEXT = `receivers:
  otlp:
    protocols:
      grpc:
exporters:
  debug:
connectors:
  routing:
    error_mode: ignore
    default_pipelines: [traces/primary]
    table:
      - context: resource
        condition: 'attributes["tenant"] == "acme"'
        pipelines: [traces/audit]
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [routing]
    traces/primary:
      receivers: [routing]
      exporters: [debug]
    traces/audit:
      receivers: [routing]
      exporters: [debug]
    traces/extra:
      receivers: [otlp]
      exporters: [debug]
`;

const routingValue = () => valueOf(ROUTING);
const routeTargets = (index = 0) => ((routingValue().table as Value[])[index]!.pipelines as string[]) ?? [];

describe("RoutingConnectorForm: targets wire their pipelines", () => {
  it("shows selected target pipelines in dropdown triggers, not text inputs", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    await openSection(user, "Fallback & Errors");
    const texts = screen.getAllByRole("combobox").map((t) => t.textContent);
    expect(texts).toContain("traces/audit");
    expect(texts).toContain("traces/primary");
  });

  it("choosing a pipeline in a held row writes the route's item and the pipeline's receiver, in one undo entry, with the toast", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    // The empty row is a held row: Add holds it, nothing is written.
    await user.click(within(cardOf("Route 1")).getByRole("button", { name: "Add Pipeline" }));
    expect(text()).toBe(ROUTING_TEXT);
    const held = byId("route-0-targets-1");
    expect(held).toHaveTextContent("Select pipeline");

    await pickIn(user, held, "traces/extra");

    expect(routeTargets()).toEqual(["traces/audit", "traces/extra"]);
    expect(text()).toContain("        pipelines: [traces/audit, traces/extra]\n");
    expect(receiversOf("traces/extra")).toEqual(["otlp", "routing"]);
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual(["Added routing to the receivers of traces/extra."]);
    // Inside ph-no-capture: it names a pipeline.
    expect(vi.mocked(toast.info).mock.calls.at(-1)?.[1]).toEqual({ className: "ph-no-capture" });
    act(() => void builderStore().undo());
    expect(text()).toBe(ROUTING_TEXT);
  });

  it("flags a target that no longer matches any pipeline", () => {
    renderForm(ROUTING, ROUTING_TEXT.replace("pipelines: [traces/audit]", "pipelines: [traces/gone]"));
    // The stale name stays visible so it can be replaced deliberately.
    expect(byId("route-0-targets-0")).toHaveTextContent("traces/gone (not found)");
  });

  it("removing a target pipeline removes the item; the connector stays in receivers while it is the pipeline's only receiver", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT.replace("pipelines: [traces/audit]", "pipelines: [traces/audit, traces/extra]"));
    await user.click(within(cardOf("Route 1")).getAllByRole("button", { name: "Remove pipeline" })[0]!);
    expect(routeTargets()).toEqual(["traces/extra"]);
    expect(receiversOf("traces/audit")).toEqual(["routing"]);
    expect(infoToasts()).toEqual(["Kept routing in traces/audit's receivers: it's the pipeline's only receiver."]);
    expect(entries()).toBe(1);
  });

  it("removing a target removes the receiver once nothing names the pipeline, and keeps it while the default does", async () => {
    const three = ROUTING_TEXT.replace("pipelines: [traces/audit]", "pipelines: [traces/audit, traces/primary, traces/extra]").replace(
      "    traces/audit:\n      receivers: [routing]",
      "    traces/audit:\n      receivers: [otlp, routing]",
    );
    const user = renderForm(ROUTING, three);
    const card = () => cardOf("Route 1");
    // traces/primary is still the default pipeline: its receiver stays, no toast.
    await user.click(within(card()).getAllByRole("button", { name: "Remove pipeline" })[1]!);
    expect(routeTargets()).toEqual(["traces/audit", "traces/extra"]);
    expect(receiversOf("traces/primary")).toEqual(["routing"]);
    expect(infoToasts()).toEqual([]);
    // traces/audit, named nowhere else, with another receiver: removed.
    await user.click(within(card()).getAllByRole("button", { name: "Remove pipeline" })[0]!);
    expect(routeTargets()).toEqual(["traces/extra"]);
    expect(receiversOf("traces/audit")).toEqual(["otlp"]);
    expect(infoToasts()).toEqual(["Removed routing from the receivers of traces/audit."]);
  });

  it("disables Add Pipeline when every eligible pipeline is already selected", async () => {
    const user = renderForm(
      ROUTING,
      ROUTING_TEXT.replace("pipelines: [traces/audit]", "pipelines: [traces/primary, traces/audit, traces/extra]"),
    );
    await openSection(user, "Fallback & Errors");
    const addButtons = screen.getAllByRole("button", { name: "Add Pipeline" });
    // The route's picker (all options taken) is disabled; the default pipelines' stays enabled.
    expect(addButtons[0]).toBeDisabled();
    expect(addButtons[1]).toBeEnabled();
  });
});

describe("RoutingConnectorForm: routes", () => {
  it("Add Route holds a card; its condition typed writes {context: resource, condition} as one entry, and the card keeps focus", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    await user.click(screen.getByRole("button", { name: "Add Route" }));
    expect(text()).toBe(ROUTING_TEXT);
    expect(cardOf("Route 2")).toHaveTextContent("no condition → no pipelines");
    expect(screen.getByRole("button", { name: "Add Route" })).toBeDisabled();

    const expression = byId("route-1-expression");
    await user.click(expression);
    await user.keyboard(escapeKeys('attributes["tier"] == "gold"'));
    await user.tab({ shift: true });

    expect((routingValue().table as Value[])[1]).toEqual({ context: "resource", condition: 'attributes["tier"] == "gold"' });
    expect(entries()).toBe(1);
    expect(byId("route-1-expression")).toBe(expression);
    expect(cardOf("Route 2")).toHaveTextContent('attributes["tier"] == "gold" → no pipelines');
    expect(screen.getByRole("button", { name: "Add Route" })).toBeEnabled();
  });

  // The deliberate break: a held route seeded with `condition: ""` fails this test.
  it("a held route's pipeline chosen first writes {context: resource, pipelines: [p]} and wires p, in one entry", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    await user.click(screen.getByRole("button", { name: "Add Route" }));
    await user.click(within(cardOf("Route 2")).getByRole("button", { name: "Add Pipeline" }));
    await pickIn(user, byId("route-1-targets-0"), "traces/extra");

    expect((routingValue().table as Value[])[1]).toEqual({ context: "resource", pipelines: ["traces/extra"] });
    expect(text()).toContain("      - context: resource\n        pipelines:\n          - traces/extra\n");
    expect(receiversOf("traces/extra")).toEqual(["otlp", "routing"]);
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual(["Added routing to the receivers of traces/extra."]);
  });

  it("a held route's context and action are held with it until its expression is typed; its Remove writes nothing", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    await user.click(screen.getByRole("button", { name: "Add Route" }));
    await pickIn(user, byId("route-1-context"), "Span (traces, per span)");
    await pickIn(user, byId("route-1-action"), "Copy");
    expect(text()).toBe(ROUTING_TEXT);
    expect(byId("route-1-context")).toHaveTextContent("Span (traces, per span)");

    await typeInto(user, byId("route-1-expression"), "name == nil");
    expect((routingValue().table as Value[])[1]).toEqual({ context: "span", action: "copy", condition: "name == nil" });
    expect(entries()).toBe(1);

    await user.click(screen.getByRole("button", { name: "Add Route" }));
    await user.click(within(cardOf("Route 3")).getByRole("button", { name: "Remove route" }));
    expect(screen.queryByText("Route 3")).toBeNull();
    expect(entries()).toBe(1);
  });

  it("a held route stays through a write elsewhere in the form", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    await user.click(screen.getByRole("button", { name: "Add Route" }));
    await openSection(user, "Fallback & Errors");
    await pickIn(user, byId("routing-error-mode"), "Silent (use default)");
    expect(routingValue().error_mode).toBe("silent");
    expect(cardOf("Route 2")).toHaveTextContent("no condition → no pipelines");
  });

  it("Match Using with neither key holds the kind until an expression is typed (never statement: \"\")", async () => {
    const onlyPipelines = ROUTING_TEXT.replace("        condition: 'attributes[\"tenant\"] == \"acme\"'\n", "");
    const user = renderForm(ROUTING, onlyPipelines);
    await pickIn(user, byId("route-0-match"), "Statement (route() where ...)");
    expect(text()).toBe(onlyPipelines);
    expect(screen.getByText("Statement", { selector: "label" })).toBeInTheDocument();
    expect(byId("route-0-expression")).toHaveAttribute("placeholder", 'route() where attributes["deployment.environment"] == "prod"');

    await typeInto(user, byId("route-0-expression"), "route() where true");
    expect((routingValue().table as Value[])[0]).toEqual({ context: "resource", pipelines: ["traces/audit"], statement: "route() where true" });
    // Cleared, the key goes and the kind stays.
    await retypeInto(user, byId("route-0-expression"), "");
    expect((routingValue().table as Value[])[0]).toEqual({ context: "resource", pipelines: ["traces/audit"] });
    expect(byId("route-0-match")).toHaveTextContent("Statement (route() where ...)");
  });

  it("Context switched to Request renames a statement to a condition in place, one entry, with the toast", async () => {
    const user = renderForm(SEVERITY);
    await user.click(screen.getByRole("button", { name: /^Route 2/ }));
    await pickIn(user, byId("route-1-context"), "Request (HTTP/gRPC metadata, deprecated)");

    const lines = '      - statement: route() where resource.attributes["service.name"] == "service1"\n        pipelines: [logs/service1]\n';
    expect(text()).toBe(
      CORPUS.replace(
        lines,
        '      - condition: route() where resource.attributes["service.name"] == "service1"\n        pipelines: [logs/service1]\n        context: request\n',
      ),
    );
    expect((valueOf(SEVERITY).table as Value[])[1]).not.toHaveProperty("statement");
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([STATEMENT_TO_CONDITION]);
    expect(byId("route-1-match")).toHaveTextContent("Condition (boolean expression)");
    expect(byId("route-1-match")).toBeDisabled();
    expect(screen.getByText(/The request context only supports a single/)).toBeInTheDocument();
  });

  it("Context switched to Request with both a statement and a condition removes the statement, with the toast", async () => {
    const both = ROUTING_TEXT.replace("        pipelines: [traces/audit]\n", "        statement: route()\n        pipelines: [traces/audit]\n");
    const user = renderForm(ROUTING, both);
    await pickIn(user, byId("route-0-context"), "Request (HTTP/gRPC metadata, deprecated)");
    expect(text()).toBe(both.replace("      - context: resource\n", "      - context: request\n").replace("        statement: route()\n", ""));
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([STATEMENT_TO_CONDITION]);
  });

  it("a condition switched to Request writes the context alone, with no toast", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    await pickIn(user, byId("route-0-context"), "Request (HTTP/gRPC metadata, deprecated)");
    expect(text()).toBe(ROUTING_TEXT.replace("      - context: resource\n", "      - context: request\n"));
    expect(infoToasts()).toEqual([]);
  });

  it("removing a route unwires what only it named; the Remove of another route keeps a receiver the default still names", async () => {
    const text2 = ROUTING_TEXT.replace(
      "        pipelines: [traces/audit]\n",
      "        pipelines: [traces/audit]\n      - condition: 'true'\n        pipelines: [traces/primary, traces/extra]\n",
    ).replace("    traces/extra:\n      receivers: [otlp]", "    traces/extra:\n      receivers: [otlp, routing]");
    const user = renderForm(ROUTING, text2);
    await user.click(within(cardOf("Route 2")).getByRole("button", { name: "Remove route" }));
    expect((routingValue().table as Value[]).length).toBe(1);
    expect(receiversOf("traces/extra")).toEqual(["otlp"]);
    expect(receiversOf("traces/primary")).toEqual(["routing"]);
    expect(infoToasts()).toEqual(["Removed routing from the receivers of traces/extra."]);
    expect(entries()).toBe(1);
  });

  it("dragging a route by keyboard moves its lines, its expanded state with it, and wires nothing", async () => {
    layOutRows();
    const two = ROUTING_TEXT.replace(
      "        pipelines: [traces/audit]\n",
      "        pipelines: [traces/audit] # first\n      - condition: 'false'\n        pipelines: [traces/primary]\n",
    );
    renderForm(ROUTING, two);
    expect(screen.queryByText("Context", { selector: "label" })).not.toBeNull();
    const [first] = screen.getAllByRole("button", { name: "Drag to reorder" });
    await dragByKeyboard(first!, 1);
    expect(text()).toBe(
      two.replace(
        "      - context: resource\n        condition: 'attributes[\"tenant\"] == \"acme\"'\n        pipelines: [traces/audit] # first\n      - condition: 'false'\n        pipelines: [traces/primary]\n",
        "      - condition: 'false'\n        pipelines: [traces/primary]\n      - context: resource\n        condition: 'attributes[\"tenant\"] == \"acme\"'\n        pipelines: [traces/audit] # first\n",
      ),
    );
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
    // The expanded card moved with its route: Route 2 is open, Route 1 closed.
    expect(within(cardOf("Route 2")).queryByText("Context", { selector: "label" })).not.toBeNull();
    expect(within(cardOf("Route 1")).queryByText("Context", { selector: "label" })).toBeNull();
  });

  it("dragging a route in a flow table spread over lines moves each route's comments with it", async () => {
    layOutRows();
    const table = (routes: readonly string[]) => ROUTING_TEXT.replace(
      "    table:\n      - context: resource\n        condition: 'attributes[\"tenant\"] == \"acme\"'\n        pipelines: [traces/audit]\n",
      ["    table: [", ...routes, "    ]", ""].join("\n"),
    );
    const acme = ["      # the acme tenant", "      {condition: 'attributes[\"tenant\"] == \"acme\"', pipelines: [traces/audit]}"];
    const other = "      {condition: 'false', pipelines: [traces/primary]}";
    const flow = table([...acme.slice(0, 1), `${acme[1]}, # audit`, `${other} # primary`]);
    expect(flow).toContain("    table: [\n      # the acme tenant\n");
    renderForm(ROUTING, flow);
    const [first] = screen.getAllByRole("button", { name: "Drag to reorder" });
    await dragByKeyboard(first!, 1);
    expect(text()).toBe(table([`${other}, # primary`, ...acme.slice(0, 1), `${acme[1]} # audit`]));
    expect((routingValue().table as Value[]).map((route) => route.pipelines)).toEqual([["traces/primary"], ["traces/audit"]]);
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
  });

  it("shows unset as the collector's defaults: Context blank with the inferred hint, Action move, Error Mode ignore", async () => {
    const user = renderForm(SEVERITY);
    expect(byId("route-0-context")).toHaveTextContent("");
    expect(hint("Where the expression is evaluated. Use the coarsest context that works. · Default: inferred from the expression's paths, else resource")).toBeInTheDocument();
    expect(byId("route-0-action")).toHaveTextContent("Move");
    expect(
      hint("move removes matched data from later routes; copy keeps it available for them and the default pipelines. · Default move"),
    ).toBeInTheDocument();
    expect(await optionsOf(user, byId("route-0-context"))).toEqual([
      "Resource (once per bundle)",
      "Span (traces, per span)",
      "Metric (metrics, per metric)",
      "Datapoint (metrics, per data point)",
      "Log (logs, per record)",
      "OTel Collector (client/gRPC metadata)",
      "Request (HTTP/gRPC metadata, deprecated)",
    ]);
    cleanup();
    useEditorStore.setState(initialState, true);
    const again = renderForm(ROUTING);
    await openSection(again, "Fallback & Errors");
    expect(byId("routing-error-mode")).toHaveTextContent("Ignore (log, use default)");
    expect(
      hint(
        "How OTTL evaluation errors are handled. propagate drops the whole payload; ignore logs the error and routes to the default pipelines; silent does the same without logging. · Default ignore",
      ),
    ).toBeInTheDocument();
  });

  it("warns of an empty table and of no default pipelines; neither while the text has them", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT.replace(/ {4}table:\n[\s\S]*?\nservice:/, "    table: []\nservice:").replace("    default_pipelines: [traces/primary]\n", ""));
    expect(screen.getByText("No routes configured")).toBeInTheDocument();
    await openSection(user, "Fallback & Errors");
    expect(screen.getByText("Unmatched telemetry is dropped")).toBeInTheDocument();
    cleanup();
    useEditorStore.setState(initialState, true);
    const again = renderForm(ROUTING, ROUTING_TEXT);
    await openSection(again, "Fallback & Errors");
    expect(screen.queryByText("No routes configured")).toBeNull();
    expect(screen.queryByText("Unmatched telemetry is dropped")).toBeNull();
  });

  it("a table it can't show is read-only with the unshowable-value hint; Add Route is disabled", () => {
    renderForm(ROUTING, ROUTING_TEXT.replace(/ {4}table:\n[\s\S]*?\nservice:/, "    table: oops\nservice:"));
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Route" })).toBeDisabled();
  });
});

// ── Failover cases: a target wires its pipeline ──

const FAILOVER_TEXT = `receivers:
  otlp:
    protocols:
      grpc:
exporters:
  debug:
connectors:
  failover:
    priority_levels:
      - [traces/primary]
      - [traces/secondary]
    retry_interval: 30s
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [failover]
    traces/primary:
      receivers: [otlp, failover]
      exporters: [debug]
    traces/secondary:
      receivers: [failover]
      exporters: [debug]
    traces/tertiary:
      receivers: [otlp]
      exporters: [debug]
`;

const levels = () => valueOf(FAILOVER).priority_levels as string[][];

describe("FailoverConnectorForm: targets wire their pipelines", () => {
  it("renders one card per level with its pipelines in dropdown triggers", () => {
    renderForm(FAILOVER, FAILOVER_TEXT);
    expect(screen.getByText("Priority 1")).toBeInTheDocument();
    expect(screen.getByText("Priority 2")).toBeInTheDocument();
    expect(screen.getByText("(preferred)")).toBeInTheDocument();
    const texts = screen.getAllByRole("combobox").map((t) => t.textContent);
    expect(texts).toContain("traces/primary");
    expect(texts).toContain("traces/secondary");
  });

  it("warns when there are no levels yet", () => {
    renderForm(FAILOVER, FAILOVER_TEXT.replace("    priority_levels:\n      - [traces/primary]\n      - [traces/secondary]\n", "    priority_levels: []\n"));
    expect(screen.getByText(/No priority levels configured/i)).toBeInTheDocument();
  });

  it("adding a level holds a card (nothing written); its first pipeline writes [p] and the receiver, in one entry", async () => {
    const user = renderForm(FAILOVER, FAILOVER_TEXT);
    await user.click(screen.getByRole("button", { name: /Add Priority Level/i }));
    expect(text()).toBe(FAILOVER_TEXT);
    expect(cardOf("Priority 3")).toHaveTextContent("no pipelines");

    await user.click(within(cardOf("Priority 3")).getByRole("button", { name: "Add Pipeline" }));
    expect(await optionsOf(user, byId("level-2-targets-0"))).toEqual(["traces/tertiary"]);
    await pickIn(user, byId("level-2-targets-0"), "traces/tertiary");

    expect(levels()).toEqual([["traces/primary"], ["traces/secondary"], ["traces/tertiary"]]);
    expect(receiversOf("traces/tertiary")).toEqual(["otlp", "failover"]);
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual(["Added failover to the receivers of traces/tertiary."]);
    expect(cardOf("Priority 3")).toHaveTextContent("traces/tertiary");
  });

  it("selecting a pipeline for a held row updates that level only, and doesn't offer a pipeline another level claims", async () => {
    const user = renderForm(FAILOVER, FAILOVER_TEXT);
    await user.click(within(cardOf("Priority 2")).getByRole("button", { name: "Add Pipeline" }));
    const trigger = byId("level-1-targets-1");
    expect(trigger).toHaveTextContent("Select pipeline");
    // traces/primary is claimed by level 1, so level 2 must not offer it.
    expect(await optionsOf(user, trigger)).toEqual(["traces/tertiary"]);
    await pickIn(user, trigger, "traces/tertiary");
    expect(levels()).toEqual([["traces/primary"], ["traces/secondary", "traces/tertiary"]]);
    expect(receiversOf("traces/tertiary")).toEqual(["otlp", "failover"]);
  });

  it("removing a level drops it from priority_levels and the connector from the receivers of what only it named", async () => {
    const user = renderForm(FAILOVER, FAILOVER_TEXT);
    await user.click(screen.getAllByRole("button", { name: /Remove priority level/i })[0]!);
    expect(levels()).toEqual([["traces/secondary"]]);
    expect(receiversOf("traces/primary")).toEqual(["otlp"]);
    expect(infoToasts()).toEqual(["Removed failover from the receivers of traces/primary."]);
    expect(entries()).toBe(1);
  });
});

describe("FailoverConnectorForm: levels and recovery", () => {
  it("a held level's Remove writes nothing; dragging a level moves its lines", async () => {
    layOutRows();
    const user = renderForm(FAILOVER, FAILOVER_TEXT);
    await user.click(screen.getByRole("button", { name: /Add Priority Level/i }));
    await user.click(within(cardOf("Priority 3")).getByRole("button", { name: "Remove priority level" }));
    expect(screen.queryByText("Priority 3")).toBeNull();
    expect(text()).toBe(FAILOVER_TEXT);

    const [first] = screen.getAllByRole("button", { name: "Drag to reorder" });
    await dragByKeyboard(first!, 1);
    expect(text()).toBe(FAILOVER_TEXT.replace("      - [traces/primary]\n      - [traces/secondary]\n", "      - [traces/secondary]\n      - [traces/primary]\n"));
    expect(infoToasts()).toEqual([]);
  });

  it("shows Retry Interval's default 10m, and the queue on while unset (the collector's, factory.go:30-35)", async () => {
    const user = renderForm(FAILOVER, FAILOVER_TEXT.replace("    retry_interval: 30s\n", ""));
    await openSection(user, "Recovery & Queue");
    expect(byId("failover-retry-interval")).toHaveValue("");
    expect(byId("failover-retry-interval")).toHaveAttribute("placeholder", "10m");
    expect(hint("How often the connector probes unhealthy higher-priority levels to fail back. · Default 10m")).toBeInTheDocument();
    expect(byId("queue-enable")).toBeChecked();
  });
});

describe("routing and failover keep a route's and a level's last pipeline", () => {
  it("a route's last target pipeline's Remove is disabled, with the hint; Default Pipelines' last one removes the key", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    const remove = within(cardOf("Route 1")).getByRole("button", { name: "Remove pipeline" });
    expect(remove).toBeDisabled();
    expect(hint(ROUTE_KEEPS_LAST_PIPELINE)).toBeInTheDocument();
    await user.click(remove);
    expect(text()).toBe(ROUTING_TEXT);

    // A held row beside it: the held row's own Remove stays, the last written one's doesn't.
    await user.click(within(cardOf("Route 1")).getByRole("button", { name: "Add Pipeline" }));
    const [written, heldRow] = within(cardOf("Route 1")).getAllByRole("button", { name: "Remove pipeline" });
    expect(written).toBeDisabled();
    expect(heldRow).toBeEnabled();

    // Two targets: both removable, no hint; the first removed leaves the other kept.
    await pickIn(user, byId("route-0-targets-1"), "traces/extra");
    expect(within(cardOf("Route 1")).getAllByRole("button", { name: "Remove pipeline" }).map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false]);
    expect(queryHint(ROUTE_KEEPS_LAST_PIPELINE)).toBeNull();
    await user.click(within(cardOf("Route 1")).getAllByRole("button", { name: "Remove pipeline" })[0]!);
    expect(routeTargets()).toEqual(["traces/extra"]);
    expect(within(cardOf("Route 1")).getByRole("button", { name: "Remove pipeline" })).toBeDisabled();

    // Default Pipelines is unchanged: its last one takes the key with it.
    await openSection(user, "Fallback & Errors");
    const defaults = screen.getByText("Default Pipelines", { selector: "label" }).parentElement!;
    const removeDefault = within(defaults).getByRole("button", { name: "Remove pipeline" });
    expect(removeDefault).toBeEnabled();
    await user.click(removeDefault);
    expect(routingValue().default_pipelines).toBeUndefined();
    expect(text()).not.toContain("default_pipelines");
  });

  it("a level's last pipeline's Remove is disabled, with the hint; a level of two removes either", async () => {
    const user = renderForm(FAILOVER, FAILOVER_TEXT);
    const removes = () => screen.getAllByRole("button", { name: "Remove pipeline" }).map((b) => (b as HTMLButtonElement).disabled);
    expect(removes()).toEqual([true, true]);
    expect(screen.getAllByText(LEVEL_KEEPS_LAST_PIPELINE, { selector: "p" })).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Remove pipeline" })[0]!);
    expect(text()).toBe(FAILOVER_TEXT);

    await user.click(within(cardOf("Priority 2")).getByRole("button", { name: "Add Pipeline" }));
    await pickIn(user, byId("level-1-targets-1"), "traces/tertiary");
    expect(removes()).toEqual([true, false, false]);
    expect(screen.getAllByText(LEVEL_KEEPS_LAST_PIPELINE, { selector: "p" })).toHaveLength(1);
    await user.click(within(cardOf("Priority 2")).getAllByRole("button", { name: "Remove pipeline" })[1]!);
    expect(levels()).toEqual([["traces/primary"], ["traces/secondary"]]);
    expect(removes()).toEqual([true, true]);
  });
});

describe("routing's and failover's empty alerts while a card is held; the route toggle", () => {
  it("No routes configured hides while a route is held, and comes back when it is removed", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT.replace(/ {4}table:\n[\s\S]*?\nservice:/, "    table: []\nservice:"));
    expect(screen.getByText("No routes configured")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Route" }));
    expect(screen.queryByText("No routes configured")).toBeNull();
    await user.click(within(cardOf("Route 1")).getByRole("button", { name: "Remove route" }));
    expect(screen.getByText("No routes configured")).toBeInTheDocument();
  });

  it("No priority levels configured hides while a level is held, and comes back when it is removed", async () => {
    const user = renderForm(FAILOVER, FAILOVER_TEXT.replace("    priority_levels:\n      - [traces/primary]\n      - [traces/secondary]\n", "    priority_levels: []\n"));
    expect(screen.getByText("No priority levels configured")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Priority Level" }));
    expect(screen.queryByText("No priority levels configured")).toBeNull();
    await user.click(within(cardOf("Priority 1")).getByRole("button", { name: "Remove priority level" }));
    expect(screen.getByText("No priority levels configured")).toBeInTheDocument();
  });

  it("a route's toggle says whether it is expanded (aria-expanded)", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    const toggle = within(cardOf("Route 1")).getByRole("button", { name: /Route 1/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

// ── Load balancing ──

const LB_ABSENT = `receivers:
  otlp:
    protocols:
      grpc:
exporters:
  loadbalancing:
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [loadbalancing]
`;

describe("LoadBalancingExporterForm", () => {
  it("doesn't crash on an absent resolver or protocol: they show unset, and a choice writes them", async () => {
    const user = renderForm(LB, LB_ABSENT);
    expect(byId("lb-resolver-type")).toHaveTextContent("");
    await pickIn(user, byId("lb-resolver-type"), "Static (Fixed Endpoints)");
    expect(valueOf(LB).resolver).toEqual({ static: { hostnames: ["localhost:4317"] } });
    expect(infoToasts()).toEqual([]);

    await openSection(user, "OTLP Protocol");
    await typeInto(user, byId("lb-protocol-timeout"), "2s");
    expect(valueOf(LB).protocol).toEqual({ otlp: { timeout: "2s" } });
  });

  it("switching the resolver removes the other's block and writes the seed, one entry, with the toast", async () => {
    const user = renderForm(LB);
    await pickIn(user, byId("lb-resolver-type"), "DNS (Dynamic Discovery)");
    expect((valueOf(LB).resolver as Value)).toEqual({
      dns: { hostname: "otel-collectors.example.com", port: "4317", interval: "5s", timeout: "1s" },
    });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([removedResolverMessage("static")]);
    expect(infoToasts()).toEqual(["Removed the static resolver's settings: the collector takes one resolver. Undo to restore them."]);
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("with several resolvers (refused, loadbalancer.go:63-65) the first shows; another removes them all, each named in the toast", async () => {
    const several = LB_ABSENT.replace(
      "  loadbalancing:\n",
      "  loadbalancing:\n    resolver:\n      static:\n        hostnames: [a:4317]\n      aws_cloud_map:\n        namespace: ns\n",
    );
    const user = renderForm(LB, several);
    expect(byId("lb-resolver-type")).toHaveTextContent("Static (Fixed Endpoints)");
    await pickIn(user, byId("lb-resolver-type"), "Kubernetes (K8s Service)");
    expect(valueOf(LB).resolver).toEqual({ k8s: { service: "otel-collector.monitoring", ports: [4317], timeout: "1s" } });
    expect(infoToasts()).toEqual([
      "Removed the static resolver's settings: the collector takes one resolver. Undo to restore them. Removed the AWS Cloud Map resolver's settings: the collector takes one resolver. Undo to restore them.",
    ]);
    expect(entries()).toBe(1);
  });

  it("Custom Attributes is held until its first attribute, then written with it in one change", async () => {
    const user = renderForm(LB);
    await pickIn(user, byId("lb-routing-key"), "Custom Attributes");
    expect(text()).toBe(CORPUS);
    expect(byId("lb-routing-key")).toHaveTextContent("Custom Attributes");
    const row = screen.getByPlaceholderText("e.g. span.kind");
    await user.type(row, "tenant.id");
    await user.tab();

    expect(valueOf(LB).routing_key).toBe("attributes");
    expect(valueOf(LB).routing_attributes).toEqual(["tenant.id"]);
    expect(entries()).toBe(1);
    // The last attribute can't be removed while routing_key is attributes.
    expect(within(fieldOf("Routing Attributes")).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(hint(LAST_ATTRIBUTE_HINT)).toBeInTheDocument();
  });

  it("another key chosen drops the hold, writing only the key", async () => {
    const user = renderForm(LB);
    await pickIn(user, byId("lb-routing-key"), "Custom Attributes");
    await pickIn(user, byId("lb-routing-key"), "Trace ID (traces, logs)");
    expect(valueOf(LB).routing_key).toBe("traceID");
    expect(valueOf(LB)).not.toHaveProperty("routing_attributes");
    expect(screen.queryByPlaceholderText("e.g. span.kind")).toBeNull();
    expect(infoToasts()).toEqual([]);
  });

  it("switching away from attributes removes routing_attributes, one entry, with the toast (config.go:70-72)", async () => {
    const user = renderForm(LB_K8S);
    expect(within(fieldOf("Routing Attributes")).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(hint(LAST_ATTRIBUTE_HINT)).toBeInTheDocument();
    await pickIn(user, byId("lb-routing-key"), "Service Name");
    expect(text()).toBe(CORPUS.replace("    routing_key: attributes\n    routing_attributes: [tenant.id]\n", "    routing_key: service\n"));
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([REMOVED_ROUTING_ATTRIBUTES]);
    expect(REMOVED_ROUTING_ATTRIBUTES).toBe("Removed routing_attributes: they're only used with the attributes routing key.");
  });

  it("a second attribute can be removed; then the last can't", async () => {
    const user = renderForm(LB_K8S);
    await user.click(screen.getByRole("button", { name: "Add Attribute" }));
    const rows = screen.getAllByPlaceholderText("e.g. span.kind");
    await user.type(rows[1]!, "span.kind");
    await user.tab();
    expect(valueOf(LB_K8S).routing_attributes).toEqual(["tenant.id", "span.kind"]);
    expect(queryHint(LAST_ATTRIBUTE_HINT)).toBeNull();
    await user.click(within(fieldOf("Routing Attributes")).getAllByRole("button", { name: "Remove" })[0]!);
    expect(valueOf(LB_K8S).routing_attributes).toEqual(["span.kind"]);
    expect(within(fieldOf("Routing Attributes")).getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("Kubernetes ports: Add holds a row; a port typed is written plain; the last removed takes the key (each backend then 4317)", async () => {
    const user = renderForm(LB_K8S);
    await user.click(screen.getByRole("button", { name: "Add Port" }));
    expect(text()).toBe(CORPUS);
    const rows = screen.getAllByPlaceholderText("4317");
    await user.type(rows[2]!, "17317");
    await user.tab();
    expect(text()).toContain("        ports: [15317, 16317, 17317]\n");
    const removePort = (index: number) => within(fieldOf("Ports")).getAllByRole("button", { name: "Remove" })[index]!;
    await user.click(removePort(2));
    expect(text()).toContain("        ports: [15317, 16317]\n");
    await user.click(removePort(1));
    await user.click(removePort(0));
    expect(((valueOf(LB_K8S).resolver as Value).k8s as Value)).not.toHaveProperty("ports");
  });

  it("the last static endpoint can't be removed; Add Endpoint holds a row (resolver_static.go:36-37)", async () => {
    const user = renderForm(LB, LB_ABSENT.replace("  loadbalancing:\n", "  loadbalancing:\n    resolver:\n      static:\n        hostnames: [a:4317]\n"));
    const endpoints = () => within(fieldOf("Backend Endpoints")).getAllByRole("button", { name: "Remove" });
    expect(endpoints()[0]).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add Endpoint" }));
    expect(endpoints()[1]).toBeEnabled();
    expect(entries()).toBe(0);
  });

  it("shows the collector's defaults: the routing key per signal, timeouts 5s and 1m, top-level retry and queue off, the protocol's on", async () => {
    const user = renderForm(LB_K8S, CORPUS.replace("    retry_on_failure:\n      enabled: true\n      initial_interval: 5s\n", ""));
    cleanup();
    useEditorStore.setState(initialState, true);
    const lb = renderForm(LB);
    expect(byId("lb-routing-key")).toHaveTextContent("");
    expect(hint("traceID keeps every span of a trace on one backend. · Default traceID (traces), service (metrics, logs)")).toBeInTheDocument();
    await openSection(lb, "OTLP Protocol");
    expect(hint("Per-request timeout for each backend. · Default 5s")).toBeInTheDocument();
    expect(byId("retry-enable")).toBeChecked();
    expect(byId("queue-enable")).toBeChecked();
    await openSection(lb, "Advanced");
    expect(byId("lb-retry-enable")).not.toBeChecked();
    expect(byId("lb-queue-enable")).not.toBeChecked();
    expect(hint("Load-balancer-level timeout. Applied after the protocol settings; both apply. · Default disabled")).toBeInTheDocument();

    // Ticking the top-level retry writes its block.
    await lb.click(byId("lb-retry-enable"));
    expect(valueOf(LB).retry_on_failure).toEqual({ enabled: true, initial_interval: "5s", max_interval: "30s", max_elapsed_time: "300s", multiplier: 1.5 });
    void user;

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(LB_K8S);
    expect(hint("Kubernetes API timeout. · Default 1m")).toBeInTheDocument();
    expect(hint("Each port creates a separate backend per pod. · Default 4317")).toBeInTheDocument();
  });

  it("offers the routing keys with the signals that take them, randomness included, and the corrected copy", async () => {
    const user = renderForm(LB);
    expect(await optionsOf(user, byId("lb-routing-key"))).toEqual([
      "Trace ID (traces, logs)",
      "Service Name",
      "Custom Attributes",
      "Metric Name (metrics only)",
      "Resource Attributes (metrics, logs)",
      "Stream ID (metrics only)",
      "Randomness (traces only)",
    ]);
    await openSection(user, "OTLP Protocol");
    expect(screen.getByText("Disable TLS (plaintext, insecure)")).toBeInTheDocument();
    expect(screen.queryByText("Skip TLS Verification (insecure)")).toBeNull();
    expect(screen.getByText("A persistent queue (storage) isn't supported here; set it on the top-level queue.")).toBeInTheDocument();
    expect(screen.queryByText("Shared queue storage")).toBeNull();
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(LB_K8S);
    expect(
      hint("Supports pseudo-attributes: span.kind, span.name (traces); log.severity, log.body (logs)."),
    ).toBeInTheDocument();
  });

  it("each section's ids are its own: the protocol's and the top level's retry and queue apart", async () => {
    const user = renderForm(LB);
    await openSection(user, "OTLP Protocol");
    await openSection(user, "Advanced");
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["retry-enable", "queue-enable", "lb-retry-enable", "lb-queue-enable"]) expect(ids).toContain(id);
  });
});

// ── Privacy ──

describe("privacy", () => {
  beforeEach(layOutRows);

  it("puts no config value or pipeline name in any attribute: every section and card open, the menus open, drags in progress", async () => {
    const MARK = "zq-mark";
    const marked = [
      "receivers:",
      "  otlp:",
      "exporters:",
      "  debug:",
      "  loadbalancing:",
      `    routing_key: ${MARK}-key`,
      `    routing_attributes: [${MARK}-attr]`,
      `    timeout: ${MARK}-timeout`,
      "    protocol:",
      "      otlp:",
      `        timeout: ${MARK}-ptimeout`,
      `        compression: ${MARK}-compression`,
      `        headers: {${MARK}-h: ${MARK}-v}`,
      "    resolver:",
      "      k8s:",
      `        service: ${MARK}-service`,
      `        ports: [${MARK}-port]`,
      `        timeout: ${MARK}-ktimeout`,
      "connectors:",
      "  routing:",
      `    error_mode: ${MARK}-mode`,
      `    default_pipelines: [traces/${MARK}-a, traces/${MARK}-gone]`,
      "    table:",
      `      - context: ${MARK}-context`,
      `        statement: ${MARK}-statement`,
      `        action: ${MARK}-action`,
      `        pipelines: [traces/${MARK}-b]`,
      `      - condition: ${MARK}-condition`,
      `        pipelines: [traces/${MARK}-a]`,
      "  failover:",
      `    priority_levels: [[traces/${MARK}-a], [traces/${MARK}-b, traces/${MARK}-gone]]`,
      `    retry_interval: ${MARK}-retry`,
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [routing, failover, loadbalancing]",
      `    traces/${MARK}-a:`,
      "      receivers: [routing, failover]",
      "      exporters: [debug]",
      `    traces/${MARK}-b:`,
      "      receivers: [routing, failover]",
      "      exporters: [debug]",
      `    traces/${MARK}-c:`,
      "      receivers: [otlp]",
      "      exporters: [debug]",
      "",
    ].join("\n");

    const leaks: string[] = [];
    const scan = (where: string) => {
      for (const element of document.querySelectorAll("*")) {
        // A controlled field's value property is its content, not an attribute: the replay masks inputs.
        for (const attribute of element.attributes) {
          if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${where}: ${element.tagName}[${attribute.name}]`);
        }
        // Option values (a native select's) are attributes too.
        if (element.tagName === "OPTION" && (element as HTMLOptionElement).value.includes(MARK)) leaks.push(`${where}: option value`);
      }
    };
    const shown = () => document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

    const runs: [string, readonly string[]][] = [
      [ROUTING, ["route-0-context", "route-0-action", "route-0-targets-0", "route-1-targets-0", "routing-default-pipelines-0", "routing-default-pipelines-1", "routing-error-mode"]],
      [FAILOVER, ["level-0-targets-0", "level-1-targets-0", "level-1-targets-1"]],
      [LB, ["lb-routing-key", "lb-protocol-compression", "lb-resolver-type"]],
    ];
    for (const [key, menus] of runs) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, marked);
      for (let round = 0; round < 3; round++) {
        for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      }
      for (const header of screen.queryAllByRole("button", { name: /^Route \d/ })) {
        if (!within(header.closest("div.rounded-md")!).queryByText("Context")) await user.click(header);
      }
      expect(shown()).toContain(`${MARK}-`);
      scan(key);

      // A held card and a held row, shown.
      const add = screen.queryByRole("button", { name: /^Add (Route|Priority Level)$/ });
      if (add) await user.click(add);
      scan(`${key} (held)`);

      for (const handle of screen.queryAllByRole("button", { name: "Drag to reorder" })) {
        act(() => handle.focus());
        await press(handle, " ", "Space");
        await press(handle, "ArrowDown");
        scan(`${key} (dragging)`);
        await press(handle, "Escape");
      }

      for (const menu of menus) {
        await user.click(byId(menu));
        expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
        scan(`${key} (${menu} menu)`);
        await user.keyboard("{Escape}");
      }
      expect(text()).toBe(marked);
      expect(entries()).toBe(0);
    }
    expect(leaks).toEqual([]);
  }, 30_000);
});

// ── The YAML box and other writes keep the held items' rules ──

describe("held items and the YAML box", () => {
  it("a held route goes when the YAML box changes its table's length", async () => {
    const user = renderForm(ROUTING, ROUTING_TEXT);
    await user.click(screen.getByRole("button", { name: "Add Route" }));
    expect(screen.getByText("Route 2")).toBeInTheDocument();
    const nodeId = componentNamed(ROUTING).id;
    act(() => {
      builderStore().setComponentValue(nodeId, componentValueText(text(), ROUTING).replace(/table:[\s\S]*$/, "table: []\n"));
    });
    expect(screen.queryByText("Route 2")).toBeNull();
  });
});
