import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, useComponentForm } from "./form-context.js";
import { ALL_RULES_PRESENT, K8sAttributesProcessorForm, ruleKey, SUGGESTED_RULES } from "./K8sAttributesProcessorForm.js";
import { attributeDefault } from "./k8s-defaults.js";
import { DETECTOR_DESCRIPTIONS, OPENSHIFT_TLS_HINT, RESOURCE_ATTRIBUTE_BOXES, ResourceDetectionProcessorForm } from "./ResourceDetectionProcessorForm.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * k8sattributes' and resourcedetection's forms (D9c Task 3): their forms
 * over the form contract. Each field is driven as a person would
 * (typing, clicking, picking, dragging by keyboard) on the Kubernetes
 * corpus text (comments, flow and block lists, CRLF), and writes only its
 * key: the text changes in that key's lines only, and parses to the value
 * (D9c decision 2). The fixes each have a test that fails if the bug
 * returns: OTel annotations writing only its key, no Derive
 * Deployment Name, Add Rule's seeding (decision 3; Preflight ruling 16);
 * the detector catalog and `openstack` (decision 6); the Client Timeout
 * fields gone (decision 3); each resource attribute's collector default
 * (decision 4); the Kubernetes Node section for `k8snode` only (Preflight
 * ruling 27).
 *
 * Collector claims cite contrib v0.162.0 (`processor/k8sattributesprocessor/`,
 * `processor/resourcedetectionprocessor/`).
 */

const CORPUS = corpusText("forms-kubernetes.yaml");

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

const ATTRS = "processors.k8sattributes";
const DETECTION = "processors.resourcedetection";

const FORM_OF: Record<string, () => ReactNode> = {
  [ATTRS]: () => <K8sAttributesProcessorForm />,
  [DETECTION]: () => <ResourceDetectionProcessorForm />,
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
const box = (name: string) => screen.getByRole("checkbox", { name });
/** A hint line, by its whole text ("… · Default env" spans elements). */
const hint = (whole: string) =>
  screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
type Value = Record<string, unknown>;
const valueOf = (written: string, key: string): Value => {
  const [section, name] = key.split(".") as [string, string];
  return (parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>)[section]![name]!;
};

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

/** Opens a detector group by its title (its buttons carry no aria-expanded). */
async function openGroup(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: title }));
}

/** The card (rule, label or annotation) an element is in. */
function cardOf(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>("div.rounded-md.border-border")!;
}

// ── Sortable rows by keyboard (D9b Preflight ruling 15) ──

const ROW_HEIGHT = 40;

/** The sortable row an element is in: a child of a `space-y-2` list whose children all hold a drag handle. */
function rowOf(element: Element): HTMLElement | null {
  for (let e: HTMLElement | null = element as HTMLElement; e; e = e.parentElement) {
    const parent = e.parentElement;
    if (
      parent?.classList.contains("space-y-2") &&
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

// ── The texts ──

const ATTRS_END = "      - sources: [{from: connection}]\n  resourcedetection:\n";
const LABEL = "        - tag_name: app\n          key: app.kubernetes.io/name\n          from: pod\n";
const RULE_IP = "      - sources:\n          - from: resource_attribute\n            name: k8s.pod.ip\n";
const RULE_CONNECTION = "      - sources: [{from: connection}]\n";
const DETECTION_END = "        os.type:\n          enabled: false\n  batch: {}\n";

/** The corpus with k8sattributes waiting for metadata: Wait Timeout shows. */
const ATTRS_WAITING = CORPUS.replace("    passthrough: false\n", "    passthrough: false\n    wait_for_metadata: true\n");
/** The corpus with k8sattributes' own keys only `passthrough`: no extract, no rules. */
const ATTRS_BARE = CORPUS.replace(/ {2}k8sattributes:\n[\s\S]*? {2}resourcedetection:\n/, "  k8sattributes:\n    passthrough: false\n  resourcedetection:\n");
/** The corpus with more detectors, so their sections show. */
const withDetectors = (detectors: string) => CORPUS.replace("    detectors: [env, system] # in order\n", `    detectors: [${detectors}] # in order\n`);
const DETECTION_ALL = withDetectors("env, system, ec2, ecs, eks, azure, gcp, docker, k8snode, openshift");

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

const CASES: FieldCase[] = [
  // k8sattributes
  {
    name: "k8sattributes Authentication Type (unset) is added under the component",
    key: ATTRS,
    edit: (user) => pickIn(user, byId("auth-type"), "Kube Config"),
    from: ATTRS_END,
    to: "      - sources: [{from: connection}]\n    auth_type: kubeConfig\n  resourcedetection:\n",
    check: (v) => expect(v.auth_type).toBe("kubeConfig"),
  },
  {
    name: "k8sattributes Passthrough Mode ticked",
    key: ATTRS,
    edit: (user) => user.click(box("Passthrough Mode")),
    from: "    passthrough: false\n",
    to: "    passthrough: true\n",
    check: (v) => expect(v.passthrough).toBe(true),
  },
  {
    name: "k8sattributes Wait for Metadata ticked (unset)",
    key: ATTRS,
    edit: (user) => user.click(box("Wait for Metadata")),
    from: ATTRS_END,
    to: "      - sources: [{from: connection}]\n    wait_for_metadata: true\n  resourcedetection:\n",
    check: (v) => expect(v.wait_for_metadata).toBe(true),
  },
  {
    name: "k8sattributes Wait Timeout (unset, shown while waiting)",
    key: ATTRS,
    base: ATTRS_WAITING,
    edit: (user) => retypeInto(user, byId("wait-timeout"), "30s"),
    from: ATTRS_END,
    to: "      - sources: [{from: connection}]\n    wait_for_metadata_timeout: 30s\n  resourcedetection:\n",
    check: (v) => expect(v.wait_for_metadata_timeout).toBe("30s"),
  },
  {
    name: "k8sattributes Filtering Namespace (unset) adds the filter block",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await retypeInto(user, byId("namespace-filter"), "default");
    },
    from: ATTRS_END,
    to: "      - sources: [{from: connection}]\n    filter:\n      namespace: default\n  resourcedetection:\n",
    check: (v) => expect(v.filter).toEqual({ namespace: "default" }),
  },
  {
    name: "k8sattributes Filtering Node (unset)",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await retypeInto(user, byId("node-filter"), "K8S_NODE_NAME");
    },
    from: ATTRS_END,
    to: "      - sources: [{from: connection}]\n    filter:\n      node_from_env_var: K8S_NODE_NAME\n  resourcedetection:\n",
    check: (v) => expect(v.filter).toEqual({ node_from_env_var: "K8S_NODE_NAME" }),
  },
  {
    name: "k8sattributes a rule's source From writes `from` alone (the name stays)",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Pod Association");
      await pickIn(user, within(cardOf(screen.getByText("Rule 1"))).getAllByRole("combobox")[0]!, "Connection IP");
    },
    from: RULE_IP,
    to: "      - sources:\n          - from: connection\n            name: k8s.pod.ip\n",
    check: (v) => expect((v.pod_association as Value[])[0]).toEqual({ sources: [{ from: "connection", name: "k8s.pod.ip" }] }),
  },
  {
    name: "k8sattributes a source's resource attribute key retyped",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Pod Association");
      await retypeInto(user, screen.getByRole("textbox", { name: "Resource attribute key" }), "k8s.pod.uid");
    },
    from: "            name: k8s.pod.ip\n",
    to: "            name: k8s.pod.uid\n",
    check: (v) => expect((v.pod_association as Value[])[0]).toEqual({ sources: [{ from: "resource_attribute", name: "k8s.pod.uid" }] }),
  },
  {
    name: "k8sattributes Add Source appends the connection source to its rule",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Pod Association");
      await user.click(screen.getAllByRole("button", { name: "Add Source" })[0]!);
    },
    from: RULE_IP,
    to: `${RULE_IP}          - from: connection\n`,
    check: (v) =>
      expect((v.pod_association as Value[])[0]).toEqual({
        sources: [{ from: "resource_attribute", name: "k8s.pod.ip" }, { from: "connection" }],
      }),
  },
  {
    name: "k8sattributes Remove source removes the source's lines",
    key: ATTRS,
    base: CORPUS.replace(RULE_IP, `${RULE_IP}          - from: connection # also\n`),
    edit: async (user) => {
      await openSection(user, "Pod Association");
      await user.click(screen.getAllByRole("button", { name: "Remove source" })[1]!);
    },
    from: `${RULE_IP}          - from: connection # also\n`,
    to: RULE_IP,
    check: (v) => expect((v.pod_association as Value[])[0]).toEqual({ sources: [{ from: "resource_attribute", name: "k8s.pod.ip" }] }),
  },
  {
    name: "k8sattributes Add Rule seeds the pod UID rule, the ip and connection rules being there",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Pod Association");
      await user.click(screen.getByRole("button", { name: "Add Rule" }));
    },
    from: ATTRS_END,
    to: "      - sources: [{from: connection}]\n      - sources:\n          - from: resource_attribute\n            name: k8s.pod.uid\n  resourcedetection:\n",
    check: (v) => expect((v.pod_association as Value[])[2]).toEqual({ sources: [{ from: "resource_attribute", name: "k8s.pod.uid" }] }),
  },
  {
    name: "k8sattributes Remove rule removes the rule's lines",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Pod Association");
      await user.click(screen.getAllByRole("button", { name: "Remove rule" })[0]!);
    },
    from: RULE_IP,
    to: "",
    check: (v) => expect(v.pod_association).toEqual([{ sources: [{ from: "connection" }] }]),
  },
  {
    name: "k8sattributes a standard attribute ticked is appended to the list",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await user.click(box("k8s.pod.uid"));
    },
    from: "        - k8s.pod.name # the pod\n",
    to: "        - k8s.pod.name # the pod\n        - k8s.pod.uid\n",
    check: (v) => expect((v.extract as Value).metadata).toEqual(["k8s.namespace.name", "k8s.pod.name", "k8s.pod.uid"]),
  },
  {
    name: "k8sattributes a standard attribute unticked removes its line",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await user.click(box("k8s.namespace.name"));
    },
    from: "        - k8s.namespace.name\n",
    to: "",
    check: (v) => expect((v.extract as Value).metadata).toEqual(["k8s.pod.name"]),
  },
  {
    name: "k8sattributes Extract OpenTelemetry Annotations writes extract.otel_annotations alone",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await user.click(box("Extract OpenTelemetry Annotations"));
    },
    from: `${LABEL}    pod_association:\n`,
    to: `${LABEL}      otel_annotations: true\n    pod_association:\n`,
    check: (v) =>
      expect(v.extract).toEqual({
        metadata: ["k8s.namespace.name", "k8s.pod.name"],
        labels: [{ tag_name: "app", key: "app.kubernetes.io/name", from: "pod" }],
        otel_annotations: true,
      }),
  },
  {
    name: "k8sattributes a label's tag name retyped",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await retypeInto(user, screen.getByRole("textbox", { name: "Tag name" }), "service");
    },
    from: "        - tag_name: app\n",
    to: "        - tag_name: service\n",
    check: (v) => expect(((v.extract as Value).labels as Value[])[0]!.tag_name).toBe("service"),
  },
  {
    name: "k8sattributes a label's key retyped",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await retypeInto(user, screen.getByRole("textbox", { name: "Label key" }), "app.kubernetes.io/component");
    },
    from: "          key: app.kubernetes.io/name\n",
    to: "          key: app.kubernetes.io/component\n",
    check: (v) => expect(((v.extract as Value).labels as Value[])[0]!.key).toBe("app.kubernetes.io/component"),
  },
  {
    name: "k8sattributes a label's From picked",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await pickIn(user, within(cardOf(screen.getByRole("textbox", { name: "Tag name" }))).getAllByRole("combobox")[1]!, "Namespace");
    },
    from: "          from: pod\n",
    to: "          from: namespace\n",
    check: (v) => expect(((v.extract as Value).labels as Value[])[0]!.from).toBe("namespace"),
  },
  {
    name: "k8sattributes a label switched to Regex renames key to key_regex in place",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await pickIn(user, within(cardOf(screen.getByRole("textbox", { name: "Tag name" }))).getAllByRole("combobox")[0]!, "Regex");
    },
    from: "          key: app.kubernetes.io/name\n",
    to: "          key_regex: app.kubernetes.io/name\n",
    check: (v) => expect(((v.extract as Value).labels as Value[])[0]).toEqual({ tag_name: "app", key_regex: "app.kubernetes.io/name", from: "pod" }),
  },
  {
    name: "k8sattributes Add Label appends the seeded item",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await user.click(screen.getByRole("button", { name: "Add Label" }));
    },
    from: LABEL,
    to: `${LABEL}        - tag_name: ""\n          key: ""\n          from: pod\n`,
    check: (v) => expect(((v.extract as Value).labels as Value[])[1]).toEqual({ tag_name: "", key: "", from: "pod" }),
  },
  {
    name: "k8sattributes Remove label leaves []",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await user.click(screen.getByRole("button", { name: "Remove label" }));
    },
    from: `      labels:\n${LABEL}`,
    to: "      labels: []\n",
    check: (v) => expect((v.extract as Value).labels).toEqual([]),
  },
  {
    name: "k8sattributes Add Annotation (unset) adds the list under extract",
    key: ATTRS,
    edit: async (user) => {
      await openSection(user, "Metadata Extraction");
      await user.click(screen.getByRole("button", { name: "Add Annotation" }));
    },
    from: `${LABEL}    pod_association:\n`,
    to: `${LABEL}      annotations:\n        - tag_name: ""\n          key: ""\n          from: pod\n    pod_association:\n`,
    check: (v) => expect((v.extract as Value).annotations).toEqual([{ tag_name: "", key: "", from: "pod" }]),
  },

  // resourcedetection
  {
    name: "resourcedetection Timeout retyped",
    key: DETECTION,
    edit: (user) => retypeInto(user, byId("timeout"), "10s"),
    from: "    timeout: 2s\n",
    to: "    timeout: 10s\n",
    check: (v) => expect(v.timeout).toBe("10s"),
  },
  {
    name: "resourcedetection Override ticked",
    key: DETECTION,
    edit: (user) => user.click(box("Override Existing Attributes")),
    from: "    override: false\n",
    to: "    override: true\n",
    check: (v) => expect(v.override).toBe(true),
  },
  {
    name: "resourcedetection a detector ticked is appended, keeping the list's comment",
    key: DETECTION,
    edit: (user) => user.click(box("ec2")),
    from: "    detectors: [env, system] # in order\n",
    to: "    detectors: [env, system, ec2] # in order\n",
    check: (v) => expect(v.detectors).toEqual(["env", "system", "ec2"]),
  },
  {
    name: "resourcedetection a detector unticked is removed",
    key: DETECTION,
    edit: (user) => user.click(box("env")),
    from: "    detectors: [env, system] # in order\n",
    to: "    detectors: [system] # in order\n",
    check: (v) => expect(v.detectors).toEqual(["system"]),
  },
  {
    name: "resourcedetection nova ticked (Other Clouds)",
    key: DETECTION,
    edit: async (user) => {
      await openGroup(user, "Other Clouds");
      await user.click(box("nova"));
    },
    from: "    detectors: [env, system] # in order\n",
    to: "    detectors: [env, system, nova] # in order\n",
    check: (v) => expect(v.detectors).toEqual(["env", "system", "nova"]),
  },
  {
    name: "resourcedetection k8s_api ticked (Kubernetes)",
    key: DETECTION,
    edit: async (user) => {
      await openGroup(user, "Kubernetes");
      await user.click(box("k8s_api"));
    },
    from: "    detectors: [env, system] # in order\n",
    to: "    detectors: [env, system, k8s_api] # in order\n",
    check: (v) => expect(v.detectors).toEqual(["env", "system", "k8s_api"]),
  },
  {
    name: "resourcedetection a hostname source ticked is appended",
    key: DETECTION,
    edit: async (user) => {
      await openSection(user, "Cloud & System Detectors");
      await user.click(box("DNS - FQDN via DNS lookup"));
    },
    from: "      hostname_sources: [os]\n",
    to: "      hostname_sources: [os, dns]\n",
    check: (v) => expect((v.system as Value).hostname_sources).toEqual(["os", "dns"]),
  },
  {
    name: "resourcedetection a resource attribute ticked (unset, off by default) writes enabled: true",
    key: DETECTION,
    edit: async (user) => {
      await openSection(user, "Cloud & System Detectors");
      await user.click(byId("system-attr-4")); // host.arch
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n        host.arch:\n          enabled: true\n  batch: {}\n",
    check: (v) => expect(((v.system as Value).resource_attributes as Value)["host.arch"]).toEqual({ enabled: true }),
  },
  {
    name: "resourcedetection a resource attribute unticked (unset, on by default) writes enabled: false",
    key: DETECTION,
    edit: async (user) => {
      await openSection(user, "Cloud & System Detectors");
      await user.click(byId("system-attr-0")); // host.name
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n        host.name:\n          enabled: false\n  batch: {}\n",
    check: (v) => expect(((v.system as Value).resource_attributes as Value)["host.name"]).toEqual({ enabled: false }),
  },
  {
    name: "resourcedetection a resource attribute in a flow mapping unticked",
    key: DETECTION,
    edit: async (user) => {
      await openSection(user, "Cloud & System Detectors");
      await user.click(byId("system-attr-1")); // host.id
    },
    from: "        host.id: {enabled: true}\n",
    to: "        host.id: {enabled: false}\n",
    check: (v) => expect(((v.system as Value).resource_attributes as Value)["host.id"]).toEqual({ enabled: false }),
  },
  {
    name: "resourcedetection a resource attribute written false ticked",
    key: DETECTION,
    edit: async (user) => {
      await openSection(user, "Cloud & System Detectors");
      await user.click(byId("system-attr-2")); // os.type
    },
    from: "        os.type:\n          enabled: false\n",
    to: "        os.type:\n          enabled: true\n",
    check: (v) => expect(((v.system as Value).resource_attributes as Value)["os.type"]).toEqual({ enabled: true }),
  },
  {
    name: "resourcedetection EC2 Max Attempts (unset) adds the ec2 block",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "AWS Detectors");
      await retypeInto(user, byId("ec2-max-attempts"), "5");
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    ec2:\n      max_attempts: 5\n  batch: {}\n",
    check: (v) => expect(v.ec2).toEqual({ max_attempts: 5 }),
  },
  {
    name: "resourcedetection EC2 Max Backoff (unset)",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "AWS Detectors");
      await retypeInto(user, byId("ec2-max-backoff"), "1m");
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    ec2:\n      max_backoff: 1m\n  batch: {}\n",
    check: (v) => expect(v.ec2).toEqual({ max_backoff: "1m" }),
  },
  {
    name: "resourcedetection EC2 Fail on Missing Metadata ticked",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "AWS Detectors");
      await user.click(box("Fail on Missing Metadata"));
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    ec2:\n      fail_on_missing_metadata: true\n  batch: {}\n",
    check: (v) => expect(v.ec2).toEqual({ fail_on_missing_metadata: true }),
  },
  {
    name: "resourcedetection EC2 Add Tag Pattern holds the row; typing appends the item",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "AWS Detectors");
      await user.click(screen.getByRole("button", { name: "Add Tag Pattern" }));
      await user.type(screen.getByPlaceholderText("e.g. ^environment$, ^team-.*"), "^team-.*");
      await user.tab();
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    ec2:\n      tags:\n        - ^team-.*\n  batch: {}\n",
    check: (v) => expect(v.ec2).toEqual({ tags: ["^team-.*"] }),
  },
  {
    name: "resourcedetection an EC2 resource attribute unticked",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "AWS Detectors");
      await user.click(byId("ec2-attr-7")); // host.name
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    ec2:\n      resource_attributes:\n        host.name:\n          enabled: false\n  batch: {}\n",
    check: (v) => expect(v.ec2).toEqual({ resource_attributes: { "host.name": { enabled: false } } }),
  },
  {
    name: "resourcedetection EKS Node Environment Variable (unset)",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "AWS Detectors");
      await retypeInto(user, byId("eks-node-env"), "MY_NODE");
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    eks:\n      node_from_env_var: MY_NODE\n  batch: {}\n",
    check: (v) => expect(v.eks).toEqual({ node_from_env_var: "MY_NODE" }),
  },
  {
    name: "resourcedetection Azure Add Tag Pattern holds the row; typing appends the item",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "Cloud & System Detectors");
      await user.click(screen.getByRole("button", { name: "Add Tag Pattern" }));
      await user.type(screen.getByPlaceholderText("e.g. ^environment$, ^team-.*"), "^environment$");
      await user.tab();
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    azure:\n      tags:\n        - ^environment$\n  batch: {}\n",
    check: (v) => expect(v.azure).toEqual({ tags: ["^environment$"] }),
  },
  {
    name: "resourcedetection a Docker resource attribute ticked (off by default)",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "Cloud & System Detectors");
      await user.click(byId("docker-attr-0")); // container.image.name
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    docker:\n      resource_attributes:\n        container.image.name:\n          enabled: true\n  batch: {}\n",
    check: (v) => expect(v.docker).toEqual({ resource_attributes: { "container.image.name": { enabled: true } } }),
  },
  {
    name: "resourcedetection Kubernetes Node Authentication Type (unset)",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "Kubernetes Detectors");
      await pickIn(user, byId("k8s-auth-type"), "Kube Config");
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    k8snode:\n      auth_type: kubeConfig\n  batch: {}\n",
    check: (v) => expect(v.k8snode).toEqual({ auth_type: "kubeConfig" }),
  },
  {
    name: "resourcedetection Kubernetes Node Environment Variable (unset)",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "Kubernetes Detectors");
      await retypeInto(user, byId("k8s-node-env"), "MY_NODE");
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    k8snode:\n      node_from_env_var: MY_NODE\n  batch: {}\n",
    check: (v) => expect(v.k8snode).toEqual({ node_from_env_var: "MY_NODE" }),
  },
  {
    name: "resourcedetection a Kubernetes Node resource attribute unticked",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "Kubernetes Detectors");
      await user.click(byId("k8snode-attr-1")); // k8s.node.uid
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    k8snode:\n      resource_attributes:\n        k8s.node.uid:\n          enabled: false\n  batch: {}\n",
    check: (v) => expect(v.k8snode).toEqual({ resource_attributes: { "k8s.node.uid": { enabled: false } } }),
  },
  {
    name: "resourcedetection OpenShift Kubernetes API Address (unset)",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "Kubernetes Detectors");
      await retypeInto(user, byId("openshift-address"), "https://api:6443");
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    openshift:\n      address: https://api:6443\n  batch: {}\n",
    check: (v) => expect(v.openshift).toEqual({ address: "https://api:6443" }),
  },
  {
    name: "resourcedetection OpenShift Service Account Token (unset)",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "Kubernetes Detectors");
      await retypeInto(user, byId("openshift-token"), "sa-token");
    },
    from: DETECTION_END,
    to: "        os.type:\n          enabled: false\n    openshift:\n      token: sa-token\n  batch: {}\n",
    check: (v) => expect(v.openshift).toEqual({ token: "sa-token" }),
  },
  {
    name: "resourcedetection OpenShift TLS ticked writes the TLS versions",
    key: DETECTION,
    base: DETECTION_ALL,
    edit: async (user) => {
      await openSection(user, "Kubernetes Detectors");
      await user.click(box("Customize TLS for OpenShift API"));
    },
    from: DETECTION_END,
    to: '        os.type:\n          enabled: false\n    openshift:\n      tls:\n        min_version: "1.2"\n        max_version: "1.3"\n  batch: {}\n',
    check: (v) => expect(v.openshift).toEqual({ tls: { min_version: "1.2", max_version: "1.3" } }),
  },
];

describe("every field of each form writes only its key (decision 2)", () => {
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

describe("undo and opening (decision 2)", () => {
  it("each edit is one undo entry named after the component", async () => {
    const user = renderForm(DETECTION);
    await user.click(box("ec2"));
    expect(selectUndoDescription(builderStore())).toMatch(/^Update /);
    expect(entries()).toBe(1);
  });

  // One test per form and text, each with its own time limit (D9c Ruling 54): together they took 2-5 s.
  const OPENING_TEXTS = [
    ["the corpus", CORPUS],
    ["the corpus in CRLF", CRLF(CORPUS)],
    ["k8sattributes waiting for metadata", ATTRS_WAITING],
    ["a bare k8sattributes", ATTRS_BARE],
    ["every detector with a section", DETECTION_ALL],
    ["every detector with a section, in CRLF", CRLF(DETECTION_ALL)],
    ["openstack and kubeadm", withDetectors("openstack, kubeadm")],
  ] as const;
  /** What each form shows once opened, at least, on the least of its texts: its text fields, every control, and a field each of its texts shows. */
  const OPENED: Record<string, { textboxes: number; all: number; field: string }> = {
    [ATTRS]: { textboxes: 2, all: 19, field: "metadata-0" },
    [DETECTION]: { textboxes: 1, all: 36, field: "detector-20" },
  };
  it.each([ATTRS, DETECTION].flatMap((key) => OPENING_TEXTS.map(([name, base]) => [key, name, base] as const)))(
    "opening %s on %s, every section, group and card, focusing every field, writes nothing and leaves the editor clean",
    async (key, _name, base) => {
      const user = renderForm(key, base);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      for (const group of ["Azure", "Google Cloud", "Kubernetes", "Container", "Other Clouds"]) {
        if (key === DETECTION) await openGroup(user, group);
      }
      // Opened, it shows the form's fields (D9c final review M6).
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

describe("resourcedetection: tag patterns are held rows (decisions 3 and 9)", () => {
  it.each([
    ["EC2", "AWS Detectors", withDetectors("ec2")],
    ["Azure", "Cloud & System Detectors", withDetectors("azure")],
  ])("%s: Add writes nothing (an empty regex matches every tag); left empty, the row goes", async (_name, section, base) => {
    const user = renderForm(DETECTION, base);
    await openSection(user, section);
    await user.click(screen.getByRole("button", { name: "Add Tag Pattern" }));
    const row = screen.getByPlaceholderText("e.g. ^environment$, ^team-.*");
    await user.click(row);
    await user.tab();
    expect(screen.queryByPlaceholderText("e.g. ^environment$, ^team-.*")).toBeNull();
    expect(text()).toBe(base);
    expect(entries()).toBe(0);
  });
});

describe("values the fields can't show (D9b decision 3)", () => {
  it("k8sattributes: rules, labels and metadata that aren't lists are read-only with the hint; the rest works", async () => {
    const base = CORPUS.replace(`    pod_association:\n${RULE_IP}${RULE_CONNECTION}`, "    pod_association: connection\n")
      .replace(`      labels:\n${LABEL}`, "      labels: {app: x}\n")
      .replace("      metadata:\n        - k8s.namespace.name\n        - k8s.pod.name # the pod\n", "      metadata: k8s.pod.name\n");
    const user = renderForm(ATTRS, base);
    await openSection(user, "Pod Association");
    await openSection(user, "Metadata Extraction");
    expect(screen.getAllByText("This value is written in a form this field can't show. Edit it in the YAML below.")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Add Rule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Label" })).toBeDisabled();
    expect(byId("metadata-0")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add Annotation" }));
    expect((valueOf(text(), ATTRS).extract as Value).annotations).toEqual([{ tag_name: "", key: "", from: "pod" }]);
  });

  it("resourcedetection: detectors that aren't a list are read-only with the hint; the rest works", async () => {
    const base = withDetectors("env").replace("    detectors: [env] # in order\n", "    detectors: env\n");
    const user = renderForm(DETECTION, base);
    expect(screen.getByText("This value is written in a form this field can't show. Edit it in the YAML below.")).toBeInTheDocument();
    expect(box("env")).toBeDisabled();
    await retypeInto(user, byId("timeout"), "3s");
    expect(valueOf(text(), DETECTION).timeout).toBe("3s");
  });
});

// ── k8sattributes' fixes (decision 3) ──

describe("k8sattributes: Extract OpenTelemetry Annotations writes only its key (decision 3)", () => {
  it("with no extract, ticking it writes extract.otel_annotations alone: no metadata: [] replacing the collector's default", async () => {
    // Not `extract: {metadata: [], otel_annotations: true}`: an empty metadata list replaces the
    // collector's default list (factory.go:45-51), so no pod, namespace or node metadata would be extracted.
    const user = renderForm(ATTRS, ATTRS_BARE);
    await openSection(user, "Metadata Extraction");
    await user.click(box("Extract OpenTelemetry Annotations"));
    expect(text()).toBe(ATTRS_BARE.replace("    passthrough: false\n", "    passthrough: false\n    extract:\n      otel_annotations: true\n"));
    expect(valueOf(text(), ATTRS).extract).toEqual({ otel_annotations: true });
    expect(text()).not.toContain("metadata: []");

    await user.click(box("Extract OpenTelemetry Annotations"));
    expect(valueOf(text(), ATTRS).extract).toEqual({ otel_annotations: false });
  });
});

describe("k8sattributes: no Derive Deployment Name (decision 3)", () => {
  it("isn't shown; a deployment_name_from_replicaset already in the text is left alone", async () => {
    // Not a key at v0.162.0 (config.go:22-60): the collector refuses it, and derives the name anyway.
    const base = CORPUS.replace("    passthrough: false\n", "    passthrough: false\n    deployment_name_from_replicaset: true # old\n");
    const user = renderForm(ATTRS, base);
    for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    expect(screen.queryByText("Derive Deployment Name from ReplicaSet")).toBeNull();
    expect(screen.queryByText("Trim the pod-template hash from the ReplicaSet name.")).toBeNull();

    await user.click(box("Passthrough Mode"));
    expect(text()).toBe(base.replace("    passthrough: false\n", "    passthrough: true\n"));
  });
});

describe("k8sattributes: Add Rule seeds a rule not already there (decision 3; Preflight ruling 16)", () => {
  const withRules = (rules: string) => CORPUS.replace(`${RULE_IP}${RULE_CONNECTION}`, rules);
  const rulesOf = () => valueOf(text(), ATTRS).pod_association as Value[];

  it("the collector's key: each source's from/name, sorted, so order doesn't matter (config.go:152-164)", () => {
    expect(ruleKey([{ from: "resource_attribute", name: "k8s.pod.ip" }, { from: "connection" }])).toBe(
      ruleKey([{ from: "connection" }, { from: "resource_attribute", name: "k8s.pod.ip" }]),
    );
    expect(ruleKey([{ from: "connection" }])).toBe("connection/");
    expect(SUGGESTED_RULES.map((rule) => ruleKey(rule.sources))).toEqual([
      "connection/",
      "resource_attribute/k8s.pod.ip",
      "resource_attribute/k8s.pod.uid",
    ]);
  });

  it.each([
    ["no rules", "", { from: "connection" }],
    ["a connection rule", RULE_CONNECTION, { from: "resource_attribute", name: "k8s.pod.ip" }],
    ["the ip rule", RULE_IP, { from: "connection" }],
    ["the ip and connection rules, the ip rule's sources in flow", `      - sources: [{name: k8s.pod.ip, from: resource_attribute}]\n${RULE_CONNECTION}`, { from: "resource_attribute", name: "k8s.pod.uid" }],
    // Two sources are another key than connection alone: the collector takes both rules.
    ["a two-source rule holding connection", "      - sources: [{from: connection}, {from: resource_attribute, name: k8s.pod.ip}]\n", { from: "connection" }],
    // A connection source with a name is another key (config.go:160 joins the name as written).
    ["a connection rule with a name", "      - sources: [{from: connection, name: ip}]\n", { from: "connection" }],
  ])("with %s, it seeds %o", async (_name, rules, seed) => {
    const base = rules === "" ? ATTRS_BARE : withRules(rules);
    const user = renderForm(ATTRS, base);
    await openSection(user, "Pod Association");
    await user.click(screen.getByRole("button", { name: "Add Rule" }));
    expect(rulesOf().at(-1)).toEqual({ sources: [seed] });
    expect(entries()).toBe(1);
  });

  it("with the three there, in any order, it is disabled with the hint; nothing is written", async () => {
    const base = withRules(
      `${RULE_CONNECTION}      - sources: [{from: resource_attribute, name: k8s.pod.uid}]\n${RULE_IP}`,
    );
    const user = renderForm(ATTRS, base);
    await openSection(user, "Pod Association");
    expect(screen.getByRole("button", { name: "Add Rule" })).toBeDisabled();
    expect(screen.getByText(ALL_RULES_PRESENT)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Rule" }));
    expect(text()).toBe(base);
  });

  it("adding the last suggestion disables it; removing a rule enables it again", async () => {
    const user = renderForm(ATTRS);
    await openSection(user, "Pod Association");
    await user.click(screen.getByRole("button", { name: "Add Rule" }));
    expect(screen.getByRole("button", { name: "Add Rule" })).toBeDisabled();
    expect(screen.getByText(ALL_RULES_PRESENT)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Remove rule" })[1]!);
    expect(screen.getByRole("button", { name: "Add Rule" })).toBeEnabled();
    expect(screen.queryByText(ALL_RULES_PRESENT)).toBeNull();
  });
});

// ── k8sattributes' cards ──

describe("k8sattributes: the cards move by item", () => {
  beforeEach(layOutRows);

  it("a rule dragged down moves its lines; the cards' fields follow it", async () => {
    const user = renderForm(ATTRS);
    await openSection(user, "Pod Association");
    const keyField = screen.getByRole("textbox", { name: "Resource attribute key" });
    const handles = within(cardOf(screen.getByText("Rule 1")).parentElement!.parentElement!).getAllByRole("button", { name: "Drag to reorder" });
    await dragByKeyboard(handles[0]!, 1);

    expect(text()).toBe(CORPUS.replace(`${RULE_IP}${RULE_CONNECTION}`, `${RULE_CONNECTION}${RULE_IP}`));
    expect(entries()).toBe(1);
    expect(screen.getByRole("textbox", { name: "Resource attribute key" })).toBe(keyField);
    expect(within(cardOf(screen.getByText("Rule 2"))).getByRole("textbox", { name: "Resource attribute key" })).toBe(keyField);
  });

  // D9c Ruling 35: the cards follow their items through undo, redo and the YAML box, not their positions.
  it("after a rule's move is undone and redone, each card and its fields are still its rule's", async () => {
    const user = renderForm(ATTRS);
    await openSection(user, "Pod Association");
    const keyField = screen.getByRole("textbox", { name: "Resource attribute key" });
    const handles = within(cardOf(screen.getByText("Rule 1")).parentElement!.parentElement!).getAllByRole("button", { name: "Drag to reorder" });
    await dragByKeyboard(handles[0]!, 1);

    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
    expect(within(cardOf(screen.getByText("Rule 1"))).getByRole("textbox", { name: "Resource attribute key" })).toBe(keyField);

    act(() => void builderStore().redo());
    expect(within(cardOf(screen.getByText("Rule 2"))).getByRole("textbox", { name: "Resource attribute key" })).toBe(keyField);
  });

  it("after a rule's removal is undone, the other rule keeps its card", async () => {
    const user = renderForm(ATTRS);
    await openSection(user, "Pod Association");
    const connection = cardOf(screen.getByText("Rule 2"));
    await user.click(screen.getAllByRole("button", { name: "Remove rule" })[0]!);
    expect(cardOf(screen.getByText("Rule 1"))).toBe(connection);

    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
    expect(cardOf(screen.getByText("Rule 2"))).toBe(connection);
  });

  it("after the YAML box reorders the rules, each card and its fields follow their rule", async () => {
    const user = renderForm(ATTRS);
    await openSection(user, "Pod Association");
    const keyField = screen.getByRole("textbox", { name: "Resource attribute key" });
    const swapped = CORPUS.replace(`${RULE_IP}${RULE_CONNECTION}`, `${RULE_CONNECTION}${RULE_IP}`);
    act(() => builderStore().setText(swapped));
    act(() => void builderStore().apply());
    expect(text()).toBe(swapped);
    expect(within(cardOf(screen.getByText("Rule 2"))).getByRole("textbox", { name: "Resource attribute key" })).toBe(keyField);
  });

  it("after a label's removal is undone, the other label keeps its card and its field", async () => {
    const base = CORPUS.replace(LABEL, `${LABEL}        - tag_name: team # second\n          key: team\n`);
    const user = renderForm(ATTRS, base);
    await openSection(user, "Metadata Extraction");
    const team = screen.getAllByRole("textbox", { name: "Tag name" })[1]!;
    await user.click(screen.getAllByRole("button", { name: "Remove label" })[0]!);
    act(() => void builderStore().undo());
    expect(text()).toBe(base);
    expect(screen.getAllByRole("textbox", { name: "Tag name" })[1]).toBe(team);
    expect(team).toHaveValue("team");
  });

  it("a rule's sources reorder by drag, each source's lines moving", async () => {
    const two = `${RULE_IP}          - from: connection # second\n`;
    const base = CORPUS.replace(RULE_IP, two);
    const user = renderForm(ATTRS, base);
    await openSection(user, "Pod Association");
    const rule = cardOf(screen.getByText("Rule 1"));
    // The rule's handle, then its two sources'.
    const handles = within(rule).getAllByRole("button", { name: "Drag to reorder" });
    expect(handles).toHaveLength(3);

    await dragByKeyboard(handles[1]!, 1);

    expect(text()).toBe(base.replace(two, "      - sources:\n          - from: connection # second\n          - from: resource_attribute\n            name: k8s.pod.ip\n"));
    expect(entries()).toBe(1);
  });

  it("a label typed into and dragged writes its typing first, into its own item; the card and its field follow it", async () => {
    const second = "        - tag_name: team # second\n          key: team\n";
    const base = CORPUS.replace(LABEL, `${LABEL}${second}`);
    const user = renderForm(ATTRS, base);
    await openSection(user, "Metadata Extraction");
    const tag = screen.getAllByRole("textbox", { name: "Tag name" })[0]!;
    await user.clear(tag);
    await user.type(tag, "service");
    const handles = screen.getAllByRole("button", { name: "Drag to reorder" });
    expect(handles).toHaveLength(2);

    await dragByKeyboard(handles[0]!, 1);

    const labels = (valueOf(text(), ATTRS).extract as Value).labels as Value[];
    expect(labels).toEqual([
      { tag_name: "team", key: "team" },
      { tag_name: "service", key: "app.kubernetes.io/name", from: "pod" },
    ]);
    expect(text()).toContain("        - tag_name: team # second\n");
    expect(screen.getAllByRole("textbox", { name: "Tag name" })[1]).toBe(tag);
    expect(tag).toHaveValue("service");
  });

  it("the Key/Regex switch moves the value back; a regex shows the capture hint and placeholders", async () => {
    const base = CORPUS.replace("          key: app.kubernetes.io/name\n", "          key_regex: 'app.kubernetes.io/(.*)' # regex\n");
    const user = renderForm(ATTRS, base);
    await openSection(user, "Metadata Extraction");
    expect(screen.getByRole("textbox", { name: "Key regex" })).toHaveValue("app.kubernetes.io/(.*)");
    expect(screen.getByText("Capture groups are referenced as $$1, $$2 in the tag name.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Tag name" })).toHaveAttribute("placeholder", "e.g. $$1");

    await pickIn(user, within(cardOf(screen.getByRole("textbox", { name: "Tag name" }))).getAllByRole("combobox")[0]!, "Key");

    expect(text()).toBe(base.replace("          key_regex: 'app.kubernetes.io/(.*)' # regex\n", "          key: 'app.kubernetes.io/(.*)' # regex\n"));
    expect(screen.getByRole("textbox", { name: "Label key" })).toHaveValue("app.kubernetes.io/(.*)");
  });

  it("a From outside the seven shows as an extra option, as written; unset shows the collector's pod", async () => {
    const base = CORPUS.replace("          from: pod\n", "          from: replicaset\n");
    const user = renderForm(ATTRS, base);
    await openSection(user, "Metadata Extraction");
    const from = within(cardOf(screen.getByRole("textbox", { name: "Tag name" }))).getAllByRole("combobox")[1]!;
    expect(from).toHaveTextContent("replicaset");
    await user.click(from);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Pod",
      "Namespace",
      "Deployment",
      "StatefulSet",
      "DaemonSet",
      "Job",
      "Node",
      "replicaset",
    ]);
    await user.keyboard("{Escape}");

    cleanup();
    useEditorStore.setState(initialState, true);
    const again = renderForm(ATTRS, CORPUS.replace("          from: pod\n", ""));
    await openSection(again, "Metadata Extraction");
    expect(within(cardOf(screen.getByRole("textbox", { name: "Tag name" }))).getAllByRole("combobox")[1]).toHaveTextContent("Pod");
  });
});

// ── What the forms show (decision 3; decision 5; Preflight ruling 10) ──

// ── The review's fixes (D9c Rulings 41-43) ──

describe("k8sattributes: the Key/Regex switch never loses a value (Ruling 41)", () => {
  const withLabel = (label: string) => CORPUS.replace(LABEL, label);
  const switchOf = () => within(cardOf(screen.getByRole("textbox", { name: "Tag name" }))).getAllByRole("combobox")[0]!;

  it.each([
    ["key_regex a list, key a string", "        - tag_name: app\n          key: k\n          key_regex: [a, b]\n          from: pod\n"],
    ["key a mapping", "        - tag_name: app\n          key: {name: x}\n          from: pod\n"],
    ["key on two lines", '        - tag_name: app\n          key: "a\\nb"\n          from: pod\n'],
  ])("with %s, the switch is disabled; nothing is overwritten", async (_name, label) => {
    const base = withLabel(label);
    const user = renderForm(ATTRS, base);
    await openSection(user, "Metadata Extraction");
    expect(switchOf()).toBeDisabled();
    await user.click(switchOf());
    expect(screen.queryByRole("option", { name: "Key" })).toBeNull();
    expect(text()).toBe(base);
  });

  it("over a target written as a null, it sets the target and removes the source in one write, with no toast", async () => {
    const base = withLabel("        - tag_name: app\n          key: app.kubernetes.io/name\n          key_regex: ~\n          from: pod\n");
    const user = renderForm(ATTRS, base);
    await openSection(user, "Metadata Extraction");
    expect(switchOf()).toHaveTextContent("Key");
    await pickIn(user, switchOf(), "Regex");
    expect(toast.error).not.toHaveBeenCalled();
    expect(((valueOf(text(), ATTRS).extract as Value).labels as Value[])[0]).toEqual({
      tag_name: "app",
      key_regex: "app.kubernetes.io/name",
      from: "pod",
    });
    expect(entries()).toBe(1);
    expect(screen.getByRole("textbox", { name: "Key regex" })).toHaveValue("app.kubernetes.io/name");
  });
});

describe("resourcedetection: hostname sources [] is the collector's dns, os (decision 4; Ruling 42)", () => {
  // The collector uses dns, os when the list is empty (internal/system/system.go:48-50).
  const EMPTY = CORPUS.replace("      hostname_sources: [os]\n", "      hostname_sources: []\n");

  it("[] shows dns and os ticked with the hint; the first tick writes them with it, replacing []", async () => {
    const user = renderForm(DETECTION, EMPTY);
    await openSection(user, "Cloud & System Detectors");
    expect(box("DNS - FQDN via DNS lookup")).toBeChecked();
    expect(box("OS - Kernel-reported hostname")).toBeChecked();
    expect(box("CNAME - Canonical name lookup")).not.toBeChecked();
    expect(hint("Methods tried in priority order. · Default dns, os")).toBeInTheDocument();

    await user.click(box("CNAME - Canonical name lookup"));
    expect((valueOf(text(), DETECTION).system as Value).hostname_sources).toEqual(["dns", "os", "cname"]);
    expect(entries()).toBe(1);
  });

  it("unticking the last source still leaves [], which then shows dns and os", async () => {
    const user = renderForm(DETECTION);
    await openSection(user, "Cloud & System Detectors");
    await user.click(box("OS - Kernel-reported hostname"));
    expect(text()).toBe(EMPTY);
    expect(box("DNS - FQDN via DNS lookup")).toBeChecked();
    expect(box("OS - Kernel-reported hostname")).toBeChecked();
  });
});

describe("k8sattributes: a rule's sources keep their rows (Ruling 43)", () => {
  const TWO = "      - sources:\n          - from: resource_attribute\n            name: k8s.pod.ip\n          - from: resource_attribute\n            name: k8s.pod.name\n";
  const SWAPPED = "      - sources:\n          - from: resource_attribute\n            name: k8s.pod.name\n          - from: resource_attribute\n            name: k8s.pod.ip\n";

  it("after the YAML box swaps two sources, each row and a held edit in it stay with their source", async () => {
    const base = CORPUS.replace(RULE_IP, TWO);
    const user = renderForm(ATTRS, base);
    await openSection(user, "Pod Association");
    const [ip, name] = screen.getAllByRole("textbox", { name: "Resource attribute key" });
    // Typed and still held (not left, the pause not over).
    await user.clear(ip!);
    await user.type(ip!, "k8s.pod.uid");

    act(() => builderStore().setText(base.replace(TWO, SWAPPED)));
    act(() => void builderStore().apply());

    expect(screen.getAllByRole("textbox", { name: "Resource attribute key" })).toEqual([name, ip]);
    await user.tab();
    const sources = (valueOf(text(), ATTRS).pod_association as Value[])[0]!.sources;
    expect(sources).toEqual([
      { from: "resource_attribute", name: "k8s.pod.name" },
      { from: "resource_attribute", name: "k8s.pod.uid" },
    ]);
  });

  it("a source's row stays its own through its removal undone", async () => {
    const base = CORPUS.replace(RULE_IP, TWO);
    const user = renderForm(ATTRS, base);
    await openSection(user, "Pod Association");
    const name = screen.getAllByRole("textbox", { name: "Resource attribute key" })[1]!;
    await user.click(screen.getAllByRole("button", { name: "Remove source" })[0]!);
    expect(screen.getByRole("textbox", { name: "Resource attribute key" })).toBe(name);
    act(() => void builderStore().undo());
    expect(text()).toBe(base);
    expect(screen.getAllByRole("textbox", { name: "Resource attribute key" })[1]).toBe(name);
  });
});

describe("what the forms show", () => {
  it("k8sattributes unset: Default serviceAccount; no standard attribute ticked, with the collector's default in the hint", async () => {
    const user = renderForm(ATTRS, ATTRS_BARE);
    expect(byId("auth-type")).toHaveTextContent("Service Account (recommended)");
    expect(hint("How to authenticate with the Kubernetes API. · Default serviceAccount")).toBeInTheDocument();
    await openSection(user, "Metadata Extraction");
    for (let index = 0; index < 13; index++) expect(byId(`metadata-${index}`)).not.toBeChecked();
    // factory.go:45-51 with both conventions gates on (Preflight ruling 10).
    expect(
      hint(
        "Default container.image.name, container.image.tags, k8s.deployment.name, k8s.namespace.name, k8s.node.name, k8s.pod.name, k8s.pod.start_time, k8s.pod.uid",
      ),
    ).toBeInTheDocument();
    // The first tick writes that item alone (decision 5).
    await user.click(box("k8s.pod.name"));
    expect(valueOf(text(), ATTRS).extract).toEqual({ metadata: ["k8s.pod.name"] });
  });

  it("k8sattributes: a metadata item outside the 13 shows after them, ticked, as text, and can be unticked", async () => {
    const base = CORPUS.replace("        - k8s.pod.name # the pod\n", "        - k8s.pod.name # the pod\n        - container.id\n");
    const user = renderForm(ATTRS, base);
    await openSection(user, "Metadata Extraction");
    expect(byId("metadata-13")).toBeChecked();
    expect(screen.getByText("container.id")).toBeInTheDocument();
    await user.click(byId("metadata-13"));
    expect(text()).toBe(CORPUS);
  });

  it("k8sattributes: Wait Timeout shows only while waiting for metadata, with Default 10s", () => {
    renderForm(ATTRS);
    expect(byId("wait-timeout")).toBeNull();
    cleanup();
    renderForm(ATTRS, ATTRS_WAITING);
    expect(byId("wait-timeout")).toHaveAttribute("placeholder", "10s");
    expect(hint("Default 10s")).toBeInTheDocument();
  });

  it("resourcedetection unset: no detector ticked, Default env; the first tick writes that detector alone", async () => {
    const base = CORPUS.replace("    detectors: [env, system] # in order\n", "");
    const user = renderForm(DETECTION, base);
    expect(hint("Order matters: the first detector wins; reorder via the YAML editor. · Default env")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox", { checked: true }).map((c) => c.id)).toEqual([]);
    await user.click(box("system"));
    expect(valueOf(text(), DETECTION).detectors).toEqual(["system"]);
  });

  it("resourcedetection: Timeout Default 5s and Override on while unset", () => {
    renderForm(DETECTION, CORPUS.replace("    timeout: 2s\n    override: false\n", ""));
    expect(byId("timeout")).toHaveAttribute("placeholder", "5s");
    expect(hint("Maximum time to wait for all detectors. · Default 5s")).toBeInTheDocument();
    expect(box("Override Existing Attributes")).toBeChecked();
  });

  it("resourcedetection: Hostname Sources shows dns and os while unset, Default dns, os", async () => {
    const base = CORPUS.replace("      hostname_sources: [os]\n", "");
    const user = renderForm(DETECTION, base);
    await openSection(user, "Cloud & System Detectors");
    expect(box("DNS - FQDN via DNS lookup")).toBeChecked();
    expect(box("OS - Kernel-reported hostname")).toBeChecked();
    expect(box("CNAME - Canonical name lookup")).not.toBeChecked();
    expect(hint("Methods tried in priority order. · Default dns, os")).toBeInTheDocument();
  });

  it("resourcedetection: the AWS order alert, and the chips", () => {
    renderForm(DETECTION, withDetectors("ec2, eks"));
    expect(screen.getByText("AWS detector order")).toBeInTheDocument();
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(DETECTION, withDetectors("eks, ec2"));
    expect(screen.queryByText("AWS detector order")).toBeNull();
  });
});

describe("resourcedetection: each resource attribute shows the collector's default (decision 4)", () => {
  it("unset, every box shows its metadata.yaml default (most of eks' and system's are off), not every one ticked", async () => {
    const base = DETECTION_ALL.replace(/ {6}resource_attributes:\n[\s\S]*? {10}enabled: false\n/, "");
    const user = renderForm(DETECTION, base);
    for (const section of ["AWS Detectors", "Cloud & System Detectors", "Kubernetes Detectors"]) await openSection(user, section);
    let off = 0;
    for (const [detector, attributes] of Object.entries(RESOURCE_ATTRIBUTE_BOXES)) {
      attributes.forEach((attribute, index) => {
        const expected = attributeDefault(detector, attribute);
        if (!expected) off++;
        expect({ detector, attribute, checked: byId(`${detector}-attr-${index}`).getAttribute("aria-checked") }).toEqual({
          detector,
          attribute,
          checked: String(expected),
        });
      });
    }
    // eks: only cloud.platform and cloud.provider (internal/aws/eks/metadata.yaml:6-66).
    expect(RESOURCE_ATTRIBUTE_BOXES.eks!.filter((attribute) => attributeDefault("eks", attribute))).toEqual(["cloud.provider", "cloud.platform"]);
    // system: only host.name and os.type (internal/system/metadata.yaml:6-106).
    expect(RESOURCE_ATTRIBUTE_BOXES.system!.filter((attribute) => attributeDefault("system", attribute))).toEqual(["host.name", "os.type"]);
    // eks 8, azure 1, gcp 2, system 15, docker 2; ec2, ecs and k8snode none.
    expect(off).toBe(8 + 1 + 2 + 15 + 2);
    expect(text()).toBe(base);
  });

  it("a value in the text shows as written, over the default", async () => {
    const user = renderForm(DETECTION);
    await openSection(user, "Cloud & System Detectors");
    expect(byId("system-attr-1")).toBeChecked(); // host.id: {enabled: true}, off by default
    expect(byId("system-attr-2")).not.toBeChecked(); // os.type: enabled: false, on by default
  });
});

describe("resourcedetection: the collector's detector catalog (decision 6)", () => {
  it("offers nova for OpenStack, and ten more detectors, with no settings sections for them", async () => {
    const user = renderForm(DETECTION, withDetectors("nova, alibaba_ecs, azureappservice, k8s_api, kubeadm, dynatrace"));
    for (const group of ["Azure", "Kubernetes", "Other Clouds"]) await openGroup(user, group);
    expect(screen.queryByText("openstack")).toBeNull();
    expect(screen.getByText("OpenStack Nova instance")).toBeInTheDocument();
    for (const detector of ["nova", "alibaba_ecs", "azureappservice", "k8s_api", "kubeadm", "dynatrace"]) expect(box(detector)).toBeChecked();
    for (const detector of ["azurecontainerapps", "azurefunctions", "ibmcloud_classic", "ibmcloud_vpc", "tencent_cvm"]) {
      expect(box(detector)).not.toBeChecked();
    }
    for (const section of ["AWS Detectors", "Cloud & System Detectors", "Kubernetes Detectors"]) await openSection(user, section);
    expect(screen.getByText("Select the EC2, ECS, or EKS detector above to configure it here.")).toBeInTheDocument();
    expect(screen.getByText("Select the Azure, GCP, System, or Docker detector above to configure it here.")).toBeInTheDocument();
    expect(screen.getByText("Select the Kubernetes Node or OpenShift detector above to configure it here.")).toBeInTheDocument();
  });

  it("an openstack in the text shows after the groups, ticked, as text; unticking it removes it, and it is never lost", async () => {
    // `openstack` isn't a detector at v0.162.0 (factory.go:73-105); the collector refuses it.
    const base = withDetectors("env, openstack, system");
    const user = renderForm(DETECTION, base);
    expect(box("openstack")).toBeChecked();
    expect(box("openstack").id).toBe("detector-33");
    // Other edits keep it.
    await user.click(box("ec2"));
    expect(valueOf(text(), DETECTION).detectors).toEqual(["env", "openstack", "system", "ec2"]);
    await user.click(box("openstack"));
    expect(valueOf(text(), DETECTION).detectors).toEqual(["env", "system", "ec2"]);
    expect(screen.queryByText("openstack")).toBeNull();
  });

  it("the Client Timeout fields are gone; a client_config already in the text is left alone", async () => {
    // ecs, gcp and docker have no client_config (internal/aws/ecs/config.go:11, internal/gcp/config.go:13-14,
    // internal/docker/config.go:11); the top-level timeout is their client's (config.go:56-58).
    const base = DETECTION_ALL.replace("  batch: {}\n", "    gcp:\n      client_config: {timeout: 5s}\n  batch: {}\n");
    const user = renderForm(DETECTION, base);
    for (const section of ["AWS Detectors", "Cloud & System Detectors", "Kubernetes Detectors"]) await openSection(user, section);
    expect(screen.getByText("ECS")).toBeInTheDocument();
    expect(screen.getByText("GCP")).toBeInTheDocument();
    expect(screen.getByText("Docker")).toBeInTheDocument();
    expect(screen.queryByText("Client Timeout")).toBeNull();
    await user.click(byId("gcp-attr-0"));
    expect(valueOf(text(), DETECTION).gcp).toEqual({ client_config: { timeout: "5s" }, resource_attributes: { "cloud.provider": { enabled: false } } });
  });

  it("the Kubernetes Node section shows for k8snode only: k8s_api reads k8s_api.*, and has none (Preflight ruling 27)", async () => {
    // config.go:156-160, 265-268: k8snode reads `k8snode`, k8s_api reads `k8s_api`.
    let user = renderForm(DETECTION, withDetectors("k8s_api"));
    await openSection(user, "Kubernetes Detectors");
    expect(screen.queryByText("Kubernetes Node")).toBeNull();
    expect(screen.getByText("Select the Kubernetes Node or OpenShift detector above to configure it here.")).toBeInTheDocument();

    cleanup();
    useEditorStore.setState(initialState, true);
    user = renderForm(DETECTION, withDetectors("k8snode"));
    await openSection(user, "Kubernetes Detectors");
    expect(screen.getByText("Kubernetes Node")).toBeInTheDocument();
    // Unset shows the collector's serviceAccount (internal/k8sapi/config.go:51-55; Ruling 31).
    expect(byId("k8s-auth-type")).toHaveTextContent("Service Account (recommended)");
    expect(hint("Default serviceAccount")).toBeInTheDocument();
  });

  it("OpenShift's TLS is the client variant: no Client CA fields, and off says what the collector trusts", async () => {
    // openshift.tls is a configtls.ClientConfig (internal/openshift/config.go:50-52); unset CA → the SA's (:75-77).
    const base = DETECTION_ALL.replace("  batch: {}\n", "    openshift:\n      tls:\n        ca_file: /etc/ca.crt\n  batch: {}\n");
    const user = renderForm(DETECTION, base);
    await openSection(user, "Kubernetes Detectors");
    expect(screen.getByText(OPENSHIFT_TLS_HINT)).toBeInTheDocument();
    expect(box("Customize TLS for OpenShift API")).toBeChecked();
    expect(byId("tls-ca-file-openshift-api")).toHaveValue("/etc/ca.crt");
    expect(screen.queryByText("Client CA File")).toBeNull();
    expect(screen.queryByText("Enable client CA file reload")).toBeNull();
  });
});

// ── Ruling 85: boxes level with their labels ──

describe("resourcedetection: the boxes sit level with their labels (Ruling 85)", () => {
  // Measured in Chromium, WebKit and Firefox: a detector's box sat 4.5 px above its name's line without the shift.
  it("a detector's box is moved down 2 px beside its name and description, which stack in a grid", () => {
    renderForm(DETECTION);
    expect(box("system")).toHaveClass("mt-0.5");
    const name = screen.getByText("system", { selector: "label" });
    expect(name.parentElement).toHaveClass("flex-1", "grid", "gap-0.5");
    expect(screen.getByText(DETECTOR_DESCRIPTIONS.system!)).not.toHaveClass("mt-0.5");
  });

  it("the resource attributes' and hostname sources' boxes, level already, are left as they were", async () => {
    const user = renderForm(DETECTION);
    await openSection(user, "Cloud & System Detectors");
    for (const id of ["system-attr-0", "hostname-0", "override"]) expect(byId(id)).not.toHaveClass("mt-0.5");
  });
});

// ── Privacy (decision 10) ──

describe("privacy (decision 10)", () => {
  beforeEach(layOutRows);

  // Its own time limit (D9c Rulings 54 and 80).
  it("puts no config value in any attribute: every section, group and card open, the menus open, drags in progress", async () => {
    const MARK = "zq-mark";
    const marked = [
      "processors:",
      "  k8sattributes:",
      `    auth_type: ${MARK}-auth`,
      "    passthrough: true",
      "    wait_for_metadata: true",
      `    wait_for_metadata_timeout: ${MARK}-wait`,
      "    filter:",
      `      namespace: ${MARK}-ns`,
      `      node_from_env_var: ${MARK}-node`,
      "    pod_association:",
      "      - sources:",
      `          - from: ${MARK}-from`,
      "          - from: resource_attribute",
      `            name: ${MARK}-name`,
      "    extract:",
      `      metadata: [k8s.pod.name, ${MARK}-meta]`,
      "      labels:",
      `        - tag_name: ${MARK}-tag`,
      `          key: ${MARK}-key`,
      `          from: ${MARK}-lfrom`,
      "      annotations:",
      `        - tag_name: ${MARK}-atag`,
      `          key_regex: ${MARK}-regex`,
      "  resourcedetection:",
      `    detectors: [${MARK}-det, env, system, ec2, eks, azure, k8snode, openshift, docker, gcp, ecs]`,
      `    timeout: ${MARK}-timeout`,
      "    ec2:",
      `      tags: [${MARK}-ec2tag]`,
      `      max_attempts: ${MARK}-attempts`,
      `      max_backoff: ${MARK}-backoff`,
      "    eks:",
      `      node_from_env_var: ${MARK}-eks`,
      "    azure:",
      `      tags: [${MARK}-aztag]`,
      "    system:",
      `      hostname_sources: [dns, ${MARK}-source]`,
      "    k8snode:",
      `      auth_type: ${MARK}-k8sauth`,
      `      node_from_env_var: ${MARK}-k8snode`,
      "    openshift:",
      `      address: ${MARK}-address`,
      `      token: ${MARK}-token`,
      "      tls:",
      `        ca_file: ${MARK}-ca`,
      `        min_version: ${MARK}-min`,
      "exporters:",
      "  debug: {}",
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc: {}",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      processors: [k8sattributes, resourcedetection]",
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

    const runs: [string, () => HTMLElement[]][] = [
      [ATTRS, () => [byId("auth-type"), ...screen.getAllByRole("combobox").filter((c) => c.textContent?.includes(MARK))]],
      [DETECTION, () => [byId("k8s-auth-type"), byId("tls-min-version-openshift-api")]],
    ];
    for (const [key, menus] of runs) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, marked);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      if (key === DETECTION) for (const group of ["Azure", "Google Cloud", "Kubernetes", "Container", "Other Clouds"]) await openGroup(user, group);
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

      const triggers = menus();
      expect(triggers.length).toBeGreaterThan(1);
      for (const trigger of triggers) {
        await user.click(trigger);
        expect(screen.getAllByRole("option").some((o) => o.textContent?.includes(MARK))).toBe(true);
        scan(`${key} (menu)`);
        await user.keyboard("{Escape}");
      }
      expect(text()).toBe(marked);
      expect(entries()).toBe(0);
    }
    expect(leaks).toEqual([]);
  }, 20_000);
});

// ── D9c Ruling 55: two labels that read alike ──

describe("k8sattributes: a card keeps its label when another reads alike (Ruling 55)", () => {
  // Its own time limit (D9c Rulings 54 and 80).
  it("two identical labels: slow typing in the first's Tag name stays in the first, focus kept", async () => {
    const base = CORPUS.replace(LABEL, LABEL + LABEL);
    const user = renderForm(ATTRS, base);
    await openSection(user, "Metadata Extraction");
    const tag = screen.getAllByRole("textbox", { name: "Tag name" })[0]!;
    await user.click(tag);
    for (const key of ["x", "y"]) {
      await user.keyboard(key);
      // Past the 300 ms pause: each key is written as it's typed.
      await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 350))));
    }
    expect(((valueOf(text(), ATTRS).extract as Value).labels as Value[]).map((l) => l.tag_name)).toEqual(["appxy", "app"]);
    expect(document.activeElement).toBe(tag);
    expect(screen.getAllByRole("textbox", { name: "Tag name" })[0]).toBe(tag);
  }, 20_000);
});
