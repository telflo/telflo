import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import { K8sClusterReceiverForm } from "./K8sClusterReceiverForm.js";
import { K8sEventsReceiverForm } from "./K8sEventsReceiverForm.js";
import {
  INITIAL_STATE_PULL_HINT,
  K8sObjectsReceiverForm,
  REMOVED_INITIAL_DELAY,
  REMOVED_INITIAL_STATE,
  REMOVED_WATCH_SETTINGS,
} from "./K8sObjectsReceiverForm.js";
import { KubeletStatsReceiverForm } from "./KubeletStatsReceiverForm.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The Kubernetes receivers' forms: the k8s_cluster, k8s_events, k8sobjects
 * and kubeletstats forms over the form contract. Each field is driven as a
 * person would (typing, clicking, picking, dragging by keyboard) on the
 * Kubernetes corpus text (comments, an anchor and merges, a flow list,
 * `0750`), LF and CRLF, and writes only its key: the text changes in that
 * key's lines only, and parses to the value. The fixes each have a test
 * that fails if the bug returns: held rows, k8sobjects' top-level Include
 * Initial State and its adjustments, kubeletstats' `tls` default, the
 * copy, the extra option.
 *
 * Collector claims cite contrib v0.162.0.
 */

const CORPUS = corpusText("forms-kubernetes.yaml");

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

/** The info toasts shown so far: the adjustments toast their messages. */
const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

const CLUSTER = "receivers.k8s_cluster";
const EVENTS = "receivers.k8s_events";
const OBJECTS = "receivers.k8sobjects";
const KUBELET = "receivers.kubeletstats";

const FORM_OF: Record<string, () => ReactNode> = {
  [CLUSTER]: () => <K8sClusterReceiverForm />,
  [EVENTS]: () => <K8sEventsReceiverForm />,
  [OBJECTS]: () => <K8sObjectsReceiverForm />,
  [KUBELET]: () => <KubeletStatsReceiverForm />,
};

function renderForm(key: string, text = CORPUS) {
  openText(text);
  const user = userEvent.setup();
  render(<ComponentForm nodeId={componentNamed(key).id}>{FORM_OF[key]!()}</ComponentForm>);
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
/** A hint line, by its whole text ("… · Default ignore" spans elements). */
const hint = (whole: string) =>
  screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
const queryHint = (whole: string) =>
  screen.queryByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
type Value = Record<string, unknown>;
const valueOf = (written: string, key: string): Value => {
  const [section, name] = key.split(".") as [string, string];
  return (parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>)[section]![name]!;
};
const objectsOf = (written: string) => valueOf(written, OBJECTS).objects as Value[];

/** Replaces `input`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, typed);
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
}

/** Expands a k8sobjects card by its header's text. */
async function openCard(user: UserEvent, header: string) {
  await user.click(screen.getByRole("button", { name: header }));
}

/** Adds a held row with `add`, types into it and leaves it. */
async function addRow(user: UserEvent, add: HTMLElement, placeholder: string, typed: string) {
  await user.click(add);
  const rows = screen.getAllByPlaceholderText(placeholder);
  await user.type(rows[rows.length - 1]!, typed);
  await user.tab();
}

// ── Sortable rows by keyboard ──

const ROW_HEIGHT = 40;

/** The sortable row an element is in: a child of a `space-y-*` list whose children all hold a drag handle. */
function rowOf(element: Element): HTMLElement | null {
  for (let e: HTMLElement | null = element as HTMLElement; e; e = e.parentElement) {
    const parent = e.parentElement;
    if (
      (parent?.classList.contains("space-y-2") || parent?.classList.contains("space-y-3")) &&
      [...parent.children].every((child) => child.querySelector('[aria-roledescription="sortable"]'))
    ) {
      return e;
    }
  }
  return null;
}

/** dnd-kit measures rows; jsdom's are all zero, so rows are laid out 40 px apart. */
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
  /** A variant of the corpus text (LF), when the case needs one. */
  base?: string;
}

/** The corpus with kubeletstats' own `auth_type` unset (no merge): the collector's `tls` shows. */
const KUBELET_UNSET_AUTH = CORPUS.replace("  kubeletstats:\n    <<: *k8s-auth\n", "  kubeletstats:\n");
/** The corpus with both objects watching: Include Initial State can be ticked. */
const OBJECTS_WATCHING = CORPUS.replace("        mode: pull\n        interval: 60m\n", "        mode: watch\n");

const CASES: FieldCase[] = [
  // k8s_cluster
  {
    name: "k8s_cluster Distribution (unset) is added under the component",
    key: CLUSTER,
    edit: (user) => pickIn(user, byId("distribution"), "OpenShift"),
    from: "    namespaces:\n      - default\n  k8s_events:\n",
    to: "    namespaces:\n      - default\n    distribution: openshift\n  k8s_events:\n",
    check: (v) => expect(v.distribution).toBe("openshift"),
  },
  {
    name: "k8s_cluster Collection Interval keeps its comment",
    key: CLUSTER,
    edit: (user) => retypeInto(user, byId("collection-interval"), "30s"),
    from: "    collection_interval: 10s # the default\n",
    to: "    collection_interval: 30s # the default\n",
    check: (v) => expect(v.collection_interval).toBe("30s"),
  },
  {
    name: "k8s_cluster Collection Interval cleared removes the key",
    key: CLUSTER,
    edit: (user) => retypeInto(user, byId("collection-interval"), ""),
    from: "    collection_interval: 10s # the default\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("collection_interval"),
  },
  {
    name: "k8s_cluster Metadata Collection Interval (unset)",
    key: CLUSTER,
    edit: (user) => retypeInto(user, byId("metadata-collection-interval"), "0"),
    from: "      - default\n  k8s_events:\n",
    to: "      - default\n    metadata_collection_interval: \"0\"\n  k8s_events:\n",
    check: (v) => expect(v.metadata_collection_interval).toBe("0"),
  },
  {
    name: "k8s_cluster a namespace retyped",
    key: CLUSTER,
    edit: async (user) => {
      await openSection(user, "Resources");
      await retypeInto(user, screen.getByDisplayValue("default"), "production");
    },
    from: "    namespaces:\n      - default\n",
    to: "    namespaces:\n      - production\n",
    check: (v) => expect(v.namespaces).toEqual(["production"]),
  },
  {
    name: "k8s_cluster Add Namespace holds the row; typing appends the item",
    key: CLUSTER,
    edit: async (user) => {
      await openSection(user, "Resources");
      await addRow(user, screen.getByRole("button", { name: "Add Namespace" }), "e.g. kube-system", "kube-system");
    },
    from: "    namespaces:\n      - default\n",
    to: "    namespaces:\n      - default\n      - kube-system\n",
    check: (v) => expect(v.namespaces).toEqual(["default", "kube-system"]),
  },
  {
    name: "k8s_cluster the last namespace removed leaves []",
    key: CLUSTER,
    edit: async (user) => {
      await openSection(user, "Resources");
      await user.click(screen.getByRole("button", { name: "Remove" }));
    },
    from: "    namespaces:\n      - default\n",
    to: "    namespaces: []\n",
    check: (v) => expect(v.namespaces).toEqual([]),
  },
  {
    name: "k8s_cluster a node condition ticked is appended to the flow list",
    key: CLUSTER,
    edit: async (user) => {
      await openSection(user, "Resources");
      await user.click(byId("condition-2"));
    },
    from: "    node_conditions_to_report: [Ready, MemoryPressure]\n",
    to: "    node_conditions_to_report: [Ready, MemoryPressure, DiskPressure]\n",
    check: (v) => expect(v.node_conditions_to_report).toEqual(["Ready", "MemoryPressure", "DiskPressure"]),
  },
  {
    name: "k8s_cluster a node condition unticked is removed",
    key: CLUSTER,
    edit: async (user) => {
      await openSection(user, "Resources");
      await user.click(byId("condition-0"));
    },
    from: "    node_conditions_to_report: [Ready, MemoryPressure]\n",
    to: "    node_conditions_to_report: [MemoryPressure]\n",
    check: (v) => expect(v.node_conditions_to_report).toEqual(["MemoryPressure"]),
  },
  {
    name: "k8s_cluster an allocatable type ticked is appended",
    key: CLUSTER,
    edit: async (user) => {
      await openSection(user, "Resources");
      await user.click(byId("allocatable-3"));
    },
    from: "      - cpu # millicores\n      - memory\n",
    to: "      - cpu # millicores\n      - memory\n      - pods\n",
    check: (v) => expect(v.allocatable_types_to_report).toEqual(["cpu", "memory", "pods"]),
  },
  {
    name: "k8s_cluster an allocatable type unticked removes its line, comment and all",
    key: CLUSTER,
    edit: async (user) => {
      await openSection(user, "Resources");
      await user.click(byId("allocatable-0"));
    },
    from: "      - cpu # millicores\n",
    to: "",
    check: (v) => expect(v.allocatable_types_to_report).toEqual(["memory"]),
  },
  {
    name: "k8s_cluster Add Metadata Exporter holds the row; typing appends to the flow list",
    key: CLUSTER,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await addRow(user, screen.getByRole("button", { name: "Add Metadata Exporter" }), "e.g. signalfx", "signalfx");
    },
    from: "    metadata_exporters: [otlp]\n",
    to: "    metadata_exporters: [otlp, signalfx]\n",
    check: (v) => expect(v.metadata_exporters).toEqual(["otlp", "signalfx"]),
  },
  {
    name: "k8s_cluster Leader Elector Extension (unset)",
    key: CLUSTER,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await retypeInto(user, byId("leader-elector"), "k8s_leader_elector");
    },
    from: "      - default\n  k8s_events:\n",
    to: "      - default\n    k8s_leader_elector: k8s_leader_elector\n  k8s_events:\n",
    check: (v) => expect(v.k8s_leader_elector).toBe("k8s_leader_elector"),
  },

  // k8s_events
  {
    name: "k8s_events a namespace retyped in the flow list",
    key: EVENTS,
    edit: (user) => retypeInto(user, screen.getByDisplayValue("kube-system"), "monitoring"),
    from: "    namespaces: [default, kube-system]\n",
    to: "    namespaces: [default, monitoring]\n",
    check: (v) => expect(v.namespaces).toEqual(["default", "monitoring"]),
  },
  {
    name: "k8s_events Add Namespace holds the row; typing appends the item",
    key: EVENTS,
    edit: (user) => addRow(user, screen.getByRole("button", { name: "Add Namespace" }), "e.g. kube-system", "monitoring"),
    from: "    namespaces: [default, kube-system]\n",
    to: "    namespaces: [default, kube-system, monitoring]\n",
    check: (v) => expect(v.namespaces).toEqual(["default", "kube-system", "monitoring"]),
  },
  {
    name: "k8s_events Remove namespace removes the item",
    key: EVENTS,
    edit: (user) => user.click(screen.getAllByRole("button", { name: "Remove namespace" })[0]!),
    from: "    namespaces: [default, kube-system]\n",
    to: "    namespaces: [kube-system]\n",
    check: (v) => expect(v.namespaces).toEqual(["kube-system"]),
  },
  {
    name: "k8s_events Leader Elector Extension (unset)",
    key: EVENTS,
    edit: async (user) => {
      await openSection(user, "Advanced: Leader Election");
      await retypeInto(user, byId("leader-elector"), "k8s_leader_elector/events");
    },
    from: "    namespaces: [default, kube-system]\n",
    to: "    namespaces: [default, kube-system]\n    k8s_leader_elector: k8s_leader_elector/events\n",
    check: (v) => expect(v.k8s_leader_elector).toBe("k8s_leader_elector/events"),
  },

  // k8sobjects
  {
    name: "k8sobjects Error Mode (unset)",
    key: OBJECTS,
    edit: (user) => pickIn(user, byId("error-mode"), "Ignore (log and continue)"),
    from: "        namespaces: [default]\n  kubeletstats:\n",
    to: "        namespaces: [default]\n    error_mode: ignore\n  kubeletstats:\n",
    check: (v) => expect(v.error_mode).toBe("ignore"),
  },
  {
    name: "k8sobjects Resource Type",
    key: OBJECTS,
    edit: async (user) => {
      await openCard(user, "Object #1: pods (pull)");
      await pickIn(user, byId("obj-0-name"), "nodes");
    },
    from: "      - name: pods\n",
    to: "      - name: nodes\n",
    check: (v) => expect((v.objects as Value[])[0]!.name).toBe("nodes"),
  },
  {
    name: "k8sobjects Pull Interval",
    key: OBJECTS,
    edit: async (user) => {
      await openCard(user, "Object #1: pods (pull)");
      await retypeInto(user, byId("obj-0-interval"), "30m");
    },
    from: "        interval: 60m\n",
    to: "        interval: 30m\n",
    check: (v) => expect((v.objects as Value[])[0]!.interval).toBe("30m"),
  },
  {
    name: "k8sobjects Collection Mode pull -> watch removes interval",
    key: OBJECTS,
    edit: async (user) => {
      await openCard(user, "Object #1: pods (pull)");
      await pickIn(user, byId("obj-0-mode"), "Watch");
    },
    from: "        mode: pull\n        interval: 60m\n",
    to: "        mode: watch\n",
    check: (v) => expect((v.objects as Value[])[0]).toEqual({ name: "pods", mode: "watch", label_selector: "environment in (production)" }),
  },
  {
    name: "k8sobjects Collection Mode watch -> pull writes interval: 60m",
    key: OBJECTS,
    edit: async (user) => {
      await openCard(user, "Object #2: events (watch)");
      await pickIn(user, byId("obj-1-mode"), "Pull");
    },
    from: "        mode: watch\n        namespaces: [default]\n",
    to: "        mode: pull\n        namespaces: [default]\n        interval: 60m\n",
    check: (v) => expect((v.objects as Value[])[1]).toEqual({ name: "events", mode: "pull", namespaces: ["default"], interval: "60m" }),
  },
  {
    name: "k8sobjects Label Selector",
    key: OBJECTS,
    edit: async (user) => {
      await openCard(user, "Object #1: pods (pull)");
      await retypeInto(user, byId("obj-0-label-selector"), "tier=web");
    },
    from: "        label_selector: environment in (production)\n",
    to: "        label_selector: tier=web\n",
    check: (v) => expect((v.objects as Value[])[0]!.label_selector).toBe("tier=web"),
  },
  {
    name: "k8sobjects Field Selector (unset) is added to its object",
    key: OBJECTS,
    edit: async (user) => {
      await openCard(user, "Object #1: pods (pull)");
      await retypeInto(user, byId("obj-0-field-selector"), "status.phase=Running");
    },
    from: "        label_selector: environment in (production)\n",
    to: "        label_selector: environment in (production)\n        field_selector: status.phase=Running\n",
    check: (v) => expect((v.objects as Value[])[0]!.field_selector).toBe("status.phase=Running"),
  },
  {
    name: "k8sobjects API Group (unset)",
    key: OBJECTS,
    edit: async (user) => {
      await openCard(user, "Object #2: events (watch)");
      await retypeInto(user, byId("obj-1-group"), "events.k8s.io");
    },
    from: "        namespaces: [default]\n",
    to: "        namespaces: [default]\n        group: events.k8s.io\n",
    check: (v) => expect((v.objects as Value[])[1]!.group).toBe("events.k8s.io"),
  },
  {
    name: "k8sobjects an object's Add Namespace holds the row; typing appends the item",
    key: OBJECTS,
    edit: async (user) => {
      await openCard(user, "Object #2: events (watch)");
      await addRow(user, screen.getByRole("button", { name: "Add Namespace" }), "e.g. default", "kube-system");
    },
    from: "        namespaces: [default]\n",
    to: "        namespaces: [default, kube-system]\n",
    check: (v) => expect((v.objects as Value[])[1]!.namespaces).toEqual(["default", "kube-system"]),
  },
  {
    name: "k8sobjects an object's Remove namespace",
    key: OBJECTS,
    edit: async (user) => {
      await openCard(user, "Object #2: events (watch)");
      await user.click(screen.getByRole("button", { name: "Remove namespace" }));
    },
    from: "        namespaces: [default]\n",
    to: "        namespaces: []\n",
    check: (v) => expect((v.objects as Value[])[1]!.namespaces).toEqual([]),
  },
  {
    name: "k8sobjects Exclude Watch Event Types (unset) writes the one ticked",
    key: OBJECTS,
    edit: async (user) => {
      await openSection(user, "Watch Options");
      await user.click(byId("obj-1-exclude-2"));
    },
    from: "        namespaces: [default]\n",
    to: "        namespaces: [default]\n        exclude_watch_type:\n          - DELETED\n",
    check: (v) => expect((v.objects as Value[])[1]!.exclude_watch_type).toEqual(["DELETED"]),
  },
  {
    name: "k8sobjects Resource Version (unset)",
    key: OBJECTS,
    edit: async (user) => {
      await openSection(user, "Watch Options");
      await retypeInto(user, byId("obj-1-resource-version"), "12345");
    },
    from: "        namespaces: [default]\n",
    to: "        namespaces: [default]\n        resource_version: \"12345\"\n",
    check: (v) => expect((v.objects as Value[])[1]!.resource_version).toBe("12345"),
  },
  {
    name: "k8sobjects Include Initial State is written at the top level",
    key: OBJECTS,
    base: OBJECTS_WATCHING,
    edit: async (user) => {
      await openSection(user, "Watch Options");
      await user.click(byId("include-initial-state"));
    },
    from: "        namespaces: [default]\n  kubeletstats:\n",
    to: "        namespaces: [default]\n    include_initial_state: true\n  kubeletstats:\n",
    check: (v) => {
      expect(v.include_initial_state).toBe(true);
      for (const object of v.objects as Value[]) expect(object).not.toHaveProperty("include_initial_state");
    },
  },
  {
    name: "k8sobjects Add Object appends the seeded object",
    key: OBJECTS,
    edit: (user) => user.click(screen.getByRole("button", { name: "Add Object" })),
    from: "        namespaces: [default]\n",
    to: "        namespaces: [default]\n      - name: pods\n        mode: pull\n        interval: 60m\n",
    check: (v) => expect((v.objects as Value[])[2]).toEqual({ name: "pods", mode: "pull", interval: "60m" }),
  },
  {
    name: "k8sobjects Remove object removes its lines, comment and all",
    key: OBJECTS,
    edit: (user) => user.click(screen.getAllByRole("button", { name: "Remove object" })[1]!),
    from: "      - name: events # watched\n        mode: watch\n        namespaces: [default]\n",
    to: "",
    check: (v) => expect((v.objects as Value[]).map((o) => o.name)).toEqual(["pods"]),
  },
  {
    name: "k8sobjects Leader Elector Extension (unset)",
    key: OBJECTS,
    edit: async (user) => {
      await openSection(user, "Deployment & RBAC");
      await retypeInto(user, byId("leader-elector"), "k8s_leader_elector");
    },
    from: "        namespaces: [default]\n  kubeletstats:\n",
    to: "        namespaces: [default]\n    k8s_leader_elector: k8s_leader_elector\n  kubeletstats:\n",
    check: (v) => expect(v.k8s_leader_elector).toBe("k8s_leader_elector"),
  },

  // kubeletstats
  {
    name: "kubeletstats Endpoint",
    key: KUBELET,
    edit: (user) => retypeInto(user, byId("endpoint"), "https://node:10250"),
    from: "    endpoint: https://${env:K8S_NODE_NAME}:10250\n",
    to: "    endpoint: https://node:10250\n",
    check: (v) => expect(v.endpoint).toBe("https://node:10250"),
  },
  {
    name: "kubeletstats Collection Interval",
    key: KUBELET,
    edit: (user) => retypeInto(user, byId("collection-interval"), "1m30s"),
    from: "    collection_interval: 20s\n",
    to: "    collection_interval: 1m30s\n",
    check: (v) => expect(v.collection_interval).toBe("1m30s"),
  },
  {
    name: "kubeletstats Initial Delay (unset)",
    key: KUBELET,
    edit: (user) => retypeInto(user, byId("initial-delay"), "5s"),
    from: "      - container.id\nprocessors:\n",
    to: "      - container.id\n    initial_delay: 5s\nprocessors:\n",
    check: (v) => expect(v.initial_delay).toBe("5s"),
  },
  {
    name: "kubeletstats Node Name (unset) written as typed, a reference",
    key: KUBELET,
    edit: (user) => retypeInto(user, byId("node"), "${{env:K8S_NODE_NAME}"),
    from: "      - container.id\nprocessors:\n",
    to: "      - container.id\n    node: ${env:K8S_NODE_NAME}\nprocessors:\n",
    check: (v) => expect(v.node).toBe("${env:K8S_NODE_NAME}"),
  },
  {
    name: "kubeletstats Skip TLS Verification (serviceAccount, from the merge) unticked writes false",
    key: KUBELET,
    edit: async (user) => {
      await openSection(user, "Authentication");
      await user.click(byId("insecure-skip-verify"));
    },
    from: "    insecure_skip_verify: true\n",
    to: "    insecure_skip_verify: false\n",
    check: (v) => expect(v.insecure_skip_verify).toBe(false),
  },
  {
    name: "kubeletstats CA File (serviceAccount)",
    key: KUBELET,
    edit: async (user) => {
      await openSection(user, "Authentication");
      await retypeInto(user, byId("ca-file"), "/etc/ca.crt");
    },
    from: "      - container.id\nprocessors:\n",
    to: "      - container.id\n    ca_file: /etc/ca.crt\nprocessors:\n",
    check: (v) => expect(v.ca_file).toBe("/etc/ca.crt"),
  },
  {
    name: "kubeletstats Client Certificate File (auth_type unset: tls)",
    key: KUBELET,
    base: KUBELET_UNSET_AUTH,
    edit: (user) => retypeInto(user, byId("cert-file"), "/certs/client.crt"),
    from: "      - container.id\nprocessors:\n",
    to: "      - container.id\n    cert_file: /certs/client.crt\nprocessors:\n",
    check: (v) => expect(v.cert_file).toBe("/certs/client.crt"),
  },
  {
    name: "kubeletstats Client Key File (auth_type unset: tls)",
    key: KUBELET,
    base: KUBELET_UNSET_AUTH,
    edit: (user) => retypeInto(user, byId("key-file"), "/certs/client.key"),
    from: "      - container.id\nprocessors:\n",
    to: "      - container.id\n    key_file: /certs/client.key\nprocessors:\n",
    check: (v) => expect(v.key_file).toBe("/certs/client.key"),
  },
  {
    name: "kubeletstats CA File (auth_type unset: tls)",
    key: KUBELET,
    base: KUBELET_UNSET_AUTH,
    edit: (user) => retypeInto(user, byId("ca-file-tls"), "/certs/ca.crt"),
    from: "      - container.id\nprocessors:\n",
    to: "      - container.id\n    ca_file: /certs/ca.crt\nprocessors:\n",
    check: (v) => expect(v.ca_file).toBe("/certs/ca.crt"),
  },
  {
    name: "kubeletstats Skip TLS Verification (auth_type unset: tls)",
    key: KUBELET,
    base: KUBELET_UNSET_AUTH,
    edit: (user) => user.click(byId("insecure-skip-verify-tls")),
    from: "    insecure_skip_verify: true\n",
    to: "    insecure_skip_verify: false\n",
    check: (v) => expect(v.insecure_skip_verify).toBe(false),
  },
  {
    name: "kubeletstats Authentication Type picked (auth_type unset)",
    key: KUBELET,
    base: KUBELET_UNSET_AUTH,
    edit: (user) => pickIn(user, byId("auth-type"), "Kube Config"),
    from: "      - container.id\nprocessors:\n",
    to: "      - container.id\n    auth_type: kubeConfig\nprocessors:\n",
    check: (v) => expect(v.auth_type).toBe("kubeConfig"),
  },
  {
    name: "kubeletstats a metric group ticked is appended to the flow list",
    key: KUBELET,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await user.click(byId("metric-group-3"));
    },
    from: "    metric_groups: [node, pod, container]\n",
    to: "    metric_groups: [node, pod, container, volume]\n",
    check: (v) => expect(v.metric_groups).toEqual(["node", "pod", "container", "volume"]),
  },
  {
    name: "kubeletstats a metric group unticked is removed",
    key: KUBELET,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await user.click(byId("metric-group-2"));
    },
    from: "    metric_groups: [node, pod, container]\n",
    to: "    metric_groups: [pod, container]\n",
    check: (v) => expect(v.metric_groups).toEqual(["pod", "container"]),
  },
  {
    name: "kubeletstats an extra metadata label ticked is appended",
    key: KUBELET,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await user.click(byId("extra-label-1"));
    },
    from: "      - container.id\n",
    to: "      - container.id\n      - k8s.volume.type\n",
    check: (v) => expect(v.extra_metadata_labels).toEqual(["container.id", "k8s.volume.type"]),
  },
  {
    name: "kubeletstats Collect All Pod Network Interfaces (unset)",
    key: KUBELET,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await user.click(byId("collect-pod-interfaces"));
    },
    from: "      - container.id\nprocessors:\n",
    to: "      - container.id\n    collect_all_network_interfaces:\n      pod: true\nprocessors:\n",
    check: (v) => expect(v.collect_all_network_interfaces).toEqual({ pod: true }),
  },
  {
    name: "kubeletstats Enable Kubernetes API Access writes its block",
    key: KUBELET,
    edit: async (user) => {
      await openSection(user, "Kubernetes API");
      await user.click(byId("enable-k8s-api"));
    },
    from: "      - container.id\nprocessors:\n",
    to: "      - container.id\n    k8s_api_config:\n      auth_type: serviceAccount\nprocessors:\n",
    check: (v) => expect(v.k8s_api_config).toEqual({ auth_type: "serviceAccount" }),
  },
];

describe("every field of each form writes only its key", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const lf = c.base ?? CORPUS;
      const before = crlf ? CRLF(lf) : lf;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      c.check(valueOf(text(), c.key));
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );
});

describe("merges, undo and opening", () => {
  it("a key a merge gives is set as the component's own key; the merge, the anchor and the others' merges stay", async () => {
    const user = renderForm(CLUSTER);
    // The merged auth_type shows as the text gives it.
    expect(byId("auth-type")).toHaveTextContent("Service Account (recommended)");

    await pickIn(user, byId("auth-type"), "Kube Config");

    expect(text()).toBe(CORPUS.replace("      - default\n  k8s_events:\n", "      - default\n    auth_type: kubeConfig\n  k8s_events:\n"));
    expect(valueOf(text(), CLUSTER).auth_type).toBe("kubeConfig");
    expect(valueOf(text(), EVENTS).auth_type).toBe("serviceAccount");
    expect(entries()).toBe(1);
  });

  it("each edit is one undo entry named after the component", async () => {
    const user = renderForm(KUBELET);
    await retypeInto(user, byId("collection-interval"), "30s");
    expect(selectUndoDescription(builderStore())).toMatch(/^Update /);
    expect(entries()).toBe(1);
  });

  // One test per form and text, each with its own time limit: together they took 2-5 s.
  const OPENING_TEXTS = [
    ["the corpus", CORPUS],
    ["the corpus in CRLF", CRLF(CORPUS)],
    ["kubeletstats with auth_type unset", KUBELET_UNSET_AUTH],
  ] as const;
  /** What each form shows once opened, at least, on the least of its texts: its text fields, every control, and a field each of its texts shows. */
  const OPENED: Record<string, { textboxes: number; all: number; field: string }> = {
    [CLUSTER]: { textboxes: 5, all: 16, field: "condition-0" },
    [EVENTS]: { textboxes: 3, all: 4, field: "leader-elector" },
    [OBJECTS]: { textboxes: 10, all: 22, field: "obj-0-name" },
    [KUBELET]: { textboxes: 5, all: 16, field: "metric-group-0" },
  };
  it.each([CLUSTER, EVENTS, OBJECTS, KUBELET].flatMap((key) => OPENING_TEXTS.map(([name, base]) => [key, name, base] as const)))(
    "opening %s on %s, every section and card, focusing every field, writes nothing and leaves the editor clean",
    async (key, _name, base) => {
      const user = renderForm(key, base);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      for (const header of screen.queryAllByRole("button", { name: /^Object #/ })) await user.click(header);
      // Opened, it shows the form's fields.
      const { textboxes, all } = formControls();
      expect(screen.queryAllByRole("button", { expanded: false })).toHaveLength(0);
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

describe("held rows never write an empty item", () => {
  it.each([
    ["k8s_cluster namespaces", CLUSTER, "Resources", "Add Namespace", "e.g. kube-system", "Remove"],
    ["k8s_cluster metadata exporters", CLUSTER, "Advanced", "Add Metadata Exporter", "e.g. signalfx", "Remove"],
    ["k8s_events namespaces", EVENTS, null, "Add Namespace", "e.g. kube-system", "Remove namespace"],
    ["k8sobjects an object's namespaces", OBJECTS, "Object #2: events (watch)", "Add Namespace", "e.g. default", "Remove namespace"],
  ] as const)("%s: Add writes nothing; a held row left empty or removed goes unwritten; a row emptied is removed", async (_name, key, open, add, placeholder, remove) => {
    const user = renderForm(key);
    if (open?.startsWith("Object #")) await openCard(user, open);
    else if (open) await openSection(user, open);
    const rows = () => screen.queryAllByPlaceholderText(placeholder) as HTMLInputElement[];
    const count = rows().length;

    await user.click(screen.getByRole("button", { name: add }));
    expect(rows()).toHaveLength(count + 1);
    expect(text()).toBe(CORPUS);
    // Left empty, it goes.
    await user.click(rows()[count]!);
    await user.tab();
    expect(rows()).toHaveLength(count);
    expect(text()).toBe(CORPUS);
    // Removed before anything is typed, it goes.
    await user.click(screen.getByRole("button", { name: add }));
    await user.click(screen.getAllByRole("button", { name: remove }).at(-1)!);
    expect(rows()).toHaveLength(count);
    expect(text()).toBe(CORPUS);
    expect(entries()).toBe(0);

    // A written row emptied and left is removed, never written "".
    await retypeInto(user, rows()[0]!, "");
    expect(text()).not.toContain('""');
    expect(rows()).toHaveLength(count - 1);
    expect(entries()).toBe(1);
  });

  // Its own time limit.
  it("a held row's typing is written after the pause, into the row it was typed in, with focus kept", async () => {
    const user = renderForm(EVENTS);
    await user.click(screen.getByRole("button", { name: "Add Namespace" }));
    const row = screen.getAllByPlaceholderText("e.g. kube-system")[2]!;
    await user.type(row, "monitoring");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(valueOf(text(), EVENTS).namespaces).toEqual(["default", "kube-system", "monitoring"]);
    expect(screen.getAllByPlaceholderText("e.g. kube-system")[2]).toBe(row);
    expect(document.activeElement).toBe(row);
  }, 20_000);
});

// ── k8sobjects: Include Initial State and its adjustments ──

/** Objects' own lines in the corpus. */
const PODS_OBJECT = "      - name: pods\n        mode: pull\n        interval: 60m\n        label_selector: environment in (production)\n";
const EVENTS_OBJECT = "      - name: events # watched\n        mode: watch\n        namespaces: [default]\n";
/** The corpus with a top-level include_initial_state: true beside a pulling object (refused, but a text may hold it). */
const INITIAL_STATE_ON = CORPUS.replace("  k8sobjects:\n    <<: *k8s-auth\n", "  k8sobjects:\n    <<: *k8s-auth\n    include_initial_state: true # snapshot\n");

describe("k8sobjects: Include Initial State is the receiver's, at the top level", () => {
  // receiver/k8sobjectsreceiver/config.go:66 (Config.IncludeInitialState); K8sObjectsConfig (config.go:43-57) has none.
  it("ticked, it writes include_initial_state at the top level, never in an object", async () => {
    const user = renderForm(OBJECTS, OBJECTS_WATCHING);
    await openSection(user, "Watch Options");
    expect(screen.getByLabelText("Include Initial State")).toBe(byId("include-initial-state"));
    expect(queryHint(INITIAL_STATE_PULL_HINT)).toBeNull();

    await user.click(byId("include-initial-state"));

    const written = valueOf(text(), OBJECTS);
    expect(written.include_initial_state).toBe(true);
    for (const object of written.objects as Value[]) expect(object).not.toHaveProperty("include_initial_state");
    expect(byId("include-initial-state")).toBeChecked();
    // One box, not one per watching object.
    expect(screen.getAllByRole("checkbox", { name: "Include Initial State" })).toHaveLength(1);
  });

  // config.go:125-127: refused with any pulling object; config.go:91-92: an object with no mode pulls.
  it.each([
    ["an object pulls", CORPUS],
    ["an object has no mode", OBJECTS_WATCHING.replace("      - name: pods\n        mode: watch\n", "      - name: pods\n")],
  ])("can't be ticked while %s, with the hint", async (_name, base) => {
    const user = renderForm(OBJECTS, base);
    await openSection(user, "Watch Options");
    expect(byId("include-initial-state")).toBeDisabled();
    expect(byId("include-initial-state")).not.toBeChecked();
    expect(hint(INITIAL_STATE_PULL_HINT)).toBeInTheDocument();
    await user.click(byId("include-initial-state"));
    expect(text()).toBe(base);
  });

  it("a text with it ticked and an object pulling shows it ticked, and it can be unticked", async () => {
    const user = renderForm(OBJECTS, INITIAL_STATE_ON);
    await openSection(user, "Watch Options");
    expect(byId("include-initial-state")).toBeChecked();
    expect(byId("include-initial-state")).toBeEnabled();
    expect(hint(INITIAL_STATE_PULL_HINT)).toBeInTheDocument();

    await user.click(byId("include-initial-state"));

    expect(text()).toBe(INITIAL_STATE_ON.replace("    include_initial_state: true # snapshot\n", "    include_initial_state: false # snapshot\n"));
    // Unticked, it can't be ticked again while the object pulls.
    expect(byId("include-initial-state")).toBeDisabled();
  });

  it("an object switched to pull removes a top-level include_initial_state: true in the same change, with the toast and no inline alert", async () => {
    const user = renderForm(OBJECTS, INITIAL_STATE_ON);
    await openCard(user, "Object #2: events (watch)");

    await pickIn(user, byId("obj-1-mode"), "Pull");

    expect(text()).toBe(
      INITIAL_STATE_ON.replace("    include_initial_state: true # snapshot\n", "").replace(
        EVENTS_OBJECT,
        "      - name: events # watched\n        mode: pull\n        namespaces: [default]\n        interval: 60m\n",
      ),
    );
    expect(valueOf(text(), OBJECTS)).not.toHaveProperty("include_initial_state");
    expect(infoToasts()).toEqual([REMOVED_INITIAL_STATE]);
    expect(screen.queryByText(REMOVED_INITIAL_STATE)).toBeNull();
    expect(entries()).toBe(1);
    act(() => void builderStore().undo());
    expect(text()).toBe(INITIAL_STATE_ON);
    // The undo toasts its own message, not the adjustment's again.
    expect(infoToasts().filter((message) => message === REMOVED_INITIAL_STATE)).toHaveLength(1);
  });

  it("an object added in pull mode removes a top-level include_initial_state: true in the same change, with the toast and no inline alert", async () => {
    const user = renderForm(OBJECTS, INITIAL_STATE_ON.replace(PODS_OBJECT, ""));

    await user.click(screen.getByRole("button", { name: "Add Object" }));

    expect(valueOf(text(), OBJECTS)).not.toHaveProperty("include_initial_state");
    expect(objectsOf(text()).at(-1)).toEqual({ name: "pods", mode: "pull", interval: "60m" });
    expect(infoToasts()).toEqual([REMOVED_INITIAL_STATE]);
    expect(screen.queryByText(REMOVED_INITIAL_STATE)).toBeNull();
    expect(entries()).toBe(1);
  });

  it("include_initial_state: false is left alone by a switch to pull, with no toast", async () => {
    const off = INITIAL_STATE_ON.replace("include_initial_state: true", "include_initial_state: false");
    const user = renderForm(OBJECTS, off);
    await openCard(user, "Object #2: events (watch)");
    await pickIn(user, byId("obj-1-mode"), "Pull");
    expect(valueOf(text(), OBJECTS).include_initial_state).toBe(false);
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  // config.go:113-115: initial_delay is refused in watch mode.
  it("an object switched to watch loses its initial_delay (and interval) in one change, toasted once, with no inline alert", async () => {
    const delayed = CORPUS.replace("        interval: 60m\n", "        interval: 60m\n        initial_delay: 30s # warm up\n");
    const user = renderForm(OBJECTS, delayed);
    await openCard(user, "Object #1: pods (pull)");

    await pickIn(user, byId("obj-0-mode"), "Watch");

    expect(text()).toBe(delayed.replace("        mode: pull\n        interval: 60m\n        initial_delay: 30s # warm up\n", "        mode: watch\n"));
    expect(infoToasts()).toEqual([REMOVED_INITIAL_DELAY]);
    expect(screen.queryByText(REMOVED_INITIAL_DELAY)).toBeNull();
    expect(entries()).toBe(1);

    // The next change to the form toasts nothing more.
    await retypeInto(user, byId("obj-0-label-selector"), "tier=web");
    expect(infoToasts()).toEqual([REMOVED_INITIAL_DELAY]);
  });

  it("switching to watch without an initial_delay toasts nothing", async () => {
    const user = renderForm(OBJECTS);
    await openCard(user, "Object #1: pods (pull)");
    await pickIn(user, byId("obj-0-mode"), "Watch");
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  // config.go:109-111: exclude_watch_type is refused in pull mode.
  it("switching to pull clears exclude_watch_type and resource_version, and keeps an interval the object has", async () => {
    const watching = CORPUS.replace(
      EVENTS_OBJECT,
      '      - name: events # watched\n        mode: watch\n        namespaces: [default]\n        interval: 5m\n        exclude_watch_type: [DELETED]\n        resource_version: "1"\n',
    );
    const user = renderForm(OBJECTS, watching);
    await openCard(user, "Object #2: events (watch)");

    await pickIn(user, byId("obj-1-mode"), "Pull");

    expect(objectsOf(text())[1]).toEqual({ name: "events", mode: "pull", namespaces: ["default"], interval: "5m" });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([REMOVED_WATCH_SETTINGS]);
    expect(screen.queryByText(REMOVED_WATCH_SETTINGS)).toBeNull();
  });

  it("the watch options follow the objects in watch mode; a pull object shows its Pull Interval", async () => {
    const user = renderForm(OBJECTS);
    await openSection(user, "Watch Options");
    expect(screen.getByRole("heading", { name: "Object #2: events" })).toBeInTheDocument();
    expect(byId("obj-1-resource-version")).toBeInTheDocument();
    expect(byId("obj-0-resource-version")).toBeNull();
    await openCard(user, "Object #1: pods (pull)");
    expect(byId("obj-0-interval")).toHaveValue("60m");
    await openCard(user, "Object #2: events (watch)");
    expect(byId("obj-1-interval")).toBeNull();
    expect(screen.getByText("Watch options for this object are in the Watch Options section below.")).toBeInTheDocument();
  });
});

describe("k8sobjects: the cards", () => {
  beforeEach(layOutRows);

  it("a resource outside the 16 shows as an extra option, as written", async () => {
    const user = renderForm(OBJECTS, CORPUS.replace("      - name: pods\n", "      - name: leases # a CRD's\n"));
    await openCard(user, "Object #1: leases (pull)");
    expect(byId("obj-0-name")).toHaveTextContent("leases");
    await user.click(byId("obj-0-name"));
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toHaveLength(17);
    expect(options.at(-1)).toBe("leases");
    expect(options.slice(0, 3)).toEqual(["pods", "events", "nodes"]);
  });

  it("a card dragged down moves the object's lines with its comment; its expanded state and ids follow it", async () => {
    const user = renderForm(OBJECTS);
    await openCard(user, "Object #1: pods (pull)");
    expect(byId("obj-0-name")).toHaveTextContent("pods");

    const handles = screen.getAllByRole("button", { name: "Drag to reorder" });
    expect(handles).toHaveLength(2);
    await dragByKeyboard(handles[0]!, 1);

    expect(text()).toBe(CORPUS.replace(`      # pods, pulled hourly\n${PODS_OBJECT}${EVENTS_OBJECT}`, `${EVENTS_OBJECT}      # pods, pulled hourly\n${PODS_OBJECT}`));
    expect(entries()).toBe(1);
    // The expanded card is pods', now second.
    expect(screen.getByRole("button", { name: "Object #1: events (watch)" })).toBeInTheDocument();
    expect(byId("obj-0-name")).toBeNull();
    expect(byId("obj-1-name")).toHaveTextContent("pods");
  });

  it("removing a card keeps the others' expanded state", async () => {
    const user = renderForm(OBJECTS);
    await openCard(user, "Object #2: events (watch)");
    await user.click(screen.getAllByRole("button", { name: "Remove object" })[0]!);
    expect(objectsOf(text()).map((o) => o.name)).toEqual(["events"]);
    expect(byId("obj-0-name")).toHaveTextContent("events");
  });

  it("an object's namespaces reorder by drag, each item's own source moving", async () => {
    const base = CORPUS.replace("        namespaces: [default]\n", "        namespaces: [default, kube-system]\n");
    const user = renderForm(OBJECTS, base);
    await openCard(user, "Object #2: events (watch)");
    const handles = screen.getAllByRole("button", { name: "Drag to reorder" });
    expect(handles).toHaveLength(4);

    await dragByKeyboard(handles[2]!, 1);

    expect(text()).toBe(base.replace("        namespaces: [default, kube-system]\n", "        namespaces: [kube-system, default]\n"));
    expect(entries()).toBe(1);
  });

  it("an object that isn't a mapping shows the hint in its card; the rest works", async () => {
    const user = renderForm(OBJECTS, CORPUS.replace(`      # pods, pulled hourly\n${PODS_OBJECT}`, "      - pods\n"));
    await openCard(user, "Object #1: ()");
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    await openCard(user, "Object #2: events (watch)");
    expect(byId("obj-1-name")).toHaveTextContent("events");
  });

  it("objects that aren't a list show the hint, and Add Object is disabled", () => {
    renderForm(OBJECTS, CORPUS.replace(`    objects:\n      # pods, pulled hourly\n${PODS_OBJECT}${EVENTS_OBJECT}`, "    objects: pods\n"));
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Object" })).toBeDisabled();
  });
});

// ── kubeletstats ──

describe("kubeletstats: auth_type's default is tls", () => {
  // receiver/kubeletstatsreceiver/factory.go:49-53: AuthType k8sconfig.AuthTypeTLS.
  it("unset shows TLS Certificate with the hint Default tls, the section open, and TLS's fields", () => {
    renderForm(KUBELET, KUBELET_UNSET_AUTH);
    expect(byId("auth-type")).toHaveTextContent("TLS Certificate");
    expect(hint("Default tls")).toBeInTheDocument();
    expect(byId("cert-file")).toBeInTheDocument();
    expect(byId("key-file")).toBeInTheDocument();
    expect(byId("ca-file-tls")).toBeInTheDocument();
    expect(byId("insecure-skip-verify-tls")).toBeChecked();
    expect(byId("ca-file")).toBeNull();
    expect(screen.getByText("Client Certificate File").textContent).toBe("Client Certificate File*");
  });

  it("Service Account keeps (recommended); None warns; Kube Config shows Context", async () => {
    const user = renderForm(KUBELET, KUBELET_UNSET_AUTH);
    await user.click(byId("auth-type"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Service Account (recommended)",
      "TLS Certificate",
      "Kube Config",
      "None (insecure port 10255)",
    ]);
    await user.click(screen.getByRole("option", { name: "None (insecure port 10255)" }));
    expect(screen.getByText("Insecure configuration")).toBeInTheDocument();
    expect(byId("cert-file")).toBeNull();

    await pickIn(user, byId("auth-type"), "Kube Config");
    await retypeInto(user, byId("context"), "kind-kind");
    expect(valueOf(text(), KUBELET)).toMatchObject({ auth_type: "kubeConfig", context: "kind-kind" });
  });

  it("the Kubernetes API box shows the block's presence; its auth has no default; Kube Config shows Context; unticking removes the block", async () => {
    const base = KUBELET_UNSET_AUTH.replace("      - container.id\nprocessors:\n", "      - container.id\n    k8s_api_config: # the API\n      auth_type: kubeConfig\nprocessors:\n");
    const user = renderForm(KUBELET, base);
    await openSection(user, "Kubernetes API");
    expect(byId("enable-k8s-api")).toBeChecked();
    expect(byId("k8s-api-auth")).toHaveTextContent("Kube Config");
    await retypeInto(user, byId("k8s-api-context"), "kind-kind");
    expect(valueOf(text(), KUBELET).k8s_api_config).toEqual({ auth_type: "kubeConfig", context: "kind-kind" });

    await user.click(byId("enable-k8s-api"));
    expect(text()).toBe(base.replace("    k8s_api_config: # the API\n      auth_type: kubeConfig\n", ""));
    expect(byId("k8s-api-auth")).toBeNull();
  });

  it("an empty k8s_api_config shows ticked, its auth unset with no default (k8sconfig refuses an empty one)", async () => {
    // internal/k8sconfig/config.go:90-93: an auth type outside the four is refused.
    const user = renderForm(KUBELET, KUBELET_UNSET_AUTH.replace("      - container.id\nprocessors:\n", "      - container.id\n    k8s_api_config: {}\nprocessors:\n"));
    await openSection(user, "Kubernetes API");
    expect(byId("enable-k8s-api")).toBeChecked();
    expect(byId("k8s-api-auth")).toHaveTextContent("");
    expect(queryHint("Default serviceAccount")).toBeNull();
  });
});

// ── What the forms show and the copy ──

const UNSET = [
  "receivers:",
  "  k8s_cluster:",
  "  k8s_events: {}",
  "  k8sobjects:",
  "    interval: 30m # every object's",
  "    objects:",
  "      - name: pods",
  "  kubeletstats: {}",
  "exporters:",
  "  debug: {}",
  "service:",
  "  pipelines:",
  "    metrics:",
  "      receivers: [k8s_cluster, kubeletstats]",
  "      exporters: [debug]",
  "    logs:",
  "      receivers: [k8s_events, k8sobjects]",
  "      exporters: [debug]",
  "",
].join("\n");

describe("what the forms show", () => {
  it("k8s_cluster unset: the collector's defaults as placeholders and hints; no node condition ticked, Default Ready", async () => {
    const user = renderForm(CLUSTER, UNSET);
    expect(byId("auth-type")).toHaveTextContent("Service Account (recommended)");
    expect(hint("Default serviceAccount")).toBeInTheDocument();
    expect(hint("Affects which metrics are available. · Default kubernetes")).toBeInTheDocument();
    expect(byId("collection-interval")).toHaveValue("");
    expect(byId("collection-interval")).toHaveAttribute("placeholder", "10s");
    expect(byId("metadata-collection-interval")).toHaveAttribute("placeholder", "5m");
    await openSection(user, "Resources");
    // receiver/k8sclusterreceiver/factory.go:28: the default is [Ready], named in the hint.
    expect(hint("Default Ready")).toBeInTheDocument();
    for (let i = 0; i < 5; i++) expect(byId(`condition-${i}`)).not.toBeChecked();

    // The first tick writes that item alone.
    await user.click(byId("condition-1"));
    expect(valueOf(text(), CLUSTER).node_conditions_to_report).toEqual(["MemoryPressure"]);
  });

  it("k8s_cluster: values as written; an item outside the boxes shows after them, ticked, as text", async () => {
    const user = renderForm(CLUSTER, CORPUS.replace("      - memory\n", "      - memory\n      - nvidia.com/gpu\n"));
    expect(byId("collection-interval")).toHaveValue("10s");
    await openSection(user, "Resources");
    expect(byId("condition-0")).toBeChecked();
    expect(byId("condition-1")).toBeChecked();
    expect(byId("condition-2")).not.toBeChecked();
    expect(byId("allocatable-4")).toBeChecked();
    expect(screen.getByLabelText("nvidia.com/gpu")).toBe(byId("allocatable-4"));
    expect(screen.getByDisplayValue("default")).toBeInTheDocument();
    // The section counts: 1 namespace, 2 conditions, 3 allocatable types.
    expect(screen.getByRole("button", { name: /^Resources/ })).toHaveTextContent("Resources6");
  });

  it("k8sobjects unset: Error Mode Default propagate, Collection Mode Default pull, the Pull Interval defaults to the top-level interval", async () => {
    // receiver/k8sobjectsreceiver/config.go:91-92 (no mode: pull), 101-107 (interval: the top-level one, else an hour).
    const user = renderForm(OBJECTS, UNSET);
    expect(hint("How to handle missing or inaccessible resources. · Default propagate")).toBeInTheDocument();
    expect(byId("error-mode")).toHaveTextContent("Propagate (fail on error)");
    await openCard(user, "Object #1: pods (pull)");
    expect(byId("obj-0-mode")).toHaveTextContent("Pull");
    expect(hint("Default pull")).toBeInTheDocument();
    // The top-level interval is the text's: shown in the hint, as text, never in the placeholder.
    expect(hint("Default 30m")).toBeInTheDocument();
    expect(byId("obj-0-interval")).toHaveAttribute("placeholder", "");
  });

  it("k8sobjects: a pull interval defaults to 60m without a top-level one", async () => {
    const user = renderForm(OBJECTS, UNSET.replace("    interval: 30m # every object's\n", ""));
    await openCard(user, "Object #1: pods (pull)");
    expect(hint("Default 60m")).toBeInTheDocument();
    expect(byId("obj-0-interval")).toHaveAttribute("placeholder", "60m");
  });

  it("kubeletstats unset: metric groups none ticked with Default container, pod, node; intervals' defaults", async () => {
    // receiver/kubeletstatsreceiver/factory.go:27-31, 44-45; config.go:128-132.
    const user = renderForm(KUBELET, UNSET);
    expect(byId("collection-interval")).toHaveAttribute("placeholder", "10s");
    expect(byId("initial-delay")).toHaveAttribute("placeholder", "1s");
    await openSection(user, "Metrics");
    expect(hint("Default container, pod, node")).toBeInTheDocument();
    for (let i = 0; i < 4; i++) expect(byId(`metric-group-${i}`)).not.toBeChecked();
    await user.click(byId("metric-group-3"));
    expect(valueOf(text(), KUBELET).metric_groups).toEqual(["volume"]);
  });

  it("values the fields can't show are read-only with the hint; the rest works", async () => {
    const odd = CORPUS.replace("    namespaces:\n      - default\n", "    namespaces: default\n")
      .replace("    node_conditions_to_report: [Ready, MemoryPressure]\n", "    node_conditions_to_report: {Ready: true}\n")
      .replace("    collection_interval: 20s\n", "    collection_interval: [20s]\n    k8s_api_config: serviceAccount\n");
    const user = renderForm(CLUSTER, odd);
    await openSection(user, "Resources");
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
    expect(byId("condition-0")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add Namespace" })).toBeNull();
    await retypeInto(user, byId("collection-interval"), "15s");
    expect(valueOf(text(), CLUSTER).collection_interval).toBe("15s");

    cleanup();
    useEditorStore.setState(initialState, true);
    const kubelet = renderForm(KUBELET, odd);
    expect(byId("collection-interval")).toBeDisabled();
    await openSection(kubelet, "Kubernetes API");
    expect(byId("enable-k8s-api")).toBeDisabled();
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
  });
});

describe("the copy", () => {
  it("k8s_cluster: the Namespaces and Metadata Exporters hints", async () => {
    const user = renderForm(CLUSTER);
    await openSection(user, "Resources");
    await openSection(user, "Advanced");
    expect(hint("Leave empty to monitor all namespaces. Setting any stops node and namespace metrics.")).toBeInTheDocument();
    expect(hint("Exporters that sync cluster entity metadata; each must be in a metrics pipeline.")).toBeInTheDocument();
    expect(screen.getByText(/^Needs a ClusterRole with get, list, and watch on pods, nodes, namespaces, events, and workload resources \(plus clusterresourcequotas on OpenShift\)\.$/)).toBeInTheDocument();
  });

  it("k8s_events: the RBAC alert asks for get, list and watch on events", () => {
    // receiver/k8seventsreceiver/README.md:167-186: the ClusterRole's one rule is events get/list/watch.
    renderForm(EVENTS);
    expect(screen.getByText("RBAC required").nextElementSibling).toHaveTextContent(
      /^The collector's service account needs a ClusterRole with get, list, and watch on events\.$/,
    );
    expect(hint("Leave empty to collect events from all namespaces.")).toBeInTheDocument();
  });

  it("kubeletstats: Node Name, Volume Type and the RBAC alert", async () => {
    // receiver/kubeletstatsreceiver/config.go:137-150; README.md:185-234, 329-331.
    const user = renderForm(KUBELET);
    expect(hint("Used by the node utilization metrics, which are off by default.")).toBeInTheDocument();
    await openSection(user, "Metrics");
    expect(screen.getByText("Cloud provider volume metadata; Kubernetes API access adds persistent volume details.")).toBeInTheDocument();
    await openSection(user, "Kubernetes API");
    expect(screen.getByText("RBAC permissions").nextElementSibling).toHaveTextContent(
      /^The service account needs get on nodes\/stats, plus nodes\/pods for extra metadata labels or request and limit utilization, and get on persistentvolumeclaims and persistentvolumes with Kubernetes API access\.$/,
    );
    // README.md:188-189 (/pods gives the volume type), 232-234 (the API adds the PV's details).
    expect(screen.getByText("Required for node utilization metrics; adds persistent volume details to Volume Type.")).toBeInTheDocument();
  });

  it("k8sobjects: its copy", async () => {
    const user = renderForm(OBJECTS);
    expect(screen.getByText("At least one object is required.")).toBeInTheDocument();
    await openSection(user, "Watch Options");
    expect(screen.getByText("Send a snapshot before streaming watch events.")).toBeInTheDocument();
    await openSection(user, "Deployment & RBAC");
    expect(screen.getByText("Deploy one replica to avoid duplicate collection, or configure leader election.")).toBeInTheDocument();
  });
});

// ── Privacy ──

describe("privacy", () => {
  beforeEach(layOutRows);

  // Its own time limit.
  it("puts no config value in any attribute: every section and card open, the menus open, drags in progress", async () => {
    const MARK = "zq-mark";
    const marked = (kubeletAuth: string) =>
      [
        "receivers:",
        "  k8s_cluster:",
        `    auth_type: ${MARK}-auth`,
        `    distribution: ${MARK}-dist`,
        `    collection_interval: ${MARK}-ci`,
        `    metadata_collection_interval: ${MARK}-mci`,
        `    namespaces: [${MARK}-ns]`,
        `    node_conditions_to_report: [${MARK}-cond]`,
        `    allocatable_types_to_report: [${MARK}-alloc]`,
        `    metadata_exporters: [${MARK}-exporter]`,
        `    k8s_leader_elector: ${MARK}-elector`,
        "  k8s_events:",
        `    auth_type: ${MARK}-auth`,
        `    namespaces: [${MARK}-ens]`,
        `    k8s_leader_elector: ${MARK}-eelector`,
        "  k8sobjects:",
        `    auth_type: ${MARK}-auth`,
        `    error_mode: ${MARK}-err`,
        `    interval: ${MARK}-top`,
        "    include_initial_state: true",
        "    objects:",
        `      - name: ${MARK}-name`,
        "        mode: watch",
        `        namespaces: [${MARK}-ons1, ${MARK}-ons2]`,
        `        label_selector: ${MARK}-label`,
        `        field_selector: ${MARK}-field`,
        `        group: ${MARK}-group`,
        `        exclude_watch_type: [${MARK}-exclude]`,
        `        resource_version: ${MARK}-rv`,
        `      - name: ${MARK}-name2`,
        `        mode: ${MARK}-mode`,
        `      - name: ${MARK}-name3`,
        `        interval: ${MARK}-interval`,
        "  kubeletstats:",
        `    endpoint: ${MARK}-endpoint`,
        `    collection_interval: ${MARK}-kci`,
        `    initial_delay: ${MARK}-delay`,
        `    node: ${MARK}-node`,
        `    auth_type: ${kubeletAuth}`,
        `    ca_file: ${MARK}-ca`,
        `    cert_file: ${MARK}-cert`,
        `    key_file: ${MARK}-key`,
        `    context: ${MARK}-context`,
        `    metric_groups: [${MARK}-group]`,
        `    extra_metadata_labels: [${MARK}-label]`,
        "    k8s_api_config:",
        "      auth_type: kubeConfig",
        `      context: ${MARK}-api-context`,
        "exporters:",
        "  debug: {}",
        "service:",
        "  pipelines:",
        "    metrics:",
        "      receivers: [k8s_cluster, kubeletstats]",
        "      exporters: [debug]",
        "    logs:",
        "      receivers: [k8s_events, k8sobjects]",
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
      }
    };
    const shown = () =>
      document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

    const runs: [string, string, readonly string[]][] = [
      [CLUSTER, marked("tls"), ["auth-type", "distribution"]],
      [EVENTS, marked("tls"), ["auth-type"]],
      [OBJECTS, marked("tls"), ["auth-type", "error-mode", "obj-0-name", "obj-1-mode"]],
      [KUBELET, marked(`${MARK}-kauth`), ["auth-type"]],
      [KUBELET, marked("tls"), []],
      [KUBELET, marked("serviceAccount"), []],
      [KUBELET, marked("kubeConfig"), []],
    ];
    for (const [key, base, menus] of runs) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, base);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      for (const header of screen.queryAllByRole("button", { name: /^Object #/ })) await user.click(header);
      expect(shown()).toContain(`${MARK}-`);
      scan(key);

      // A drag in progress on each sortable list: the live region names ids only.
      for (const handle of screen.queryAllByRole("button", { name: "Drag to reorder" })) {
        act(() => handle.focus());
        await press(handle, " ", "Space");
        await press(handle, "ArrowDown");
        scan(`${key} (dragging)`);
        await press(handle, "Escape");
      }

      for (const menu of menus) {
        await user.click(byId(menu));
        expect(screen.getAllByRole("option").some((o) => o.textContent?.includes(MARK))).toBe(true);
        scan(`${key} (${menu} menu)`);
        await user.keyboard("{Escape}");
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
    }
    expect(leaks).toEqual([]);
  }, 20_000);
});

// ── Fixes ──

describe("k8sobjects: cards follow their objects through undo, redo and the YAML box", () => {
  beforeEach(layOutRows);

  const SWAPPED = CORPUS.replace(`      # pods, pulled hourly\n${PODS_OBJECT}${EVENTS_OBJECT}`, `${EVENTS_OBJECT}      # pods, pulled hourly\n${PODS_OBJECT}`);

  it("after a move's undo and redo, the expanded card is still pods'", async () => {
    const user = renderForm(OBJECTS);
    await openCard(user, "Object #1: pods (pull)");
    await dragByKeyboard(screen.getAllByRole("button", { name: "Drag to reorder" })[0]!, 1);
    expect(byId("obj-1-name")).toHaveTextContent("pods");

    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
    expect(byId("obj-0-name")).toHaveTextContent("pods");
    expect(byId("obj-1-name")).toBeNull();

    act(() => void builderStore().redo());
    expect(byId("obj-1-name")).toHaveTextContent("pods");
    expect(byId("obj-0-name")).toBeNull();
  });

  it("after a remove's undo, the expanded card is still events', and the restored one is collapsed", async () => {
    const user = renderForm(OBJECTS);
    await openCard(user, "Object #2: events (watch)");
    await user.click(screen.getAllByRole("button", { name: "Remove object" })[0]!);
    expect(byId("obj-0-name")).toHaveTextContent("events");

    act(() => void builderStore().undo());
    expect(byId("obj-1-name")).toHaveTextContent("events");
    expect(byId("obj-0-name")).toBeNull();
  });

  it("after the YAML box reorders the objects, the expanded card is still pods'", async () => {
    const user = renderForm(OBJECTS);
    await openCard(user, "Object #1: pods (pull)");
    act(() => builderStore().setText(SWAPPED));
    act(() => void builderStore().apply());
    expect(text()).toBe(SWAPPED);
    expect(byId("obj-1-name")).toHaveTextContent("pods");
    expect(byId("obj-0-name")).toBeNull();
  });

  it("a held namespace row stays in its object's card through the other's removal and its undo", async () => {
    const user = renderForm(OBJECTS);
    await openCard(user, "Object #2: events (watch)");
    await openCard(user, "Object #1: pods (pull)");
    await user.click(screen.getAllByRole("button", { name: "Add Namespace" })[1]!);
    const eventsRows = () => {
      const card = byId("obj-1-name")?.closest(".rounded-md.space-y-2");
      return card ? card.querySelectorAll('input[placeholder="e.g. default"]').length : -1;
    };
    expect(eventsRows()).toBe(2);

    await user.click(screen.getAllByRole("button", { name: "Remove object" })[0]!);
    act(() => void builderStore().undo());

    expect(text()).toBe(CORPUS);
    expect(eventsRows()).toBe(2);
    expect(screen.getAllByPlaceholderText("e.g. default")).toHaveLength(2);
  });

  it("editing a field of an expanded card keeps it expanded", async () => {
    const user = renderForm(OBJECTS);
    await openCard(user, "Object #1: pods (pull)");
    await retypeInto(user, byId("obj-0-label-selector"), "tier=web");
    await pickIn(user, byId("obj-0-name"), "nodes");
    expect(byId("obj-0-name")).toHaveTextContent("nodes");
    expect(byId("obj-0-label-selector")).toHaveValue("tier=web");
  });
});

describe("k8sobjects: the collector's pull rules", () => {
  // receiver/k8sobjectsreceiver/config.go:91-92: `if object.Mode == ""` → pull.
  it('mode: "" pulls: Include Initial State is disabled, the card shows pull and its Pull Interval', async () => {
    const base = OBJECTS_WATCHING.replace("      - name: pods\n        mode: watch\n", '      - name: pods\n        mode: ""\n');
    const user = renderForm(OBJECTS, base);
    await openSection(user, "Watch Options");
    expect(byId("include-initial-state")).toBeDisabled();
    expect(hint(INITIAL_STATE_PULL_HINT)).toBeInTheDocument();
    await openCard(user, "Object #1: pods (pull)");
    expect(byId("obj-0-interval")).toBeInTheDocument();
  });

  // config.go:101-107: an object with no interval takes the top-level one.
  it("with a top-level interval, Add Object and the switch to pull write no interval: the object inherits it", async () => {
    const base = CORPUS.replace("  k8sobjects:\n    <<: *k8s-auth\n", "  k8sobjects:\n    <<: *k8s-auth\n    interval: 5m # every object's\n");
    const user = renderForm(OBJECTS, base);
    await openCard(user, "Object #2: events (watch)");
    await pickIn(user, byId("obj-1-mode"), "Pull");
    expect(text()).toBe(base.replace(EVENTS_OBJECT, EVENTS_OBJECT.replace("mode: watch", "mode: pull")));

    await user.click(screen.getByRole("button", { name: "Add Object" }));
    expect(objectsOf(text()).at(-1)).toEqual({ name: "pods", mode: "pull" });
  });

  // config.go:109-111 refuses exclude_watch_type in pull mode; resource_version isn't refused
  // (config.go:121-123 only beside storage; the pull observer lists that version, pull/observer.go:74-76).
  it("the switch to pull says it removed the watch-only settings; resource_version alone is cleared silently", async () => {
    const exclude = CORPUS.replace(EVENTS_OBJECT, `${EVENTS_OBJECT}        exclude_watch_type: [DELETED]\n`);
    const user = renderForm(OBJECTS, exclude);
    await openCard(user, "Object #2: events (watch)");
    await pickIn(user, byId("obj-1-mode"), "Pull");
    expect(objectsOf(text())[1]).not.toHaveProperty("exclude_watch_type");
    expect(infoToasts()).toEqual([REMOVED_WATCH_SETTINGS]);
    expect(screen.queryByText(REMOVED_WATCH_SETTINGS)).toBeNull();
    expect(entries()).toBe(1);

    cleanup();
    useEditorStore.setState(initialState, true);
    vi.mocked(toast.info).mockClear();
    const version = CORPUS.replace(EVENTS_OBJECT, `${EVENTS_OBJECT}        resource_version: "1"\n`);
    const again = renderForm(OBJECTS, version);
    await openCard(again, "Object #2: events (watch)");
    await pickIn(again, byId("obj-1-mode"), "Pull");
    expect(objectsOf(text())[1]).not.toHaveProperty("resource_version");
    expect(infoToasts()).toEqual([]);
    expect(entries()).toBe(1);
  });

  it("both adjustments at once toast both messages once, joined, with no inline alert", async () => {
    const both = INITIAL_STATE_ON.replace(EVENTS_OBJECT, `${EVENTS_OBJECT}        exclude_watch_type: [DELETED]\n`);
    const user = renderForm(OBJECTS, both);
    await openCard(user, "Object #2: events (watch)");
    await pickIn(user, byId("obj-1-mode"), "Pull");
    expect(infoToasts()).toEqual([`${REMOVED_WATCH_SETTINGS} ${REMOVED_INITIAL_STATE}`]);
    expect(screen.queryByText(REMOVED_WATCH_SETTINGS)).toBeNull();
    expect(screen.queryByText(REMOVED_INITIAL_STATE)).toBeNull();
    expect(entries()).toBe(1);
  });
});

describe("markup", () => {
  it("kubeletstats' checkbox rows: items-start space-x-3 rows, leading-none labels, text-xs descriptions", async () => {
    const user = renderForm(KUBELET);
    await openSection(user, "Authentication");
    await openSection(user, "Metrics");
    for (const id of ["metric-group-0", "extra-label-0", "insecure-skip-verify", "collect-pod-interfaces", "collect-node-interfaces"]) {
      expect(byId(id).parentElement).toHaveClass("flex", "items-start", "space-x-3");
    }
    for (const id of ["metric-group-0", "insecure-skip-verify", "collect-pod-interfaces"]) {
      expect(document.querySelector(`label[for="${id}"]`)).toHaveClass("text-sm", "font-medium", "cursor-pointer", "leading-none");
    }
    expect(screen.getByText("Increases metric cardinality")).toHaveClass("text-xs");
    expect(screen.getByText("Increases metric cardinality").parentElement).toHaveClass("grid", "gap-1.5", "leading-none");
  });

  // Measured in Chromium, WebKit and Firefox: a box beside a text-sm label and its description sat 2 px high.
  it("a box beside a label and its description is moved down 2 px; the boxes beside a label alone are left as they were", async () => {
    const user = renderForm(KUBELET);
    await openSection(user, "Authentication");
    await openSection(user, "Metrics");
    await openSection(user, "Kubernetes API");
    for (const id of ["extra-label-0", "extra-label-1", "enable-k8s-api"]) expect(byId(id)).toHaveClass("mt-0.5");
    for (const id of ["metric-group-0", "insecure-skip-verify", "collect-pod-interfaces", "collect-node-interfaces"]) {
      expect(byId(id)).not.toHaveClass("mt-0.5");
    }
    cleanup();

    const objects = renderForm(OBJECTS, OBJECTS_WATCHING);
    await openSection(objects, "Watch Options");
    expect(byId("include-initial-state")).toHaveClass("mt-0.5");
    cleanup();

    const cluster = renderForm(CLUSTER);
    await openSection(cluster, "Resources");
    expect(byId("condition-0")).not.toHaveClass("mt-0.5");
  });

  it("k8s_cluster's Namespaces and Metadata Exporters labels focus no row", async () => {
    const user = renderForm(CLUSTER);
    await openSection(user, "Resources");
    await openSection(user, "Advanced");
    expect(byId("namespaces")).toBeNull();
    expect(byId("metadata-exporters")).toBeNull();
    await user.click(screen.getByText("Namespaces"));
    expect(document.activeElement).not.toBe(screen.getByDisplayValue("default"));
  });
});

// ── Two objects that read alike ──

describe("k8sobjects: a card keeps its object when another reads alike", () => {
  // Its own time limit.
  it("two identical objects: slow typing in the first card's Label Selector stays in the first, focus kept", async () => {
    const base = CORPUS.replace(PODS_OBJECT, PODS_OBJECT + PODS_OBJECT);
    const user = renderForm(OBJECTS, base);
    await openCard(user, "Object #1: pods (pull)");
    const selector = byId("obj-0-label-selector");
    await user.click(selector);
    for (const key of ["x", "y"]) {
      await user.keyboard(key);
      // Past the 300 ms pause: each key is written as it's typed.
      await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 350))));
    }
    expect(objectsOf(text()).map((o) => o.label_selector)).toEqual(["environment in (production)xy", "environment in (production)", undefined]);
    expect(document.activeElement).toBe(selector);
    expect(byId("obj-0-label-selector")).toBe(selector);
  }, 20_000);
});
