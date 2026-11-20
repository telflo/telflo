import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { AttributesProcessorForm } from "./AttributesProcessorForm.js";
import { FILTER_EXAMPLES, FilterProcessorForm } from "./FilterProcessorForm.js";
import { FormProvider, useComponentForm } from "./form-context.js";
import { ResourceProcessorForm } from "./ResourceProcessorForm.js";
import { selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The resource, attributes and filter forms: their forms over sortable
 * lists and item paths. Each field is driven as a person would (typing,
 * clicking, picking, dragging by keyboard) and writes only its key: the
 * text changes in that key's lines only, on a text with comments, an anchor
 * and a merge, `0750`, and CRLF line endings. Reordering moves an item's
 * own lines, its comments and `0750` with it. resource's action change
 * keeps the item's other keys; attributes' cache is written under
 * `include`/`exclude` `.regexp`, and a top-level `cacheenabled` is left
 * alone.
 */

const FORMS = [
  "# The resource, attributes and filter forms.",
  "receivers:",
  "  otlp:",
  "    protocols:",
  "      grpc: {}",
  "processors:",
  "  resource: # the resource",
  "    attributes:",
  "      # the environment",
  "      - key: environment # env",
  "        value: production",
  "        action: insert",
  "      - key: mode # the mode",
  "        value: 0750 # octal to the collector",
  "        action: upsert",
  "        converted_type: int",
  "      - key: secret",
  "        action: delete # gone",
  "        pattern: ^secret_.*",
  "      - {key: user, from_context: auth.subject, action: upsert}",
  "  attributes/base: &shared",
  "    actions:",
  "      - key: shared",
  "        action: delete",
  "  attributes/merged:",
  "    <<: *shared # the shared actions",
  "    include:",
  "      match_type: strict",
  "      services: [merged]",
  "  attributes:",
  "    actions:",
  "      - key: env # the env",
  "        action: insert",
  "        value: 42",
  "      - key: db.password",
  "        action: hash # scrub",
  "        pattern: ^pw_.*",
  "      - key: http.url",
  "        action: extract",
  "        pattern: ^(?P<scheme>.*)://",
  "      - key: status",
  "        action: convert",
  "        converted_type: int",
  "      - key: peer",
  "        action: upsert",
  "        from_attribute: net.peer.name",
  "    include:",
  "      match_type: regexp # patterns",
  "      services: [front, back]",
  "      regexp:",
  "        cacheenabled: true",
  "    exclude:",
  "      match_type: strict",
  "      span_names:",
  "        - health # probes",
  "      metric_names: [up]",
  "    cacheenabled: true # top-level, left alone",
  "  filter:",
  "    error_mode: propagate # strict",
  "    traces:",
  "      span:",
  "        # the first",
  "        - 'attributes[\"a\"] == \"x\"' # a",
  "        - 0750 # octal",
  "        - name == \"b\"",
  "      spanevent: []",
  "    metrics:",
  "      datapoint:",
  "        - attributes[\"pod.phase\"] == \"Pending\"",
  "    logs:",
  "      log_record: [severity_number < 9]",
  "exporters:",
  "  debug: {}",
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      processors: [resource, attributes, attributes/merged, filter]",
  "      exporters: [debug]",
  "",
].join("\n");

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

function renderForm(key: string, form: ReactNode, text = FORMS) {
  openText(text);
  const user = userEvent.setup();
  render(<ComponentForm nodeId={componentNamed(key).id}>{form}</ComponentForm>);
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
const textboxes = (name: string) => screen.getAllByRole("textbox", { name }) as HTMLInputElement[];
/** A hint line, by its whole text ("… · Default ignore" spans elements). */
const hint = (whole: string) =>
  screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
const valueOf = (written: string, key: string): unknown => {
  const [section, name] = key.split(".") as [string, string];
  return (parseYaml(written, { merge: true }) as Record<string, Record<string, unknown>>)[section]![name];
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

/** Opens an attributes action card by its header's text. */
async function openCard(user: UserEvent, header: string) {
  await user.click(screen.getByText(header));
}

// ── Sortable rows by keyboard ──

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

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  key: string;
  form: ReactNode;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Checks the component's value after, as parsed. */
  check: (value: unknown) => void;
}

const RESOURCE = "processors.resource";
const ATTRIBUTES = "processors.attributes";
const FILTER = "processors.filter";

type Item = Record<string, unknown>;
const itemsOf = (value: unknown, list: string) => (value as Record<string, Item[]>)[list]!;

const CASES: FieldCase[] = [
  // resource
  {
    name: "resource Key",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => retypeInto(user, byId("attr-0-key"), "deployment.environment"),
    from: "      - key: environment # env\n",
    to: "      - key: deployment.environment # env\n",
    check: (v) => expect(itemsOf(v, "attributes")[0]).toEqual({ key: "deployment.environment", value: "production", action: "insert" }),
  },
  {
    name: "resource literal Value",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => retypeInto(user, textboxes("Value")[0]!, "staging"),
    from: "        value: production\n",
    to: "        value: staging\n",
    check: (v) => expect(itemsOf(v, "attributes")[0]).toEqual({ key: "environment", value: "staging", action: "insert" }),
  },
  {
    name: "resource Value cleared writes an empty value (the item keeps its value key)",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => retypeInto(user, textboxes("Value")[0]!, ""),
    from: "        value: production\n",
    to: '        value: ""\n',
    check: (v) => expect(itemsOf(v, "attributes")[0]).toEqual({ key: "environment", value: "", action: "insert" }),
  },
  {
    name: "resource Context key (a flow item)",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => retypeInto(user, screen.getByRole("textbox", { name: "Context key" }), "auth.claims"),
    from: "      - {key: user, from_context: auth.subject, action: upsert}\n",
    to: "      - {key: user, from_context: auth.claims, action: upsert}\n",
    check: (v) => expect(itemsOf(v, "attributes")[3]).toEqual({ key: "user", from_context: "auth.claims", action: "upsert" }),
  },
  {
    name: "resource Key Pattern (delete)",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => retypeInto(user, byId("attr-2-pattern"), "^token_.*"),
    from: "        pattern: ^secret_.*\n",
    to: "        pattern: ^token_.*\n",
    check: (v) => expect(itemsOf(v, "attributes")[2]).toEqual({ key: "secret", action: "delete", pattern: "^token_.*" }),
  },
  {
    name: "resource Action upsert -> update: only action changes; 0750 and converted_type stay",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => pickIn(user, byId("attr-1-action"), "Update"),
    from: "        action: upsert\n        converted_type: int\n",
    to: "        action: update\n        converted_type: int\n",
    check: (v) => expect(itemsOf(v, "attributes")[1]).toEqual({ key: "mode", value: 750, action: "update", converted_type: "int" }),
  },
  {
    name: "resource Action upsert -> delete: the value goes, converted_type stays",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => pickIn(user, byId("attr-1-action"), "Delete"),
    from: "        value: 0750 # octal to the collector\n        action: upsert\n",
    to: "        action: delete\n",
    check: (v) => expect(itemsOf(v, "attributes")[1]).toEqual({ key: "mode", action: "delete", converted_type: "int" }),
  },
  {
    name: "resource Action delete -> insert: the pattern goes, an empty value comes",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => pickIn(user, byId("attr-2-action"), "Insert"),
    from: "        action: delete # gone\n        pattern: ^secret_.*\n",
    to: '        action: insert # gone\n        value: ""\n',
    check: (v) => expect(itemsOf(v, "attributes")[2]).toEqual({ key: "secret", action: "insert", value: "" }),
  },
  {
    name: "resource Value Source literal -> from attribute swaps just those keys",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => pickIn(user, byId("attr-0-source"), "From attribute"),
    from: "        value: production\n        action: insert\n",
    to: '        action: insert\n        from_attribute: ""\n',
    check: (v) => expect(itemsOf(v, "attributes")[0]).toEqual({ key: "environment", action: "insert", from_attribute: "" }),
  },
  {
    name: "resource Add Attribute appends the seeded item",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => user.click(screen.getByRole("button", { name: "Add Attribute" })),
    from: "      - {key: user, from_context: auth.subject, action: upsert}\n",
    to: '      - {key: user, from_context: auth.subject, action: upsert}\n      - key: ""\n        value: ""\n        action: insert\n',
    check: (v) => expect(itemsOf(v, "attributes")[4]).toEqual({ key: "", value: "", action: "insert" }),
  },
  {
    name: "resource Remove attribute removes the item's lines",
    key: RESOURCE,
    form: <ResourceProcessorForm />,
    edit: (user) => user.click(screen.getAllByRole("button", { name: "Remove attribute" })[1]!),
    from: "      - key: mode # the mode\n        value: 0750 # octal to the collector\n        action: upsert\n        converted_type: int\n",
    to: "",
    check: (v) => expect(itemsOf(v, "attributes").map((item) => item.key)).toEqual(["environment", "secret", "user"]),
  },

  // attributes
  {
    name: "attributes Attribute Key",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: (user) => retypeInto(user, byId("action-0-key"), "environment"),
    from: "      - key: env # the env\n",
    to: "      - key: environment # the env\n",
    check: (v) => expect(itemsOf(v, "actions")[0]).toEqual({ key: "environment", action: "insert", value: 42 }),
  },
  {
    name: "attributes Value (42 retyped)",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: (user) => retypeInto(user, byId("action-0-value"), "production"),
    from: "        value: 42\n",
    to: "        value: production\n",
    check: (v) => expect(itemsOf(v, "actions")[0]).toEqual({ key: "env", action: "insert", value: "production" }),
  },
  {
    name: "attributes Action Type insert -> delete rebuilds the action keeping its key",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: (user) => pickIn(user, byId("action-0-type"), "Delete - Remove attribute"),
    from: "        action: insert\n        value: 42\n",
    to: "        action: delete\n",
    check: (v) => expect(itemsOf(v, "actions")[0]).toEqual({ key: "env", action: "delete" }),
  },
  {
    name: "attributes Action Type insert -> upsert resets the value",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: (user) => pickIn(user, byId("action-0-type"), "Upsert - Insert or update"),
    from: "        action: insert\n        value: 42\n",
    to: '        action: upsert\n        value: ""\n',
    check: (v) => expect(itemsOf(v, "actions")[0]).toEqual({ key: "env", action: "upsert", value: "" }),
  },
  {
    name: "attributes Value Source literal -> from context seeds client.address",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: (user) => pickIn(user, byId("action-0-source"), "From context"),
    from: "        value: 42\n",
    to: "        from_context: client.address\n",
    check: (v) => expect(itemsOf(v, "actions")[0]).toEqual({ key: "env", action: "insert", from_context: "client.address" }),
  },
  {
    name: "attributes Source Attribute",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openCard(user, "Upsert: peer");
      await retypeInto(user, byId("action-4-from-attr"), "server.address");
    },
    from: "        from_attribute: net.peer.name\n",
    to: "        from_attribute: server.address\n",
    check: (v) => expect(itemsOf(v, "actions")[4]).toEqual({ key: "peer", action: "upsert", from_attribute: "server.address" }),
  },
  {
    name: "attributes Target Type pattern -> key (hash)",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openCard(user, "Hash: db.password");
      await pickIn(user, byId("action-1-target"), "Single Attribute Key");
    },
    from: "        pattern: ^pw_.*\n",
    to: "",
    check: (v) => expect(itemsOf(v, "actions")[1]).toEqual({ key: "db.password", action: "hash" }),
  },
  {
    name: "attributes Regex Pattern (hash)",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openCard(user, "Hash: db.password");
      await retypeInto(user, byId("action-1-pattern"), "^secret_.*");
    },
    from: "        pattern: ^pw_.*\n",
    to: "        pattern: ^secret_.*\n",
    check: (v) => expect(itemsOf(v, "actions")[1]).toEqual({ key: "db.password", action: "hash", pattern: "^secret_.*" }),
  },
  {
    name: "attributes Regex Pattern (extract)",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openCard(user, "Extract: http.url");
      await retypeInto(user, byId("action-2-pattern"), "^(?P<proto>.*)://");
    },
    from: "        pattern: ^(?P<scheme>.*)://\n",
    to: "        pattern: ^(?P<proto>.*)://\n",
    check: (v) => expect(itemsOf(v, "actions")[2]).toEqual({ key: "http.url", action: "extract", pattern: "^(?P<proto>.*)://" }),
  },
  {
    name: "attributes Convert to Type",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openCard(user, "Convert: status");
      await pickIn(user, byId("action-3-convert"), "Double/Float");
    },
    from: "        action: convert\n        converted_type: int\n",
    to: "        action: convert\n        converted_type: double\n",
    check: (v) => expect(itemsOf(v, "actions")[3]).toEqual({ key: "status", action: "convert", converted_type: "double" }),
  },
  {
    name: "attributes Add Action appends the seeded action",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: (user) => user.click(screen.getByRole("button", { name: "Add Action" })),
    from: "        from_attribute: net.peer.name\n",
    to: '        from_attribute: net.peer.name\n      - key: ""\n        action: insert\n        value: ""\n',
    check: (v) => expect(itemsOf(v, "actions")[5]).toEqual({ key: "", action: "insert", value: "" }),
  },
  {
    name: "attributes Remove action removes the item's lines",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: (user) => user.click(screen.getAllByRole("button", { name: "Remove action" })[1]!),
    from: "      - key: db.password\n        action: hash # scrub\n        pattern: ^pw_.*\n",
    to: "",
    check: (v) => expect(itemsOf(v, "actions").map((item) => item.key)).toEqual(["env", "http.url", "status", "peer"]),
  },
  {
    name: "attributes Include Match Type",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await pickIn(user, byId("include-match-type"), "Strict - Exact match");
    },
    from: "      match_type: regexp # patterns\n",
    to: "      match_type: strict # patterns\n",
    check: (v) => expect((v as Record<string, Item>).include!.match_type).toBe("strict"),
  },
  {
    name: "attributes Include Service Names, one added",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.type(screen.getAllByPlaceholderText("e.g. frontend")[0]!, "middle{Enter}");
    },
    from: "      services: [front, back]\n",
    to: "      services: [front, back, middle]\n",
    check: (v) => expect((v as Record<string, Item>).include!.services).toEqual(["front", "back", "middle"]),
  },
  {
    name: "attributes Include Service Names, one removed",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    },
    from: "      services: [front, back]\n",
    to: "      services: [back]\n",
    check: (v) => expect((v as Record<string, Item>).include!.services).toEqual(["back"]),
  },
  {
    name: "attributes Exclude Span Names, the last removed",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Filtering");
      const exclude = within(screen.getByText("Exclude").closest(".space-y-3") as HTMLElement);
      await user.click(exclude.getAllByRole("button", { name: "Remove" })[0]!);
    },
    from: "      span_names:\n        - health # probes\n",
    to: "      span_names: []\n",
    check: (v) => expect((v as Record<string, Item>).exclude!.span_names).toEqual([]),
  },
  {
    name: "attributes Exclude Metric Names, one added",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.type(screen.getAllByPlaceholderText("e.g. http.server.duration")[1]!, "down");
      await user.click(
        within(screen.getByText("Exclude").closest(".space-y-3") as HTMLElement).getAllByRole("button", { name: "Add" })[2]!,
      );
    },
    from: "      metric_names: [up]\n",
    to: "      metric_names: [up, down]\n",
    check: (v) => expect((v as Record<string, Item>).exclude!.metric_names).toEqual(["up", "down"]),
  },
  {
    name: "attributes Include Enable Caching, unticked, under include.regexp",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.click(byId("include-cache-enabled"));
    },
    from: "        cacheenabled: true\n    exclude:",
    to: "        cacheenabled: false\n    exclude:",
    check: (v) => {
      expect((v as Record<string, Item>).include!.regexp).toEqual({ cacheenabled: false });
      expect((v as Item).cacheenabled).toBe(true);
    },
  },
  {
    name: "attributes Include Max Cache Entries, under include.regexp",
    key: ATTRIBUTES,
    form: <AttributesProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await retypeInto(user, byId("include-cache-max"), "500");
    },
    from: "        cacheenabled: true\n",
    to: "        cacheenabled: true\n        cachemaxnumentries: 500\n",
    check: (v) => {
      expect((v as Record<string, Item>).include!.regexp).toEqual({ cacheenabled: true, cachemaxnumentries: 500 });
      expect((v as Item).cacheenabled).toBe(true);
    },
  },

  // filter
  {
    name: "filter Error Mode",
    key: FILTER,
    form: <FilterProcessorForm />,
    edit: (user) => pickIn(user, byId("error-mode"), "Silent - Suppress error logs"),
    from: "    error_mode: propagate # strict\n",
    to: "    error_mode: silent # strict\n",
    check: (v) => expect((v as Item).error_mode).toBe("silent"),
  },
  {
    name: "filter a Span Filter retyped",
    key: FILTER,
    form: <FilterProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Traces");
      await retypeInto(user, screen.getByDisplayValue("name == \"b\""), 'name == "c"');
    },
    from: '        - name == "b"\n',
    to: '        - name == "c"\n',
    check: (v) => expect((v as Record<string, Record<string, unknown>>).traces!.span).toEqual(['attributes["a"] == "x"', 750, 'name == "c"']),
  },
  {
    name: "filter a Span Filter cleared stays, empty",
    key: FILTER,
    form: <FilterProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Traces");
      await retypeInto(user, screen.getByDisplayValue("name == \"b\""), "");
    },
    from: '        - name == "b"\n',
    to: '        - ""\n',
    check: (v) => expect((v as Record<string, Record<string, unknown>>).traces!.span).toEqual(['attributes["a"] == "x"', 750, ""]),
  },
  {
    name: "filter Add Filter (Span Event Filters, from [])",
    key: FILTER,
    form: <FilterProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Traces");
      await user.click(screen.getAllByRole("button", { name: "Add Filter" })[1]!);
    },
    from: "      spanevent: []\n",
    to: '      spanevent:\n        - ""\n',
    check: (v) => expect((v as Record<string, Record<string, unknown>>).traces!.spanevent).toEqual([""]),
  },
  {
    name: "filter Remove filter (Datapoint Filters)",
    key: FILTER,
    form: <FilterProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await user.click(screen.getByRole("button", { name: "Remove filter" }));
    },
    from: '      datapoint:\n        - attributes["pod.phase"] == "Pending"\n',
    to: "      datapoint: []\n",
    check: (v) => expect((v as Record<string, Record<string, unknown>>).metrics!.datapoint).toEqual([]),
  },
  {
    name: "filter a Log Record Filter (a flow item)",
    key: FILTER,
    form: <FilterProcessorForm />,
    edit: async (user) => {
      await openSection(user, "Logs");
      await retypeInto(user, screen.getByDisplayValue("severity_number < 9"), "severity_number < 13");
    },
    from: "      log_record: [severity_number < 9]\n",
    to: "      log_record: [severity_number < 13]\n",
    check: (v) => expect((v as Record<string, Record<string, unknown>>).logs!.log_record).toEqual(["severity_number < 13"]),
  },
];

describe("every field of each form writes only its key", () => {
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
      c.check(valueOf(text(), c.key));
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );

  it("a merged component's field copies the merge first; the anchor and its owner don't change", async () => {
    const user = renderForm("processors.attributes/merged", <AttributesProcessorForm />);
    // The merged action shows as the text holds it.
    expect(byId("action-0-key")).toHaveValue("shared");

    await retypeInto(user, byId("action-0-key"), "mine");

    expect(valueOf(text(), "processors.attributes/merged")).toEqual({
      actions: [{ key: "mine", action: "delete" }],
      include: { match_type: "strict", services: ["merged"] },
    });
    expect(valueOf(text(), "processors.attributes/base")).toEqual({ actions: [{ key: "shared", action: "delete" }] });
    expect(text()).toContain("  attributes/base: &shared\n    actions:\n      - key: shared\n        action: delete\n");
    expect(entries()).toBe(1);
  });

  it("each edit is one undo entry named after the component", async () => {
    const user = renderForm(FILTER, <FilterProcessorForm />);
    await pickIn(user, byId("error-mode"), "Ignore - Log errors and continue (recommended for production)");
    expect(selectUndoDescription(builderStore())).toBe("Update Filter");
    expect(entries()).toBe(1);
  });

  it("opening each form, its cards and sections, writes nothing", async () => {
    for (const [key, form] of [
      [RESOURCE, <ResourceProcessorForm key="r" />],
      [ATTRIBUTES, <AttributesProcessorForm key="a" />],
      [FILTER, <FilterProcessorForm key="f" />],
    ] as const) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, form);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      for (const header of screen.queryAllByText(/^(Hash|Extract|Convert|Upsert): /)) await user.click(header);
      for (const field of screen.queryAllByRole("textbox")) {
        await user.click(field);
        await user.tab();
      }
      expect(text()).toBe(FORMS);
      expect(entries()).toBe(0);
    }
  });
});

describe("reordering moves an item's own lines", () => {
  beforeEach(layOutRows);

  it("resource: an attribute dragged down keeps its comments, and 0750 stays 0750", async () => {
    renderForm(RESOURCE, <ResourceProcessorForm />);
    const handles = screen.getAllByRole("button", { name: "Drag to reorder" });
    expect(handles).toHaveLength(4);

    await dragByKeyboard(handles[0]!, 2);

    const moved = [
      "      - key: mode # the mode",
      "        value: 0750 # octal to the collector",
      "        action: upsert",
      "        converted_type: int",
      "      - key: secret",
      "        action: delete # gone",
      "        pattern: ^secret_.*",
      "      # the environment",
      "      - key: environment # env",
      "        value: production",
      "        action: insert",
      "      - {key: user, from_context: auth.subject, action: upsert}",
      "",
    ].join("\n");
    const original = FORMS.slice(FORMS.indexOf("      # the environment"), FORMS.indexOf("  attributes/base"));
    expect(text()).toBe(FORMS.replace(original, moved));
    expect(entries()).toBe(1);
    expect(itemsOf(valueOf(text(), RESOURCE), "attributes").map((item) => item.key)).toEqual([
      "mode",
      "secret",
      "environment",
      "user",
    ]);
    // The form follows: the first card is now mode's, its value as written.
    expect(byId("attr-0-key")).toHaveValue("mode");
    expect(textboxes("Value")[0]).toHaveValue("0750");
  });

  it("resource: an attribute dragged up, on CRLF text", async () => {
    const crlf = CRLF(FORMS);
    renderForm(RESOURCE, <ResourceProcessorForm />, crlf);

    await dragByKeyboard(screen.getAllByRole("button", { name: "Drag to reorder" })[3]!, -3);

    const original = CRLF(FORMS.slice(FORMS.indexOf("      # the environment"), FORMS.indexOf("  attributes/base")));
    const flow = "      - {key: user, from_context: auth.subject, action: upsert}\r\n";
    expect(text()).toBe(crlf.replace(original, flow + original.replace(flow, "")));
    act(() => void builderStore().undo());
    expect(text()).toBe(crlf);
  });

  it("filter: a condition dragged down keeps its comments, and the 0750 condition stays 0750", async () => {
    const user = renderForm(FILTER, <FilterProcessorForm />);
    await openSection(user, "Traces");
    const handles = screen.getAllByRole("button", { name: "Drag to reorder" });
    expect(handles).toHaveLength(3);

    await dragByKeyboard(handles[0]!, 2);

    expect(text()).toBe(
      FORMS.replace(
        '        # the first\n        - \'attributes["a"] == "x"\' # a\n        - 0750 # octal\n        - name == "b"\n',
        '        - 0750 # octal\n        - name == "b"\n        # the first\n        - \'attributes["a"] == "x"\' # a\n',
      ),
    );
    expect(entries()).toBe(1);
    expect(screen.getAllByRole("textbox")[0]).toHaveValue("0750");
  });

  it("filter: a flow list's condition moves its source", async () => {
    const flow = FORMS.replace("      log_record: [severity_number < 9]", "      log_record: [severity_number < 9, 0750, 'x']");
    const user = renderForm(FILTER, <FilterProcessorForm />, flow);
    await openSection(user, "Logs");

    await dragByKeyboard(screen.getAllByRole("button", { name: "Drag to reorder" })[2]!, -2);

    expect(text()).toBe(flow.replace("[severity_number < 9, 0750, 'x']", "['x', severity_number < 9, 0750]"));
  });

  it("a condition being typed is written before the move, to its own item", async () => {
    const user = renderForm(FILTER, <FilterProcessorForm />);
    await openSection(user, "Traces");
    const row = screen.getByDisplayValue('name == "b"');
    await user.clear(row);
    await user.type(row, "held");

    await dragByKeyboard(screen.getAllByRole("button", { name: "Drag to reorder" })[2]!, -2);

    expect((valueOf(text(), FILTER) as Record<string, Record<string, unknown>>).traces!.span).toEqual([
      "held",
      'attributes["a"] == "x"',
      750,
    ]);
  });
});

describe("what the forms show", () => {
  it("resource: values as written (0750), the value source, delete's Key Pattern, its copy", () => {
    renderForm(RESOURCE, <ResourceProcessorForm />);
    expect(screen.getByText("Resource Attributes")).toBeInTheDocument();
    expect(hint("Actions run top to bottom. Drag to reorder.")).toBeInTheDocument();
    expect(textboxes("Value").map((v) => v.value)).toEqual(["production", "0750"]);
    expect(byId("attr-0-key")).toHaveAttribute("placeholder", "e.g. environment");
    expect(textboxes("Value")[0]).toHaveAttribute("placeholder", "e.g. production");
    expect(screen.getByRole("textbox", { name: "Context key" })).toHaveAttribute("placeholder", "e.g. auth.subject");
    expect(byId("attr-2-pattern")).toHaveAttribute("placeholder", "e.g. ^http\\..*");
    expect(hint("Deletes every key matching this regex.")).toBeInTheDocument();
    expect(byId("attr-0-source")).toHaveTextContent("Literal value");
    expect(byId("attr-3-source")).toHaveTextContent("From context");
    expect(byId("attr-0-action")).toHaveTextContent("Insert");
    expect(byId("attr-2-action")).toHaveTextContent("Delete");
    // Delete has no value source.
    expect(document.getElementById("attr-2-source")).toBeNull();
  });

  it("resource: an action outside the four shows as an extra option, as written; the from-attribute input", async () => {
    const hashed = FORMS.replace("        action: delete # gone\n", "        action: hash # gone\n").replace(
      "      - {key: user, from_context: auth.subject, action: upsert}",
      "      - {key: user, from_attribute: host.name, action: upsert}",
    );
    const user = renderForm(RESOURCE, <ResourceProcessorForm />, hashed);
    expect(byId("attr-2-action")).toHaveTextContent("hash");
    expect(screen.getByRole("textbox", { name: "Source attribute key" })).toHaveValue("host.name");
    expect(screen.getByRole("textbox", { name: "Source attribute key" })).toHaveAttribute("placeholder", "e.g. host.name");

    await user.click(byId("attr-2-action"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Insert", "Update", "Upsert", "Delete", "hash"]);
  });

  it("resource: an unset attributes list shows no cards; Add Attribute creates the list", async () => {
    const user = renderForm(RESOURCE, <ResourceProcessorForm />, FORMS.replace(/ {2}resource: # the resource\n[\s\S]*?(?= {2}attributes\/base)/, "  resource: {}\n"));
    expect(screen.queryAllByRole("button", { name: "Drag to reorder" })).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Add Attribute" }));
    expect(valueOf(text(), RESOURCE)).toEqual({ attributes: [{ key: "", value: "", action: "insert" }] });
  });

  it("resource: a value it can't show is read-only, with the hint", () => {
    renderForm(RESOURCE, <ResourceProcessorForm />, FORMS.replace("        value: production\n", "        value: [a, b]\n"));
    expect(textboxes("Value")[0]).toBeDisabled();
    expect(screen.getByText(/This value is written in a form this field can't show/)).toBeInTheDocument();
  });

  it("attributes: the first card open, its headers, the rest collapsed until clicked", async () => {
    const user = renderForm(ATTRIBUTES, <AttributesProcessorForm />);
    expect(screen.getByText("Insert: env")).toBeInTheDocument();
    expect(screen.getByText("Hash: db.password")).toBeInTheDocument();
    expect(byId("action-0-key")).toHaveValue("env");
    expect(byId("action-0-value")).toHaveValue("42");
    expect(hint("String, number, or boolean.")).toBeInTheDocument();
    expect(byId("action-0-type")).toHaveTextContent("Insert - Add if absent");
    expect(byId("action-0-source")).toHaveTextContent("Literal value");
    expect(document.getElementById("action-1-key")).toBeNull();

    await openCard(user, "Hash: db.password");
    expect(byId("action-1-target")).toHaveTextContent("Regex Pattern (bulk)");
    expect(byId("action-1-pattern")).toHaveAttribute("placeholder", "e.g. ^temp_.*");
    expect(hint("Matched against attribute keys.")).toBeInTheDocument();
    await openCard(user, "Extract: http.url");
    expect(screen.getByText("Source Attribute Key")).toBeInTheDocument();
    expect(byId("action-2-pattern")).toHaveAttribute("placeholder", "e.g. ^(?P<http_protocol>.*?)://(?P<http_domain>.*?)/");
    expect(hint("Named groups (?P<name>…) become new attributes.")).toBeInTheDocument();
    await openCard(user, "Insert: env");
    expect(document.getElementById("action-0-key")).toBeNull();
  });

  it("attributes: a new action is open, its header says to configure the key; removing one keeps the others' open state", async () => {
    const user = renderForm(ATTRIBUTES, <AttributesProcessorForm />);
    await openCard(user, "Convert: status");
    await user.click(screen.getByRole("button", { name: "Add Action" }));
    expect(screen.getByText("Insert (configure key)")).toBeInTheDocument();
    expect(byId("action-5-key")).toHaveValue("");

    await user.click(screen.getAllByRole("button", { name: "Remove action" })[1]!);
    // Convert (was 3, now 2) and the new action (was 5, now 4) stay open.
    expect(byId("action-2-convert")).toHaveTextContent("Integer");
    expect(byId("action-4-key")).toBeInTheDocument();
    expect(byId("action-0-key")).toBeInTheDocument();
  });

  it("attributes: Target Type key -> pattern seeds the library's Generic Prefix; Value Source -> from attribute seeds source_attribute", async () => {
    const user = renderForm(ATTRIBUTES, <AttributesProcessorForm />, FORMS.replace("        pattern: ^pw_.*\n", ""));
    await openCard(user, "Hash: db.password");
    expect(byId("action-1-target")).toHaveTextContent("Single Attribute Key");
    await pickIn(user, byId("action-1-target"), "Regex Pattern (bulk)");
    expect(itemsOf(valueOf(text(), ATTRIBUTES), "actions")[1]).toEqual({ key: "db.password", action: "hash", pattern: "^prefix_.*" });

    await pickIn(user, byId("action-0-source"), "From attribute");
    expect(itemsOf(valueOf(text(), ATTRIBUTES), "actions")[0]).toEqual({ key: "env", action: "insert", from_attribute: "source_attribute" });
    expect(text()).toContain("      - key: env # the env\n        action: insert\n        from_attribute: source_attribute\n");
  });

  it("attributes: every action type's rebuild, from the seeds", async () => {
    const seeds: [string, Item][] = [
      ["Update - Modify if present", { key: "env", action: "update", value: "" }],
      ["Hash - SHA1 the value", { key: "env", action: "hash" }],
      ["Extract - Parse with regex", { key: "env", action: "extract", pattern: "" }],
      ["Convert - Change value type", { key: "env", action: "convert", converted_type: "string" }],
      ["Insert - Add if absent", { key: "env", action: "insert", value: "" }],
    ];
    const user = renderForm(ATTRIBUTES, <AttributesProcessorForm />);
    for (const [option, expected] of seeds) {
      await pickIn(user, byId("action-0-type"), option);
      expect(itemsOf(valueOf(text(), ATTRIBUTES), "actions")[0]).toEqual(expected);
    }
    expect(text()).toContain("      - key: env # the env\n");
  });

  it("attributes: the Filtering section, its count and copy; Match Type unset is blank, with no default (the collector has none)", async () => {
    const user = renderForm(ATTRIBUTES, <AttributesProcessorForm />);
    // 2 services + 1 span name + 1 metric name.
    expect(screen.getByRole("button", { name: /^Filtering/ })).toHaveTextContent("Filtering4");
    await openSection(user, "Filtering");
    expect(hint("Only process matching telemetry.")).toBeInTheDocument();
    expect(hint("Skip matching telemetry. Applied after include.")).toBeInTheDocument();
    expect(hint("Log body, attribute, and resource filters are available in the YAML editor.")).toBeInTheDocument();
    expect(screen.getAllByText("Traces only.")).toHaveLength(2);
    expect(screen.getAllByText("Metrics only.")).toHaveLength(2);
    expect(byId("include-match-type")).toHaveTextContent("Regexp - Pattern match");
    expect(byId("exclude-match-type")).toHaveTextContent("Strict - Exact match");
    cleanup();

    const unset = renderForm(ATTRIBUTES, <AttributesProcessorForm />, FORMS.replace("      match_type: strict\n      span_names:", "      span_names:"));
    await openSection(unset, "Filtering");
    expect(byId("exclude-match-type")).toHaveTextContent("");
    expect(screen.queryByText(/Default strict/)).toBeNull();
    expect(screen.queryByText(/Regex Caching/i)).toBeNull();
  });

  it("attributes: the cache shows inside a regexp section only; its hint and its default of no limit", async () => {
    const user = renderForm(ATTRIBUTES, <AttributesProcessorForm />);
    await openSection(user, "Filtering");
    expect(byId("include-cache-enabled")).toBeChecked();
    expect(document.getElementById("exclude-cache-enabled")).toBeNull();
    expect(hint("Caches match results when filters use regexp matching. · Default false")).toBeInTheDocument();
    expect(byId("include-cache-max")).toHaveValue("");
    expect(byId("include-cache-max")).toHaveAttribute("placeholder", "0");
    expect(hint("Default 0 (no limit)")).toBeInTheDocument();

    // Strict: no cache controls.
    await pickIn(user, byId("include-match-type"), "Strict - Exact match");
    expect(document.getElementById("include-cache-enabled")).toBeNull();
    expect(screen.queryByText("Enable Caching")).toBeNull();
  });

  it("attributes: a top-level cacheenabled is neither shown nor touched; the cache is written under exclude.regexp, its mappings made", async () => {
    const regexpExclude = FORMS.replace("      match_type: strict\n      span_names:", "      match_type: regexp\n      span_names:");
    const user = renderForm(ATTRIBUTES, <AttributesProcessorForm />, regexpExclude);
    await openSection(user, "Filtering");
    // Only the sections' boxes: none for the top-level key.
    expect(screen.getAllByRole("checkbox", { name: "Enable Caching" }).map((b) => b.id)).toEqual([
      "include-cache-enabled",
      "exclude-cache-enabled",
    ]);
    expect(byId("exclude-cache-enabled")).not.toBeChecked();
    expect(document.getElementById("exclude-cache-max")).toBeNull();

    await user.click(byId("exclude-cache-enabled"));

    expect(text()).toBe(
      regexpExclude.replace("      metric_names: [up]\n", "      metric_names: [up]\n      regexp:\n        cacheenabled: true\n"),
    );
    await retypeInto(user, byId("exclude-cache-max"), "0");
    const value = valueOf(text(), ATTRIBUTES) as Record<string, Item>;
    expect(value.exclude!.regexp).toEqual({ cacheenabled: true, cachemaxnumentries: 0 });
    expect(value.include!.regexp).toEqual({ cacheenabled: true });
    expect(value.cacheenabled).toBe(true);
    expect(text()).toContain("    cacheenabled: true # top-level, left alone\n");
    expect(text().match(/^ {4}cacheenabled/gm)).toHaveLength(1);
  });

  it("filter: error_mode unset shows the collector's ignore as placeholder and hint", () => {
    renderForm(FILTER, <FilterProcessorForm />, FORMS.replace("    error_mode: propagate # strict\n", ""));
    const trigger = byId("error-mode");
    expect(trigger).toHaveTextContent("Ignore - Log errors and continue (recommended for production)");
    expect(trigger.querySelector("[data-placeholder]") ?? trigger).toHaveAttribute("data-placeholder");
    expect(hint("Default ignore")).toBeInTheDocument();
    expect(text()).not.toContain("error_mode");
  });

  it("filter: the lists, their counts and copy; No filters configured; a 0750 condition as written", async () => {
    const user = renderForm(FILTER, <FilterProcessorForm />);
    expect(byId("error-mode")).toHaveTextContent("Propagate - Return error and drop data (strict)");
    expect(screen.getByRole("button", { name: /^Traces/ })).toHaveTextContent("Traces3");
    expect(screen.getByRole("button", { name: /^Metrics/ })).toHaveTextContent("Metrics1");
    expect(screen.getByRole("button", { name: /^Logs/ })).toHaveTextContent("Logs1");
    await openSection(user, "Traces");
    expect(hint("Any matching expression drops the span.")).toBeInTheDocument();
    expect(hint("Evaluated only when the parent span is kept.")).toBeInTheDocument();
    expect(screen.getByText("No filters configured")).toBeInTheDocument();
    const rows = screen.getAllByRole("textbox");
    expect(rows.map((r) => (r as HTMLTextAreaElement).value)).toEqual(['attributes["a"] == "x"', "0750", 'name == "b"']);
    expect(rows[0]).toHaveClass("font-mono", "text-sm", "flex-1");
    expect(rows[0]).toHaveAttribute("rows", "2");
    expect(rows[0]).toHaveAttribute(
      "placeholder",
      'attributes["http.request.method"] == "GET"\nresource.attributes["service.name"] == "my-service"',
    );
    await openSection(user, "Metrics");
    expect(hint("Drops points; a metric with no points left is dropped too.")).toBeInTheDocument();
    expect(hint("Any matching expression drops the whole metric.")).toBeInTheDocument();
    await openSection(user, "Logs");
    expect(hint("Any matching expression drops the log record.")).toBeInTheDocument();
  });

  it("filter: a multi-line condition is written and shown whole; Enter is a new line", async () => {
    const user = renderForm(FILTER, <FilterProcessorForm />);
    await openSection(user, "Logs");
    const row = screen.getByDisplayValue("severity_number < 9");
    await user.clear(row);
    await user.type(row, "a == 1{Enter}or b == 2");
    await user.tab();
    expect((valueOf(text(), FILTER) as Record<string, Record<string, unknown>>).logs!.log_record).toEqual(["a == 1\nor b == 2"]);
    expect(screen.getAllByRole("textbox")[0]).toHaveValue("a == 1\nor b == 2");
  });

  it("filter: the examples and the OTTL reference", async () => {
    const user = renderForm(FILTER, <FilterProcessorForm />);
    await openSection(user, "Examples & Reference");
    expect(screen.getByText("Common Filter Patterns")).toBeInTheDocument();
    expect([...document.querySelectorAll("h4.tf-label")].map((h) => h.textContent)).toEqual([
      "Security",
      "Cost Optimization",
      "Data Quality",
      "Compliance",
    ]);
    expect(FILTER_EXAMPLES).toHaveLength(10);
    expect(screen.getAllByText("All Signals")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Add" })).toHaveLength(10);
    await user.click(screen.getByText("Drop Sensitive Endpoints"));
    expect(screen.getByText('IsMatch(attributes["http.target"], "^/(admin|internal)/.*")')).toBeInTheDocument();
    expect(screen.getByText("Common OTTL Functions")).toBeInTheDocument();
    expect(screen.getByText('IsMatch(attributes["http.target"], "^/api/.*")')).toBeInTheDocument();
    expect(screen.getByText("HasAttrOnDatapoint(key, value)")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "OTTL Functions Documentation" });
    expect(link).toHaveAttribute("href", "https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/pkg/ottl");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("values the forms can't show", () => {
  const UNSHOWABLE = /This value is written in a form this field can't show/;

  it("a list that isn't a list, or an item that isn't a mapping, shows the hint; the rest works", async () => {
    const odd = FORMS.replace(/ {4}attributes:\n {6}# the environment\n[\s\S]*?(?= {2}attributes\/base)/, "    attributes: 5\n")
      .replace("    actions:\n      - key: env # the env\n        action: insert\n        value: 42\n", "    actions:\n      - just-a-string\n")
      .replace("    exclude:\n      match_type: strict\n      span_names:\n        - health # probes\n      metric_names: [up]\n", "    exclude: 5\n")
      .replace("      spanevent: []\n", "      spanevent: 5\n");

    renderForm(RESOURCE, <ResourceProcessorForm />, odd);
    expect(screen.getByText(UNSHOWABLE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Attribute" })).toBeNull();
    cleanup();

    const resourceItem = FORMS.replace("      - {key: user, from_context: auth.subject, action: upsert}\n", "      - 7\n");
    renderForm(RESOURCE, <ResourceProcessorForm />, resourceItem);
    expect(screen.getAllByText(UNSHOWABLE)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Remove attribute" })).toHaveLength(4);
    cleanup();

    const user = renderForm(ATTRIBUTES, <AttributesProcessorForm />, odd);
    expect(
      screen.getByText((_content, element) => element?.tagName === "SPAN" && element.textContent === " (configure key)"),
    ).toBeInTheDocument();
    expect(screen.getAllByText(UNSHOWABLE)).toHaveLength(1);
    await openSection(user, "Filtering");
    expect(screen.getAllByText(UNSHOWABLE)).toHaveLength(2);
    expect(byId("include-match-type")).toBeInTheDocument();
    expect(document.getElementById("exclude-match-type")).toBeNull();
    cleanup();

    const actions = FORMS.replace(/ {4}actions:\n {6}- key: env # the env\n[\s\S]*?(?= {4}include:\n {6}match_type: regexp)/, "    actions: {a: 1}\n");
    renderForm(ATTRIBUTES, <AttributesProcessorForm />, actions);
    expect(screen.getByText(UNSHOWABLE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Action" })).toBeNull();
    cleanup();

    const filter = renderForm(FILTER, <FilterProcessorForm />, odd);
    await openSection(filter, "Traces");
    expect(screen.getByText(UNSHOWABLE)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add Filter" })[1]).toBeDisabled();
    expect(text()).toBe(odd);
  });
});

describe("filter examples add to their list", () => {
  const LISTS: Record<string, [string, string]> = {
    span: ["traces", "span"],
    spanevent: ["traces", "spanevent"],
    metric: ["metrics", "metric"],
    datapoint: ["metrics", "datapoint"],
    log_record: ["logs", "log_record"],
  };
  const LABELS: Record<string, string> = {
    span: "Span Filters",
    spanevent: "Span Event Filters",
    metric: "Metric Filters",
    datapoint: "Datapoint Filters",
    log_record: "Log Record Filters",
  };

  it.each(FILTER_EXAMPLES.map((example, index) => [example.name, example, index] as const))(
    "%s: appended to its list, toasted, one entry",
    async (_name, example, index) => {
      const user = renderForm(FILTER, <FilterProcessorForm />);
      await openSection(user, "Examples & Reference");
      const [signal, list] = LISTS[example.context]!;
      const before = ((valueOf(FORMS, FILTER) as Record<string, Record<string, unknown[]>>)[signal]?.[list] ?? []).length;

      await user.click(screen.getAllByRole("button", { name: "Add" })[index]!);

      const after = (valueOf(text(), FILTER) as Record<string, Record<string, unknown[]>>)[signal]![list]!;
      expect(after).toHaveLength(before + 1);
      expect(after[before]).toBe(example.expression);
      expect(toast.success).toHaveBeenCalledWith(`Added to ${LABELS[example.context]}`, { description: example.name });
      expect(entries()).toBe(1);
      // Nothing else in the component changed.
      const rest = valueOf(text(), FILTER) as Record<string, Record<string, unknown[]>>;
      rest[signal]![list] = after.slice(0, before);
      if (before === 0 && !(valueOf(FORMS, FILTER) as Record<string, Record<string, unknown>>)[signal]?.[list]) {
        delete rest[signal]![list];
        if (Object.keys(rest[signal]!).length === 0) delete rest[signal];
      }
      expect(rest).toEqual(valueOf(FORMS, FILTER));
    },
  );

  it('"All Signals" examples go to Span Filters only', async () => {
    const user = renderForm(FILTER, <FilterProcessorForm />);
    await openSection(user, "Examples & Reference");
    const all = FILTER_EXAMPLES.filter((example) => example.signalType === "all");
    expect(all.map((example) => example.name)).toEqual(["Drop Test Services", "Drop Development Environment"]);
    for (const example of all) {
      await user.click(screen.getAllByRole("button", { name: "Add" })[FILTER_EXAMPLES.indexOf(example)]!);
    }
    const value = valueOf(text(), FILTER) as Record<string, Record<string, unknown[]>>;
    expect(value.traces!.span!.slice(3)).toEqual(all.map((example) => example.expression));
    expect(value.logs!.log_record).toEqual(["severity_number < 9"]);
    expect(value.metrics!.datapoint).toHaveLength(1);
  });

  it("an example added to a list that isn't there makes it, under the missing mappings", async () => {
    const bare = FORMS.replace(/ {2}filter:\n[\s\S]*?(?=exporters:)/, "  filter:\n");
    const user = renderForm(FILTER, <FilterProcessorForm />, bare);
    await openSection(user, "Examples & Reference");
    await user.click(screen.getAllByRole("button", { name: "Add" })[5]!);
    expect(valueOf(text(), FILTER)).toEqual({ metrics: { metric: ["type == METRIC_DATA_TYPE_NONE"] } });
  });
});

describe("privacy", () => {
  beforeEach(layOutRows);

  it("puts no config value in any attribute: cards and sections open, a menu open, a drag in progress", async () => {
    const MARK = "zq-mark";
    const marked = [
      "processors:",
      "  resource:",
      "    attributes:",
      `      - key: ${MARK}-key`,
      `        value: ${MARK}-value`,
      `        action: ${MARK}-action`,
      `      - {key: ${MARK}-key2, from_attribute: ${MARK}-from, action: upsert}`,
      `      - {key: ${MARK}-key3, action: delete, pattern: ${MARK}-pattern}`,
      "  attributes:",
      "    actions:",
      `      - {key: ${MARK}-akey, action: ${MARK}-type, value: ${MARK}-avalue}`,
      `      - {key: ${MARK}-hkey, action: hash, pattern: ${MARK}-hpattern}`,
      `      - {key: ${MARK}-ckey, action: convert, converted_type: ${MARK}-ctype}`,
      "    include:",
      "      match_type: regexp",
      `      services: [${MARK}-service]`,
      `      span_names: [${MARK}-span]`,
      "      regexp:",
      "        cacheenabled: true",
      `        cachemaxnumentries: ${MARK}-max`,
      "    exclude:",
      `      match_type: ${MARK}-match`,
      `      metric_names: [${MARK}-metric]`,
      "  filter:",
      `    error_mode: ${MARK}-mode`,
      "    traces:",
      `      span: [${MARK}-span1, ${MARK}-span2]`,
      `      spanevent: [${MARK}-event]`,
      "    metrics:",
      `      metric: [${MARK}-metric]`,
      `      datapoint: [${MARK}-point]`,
      "    logs:",
      `      log_record: [${MARK}-log]`,
      "exporters:",
      "  debug: {}",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      processors: [resource, attributes, filter]",
      "      exporters: [debug]",
      "",
    ].join("\n");

    const leaks: string[] = [];
    const scan = (where: string) => {
      for (const element of document.querySelectorAll("*")) {
        // A controlled field's value property is its content, not an attribute: the replay masks inputs.
        for (const attribute of element.attributes) {
          if (attribute.name !== "value" && attribute.value.includes(MARK)) {
            leaks.push(`${where}: ${element.tagName}[${attribute.name}]`);
          }
        }
      }
    };
    const shown = () =>
      document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

    for (const [key, form, menu] of [
      ["processors.resource", <ResourceProcessorForm key="resource" />, "attr-0-action"],
      ["processors.attributes", <AttributesProcessorForm key="attributes" />, "exclude-match-type"],
      ["processors.filter", <FilterProcessorForm key="filter" />, "error-mode"],
    ] as const) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, form, marked);
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      for (const header of screen.queryAllByText(/^(Hash|Convert): /)) await user.click(header);
      expect(shown()).toContain(`${MARK}-`);
      scan(key);

      // A drag in progress: the live region and the dragged row.
      const handle = screen.queryAllByRole("button", { name: "Drag to reorder" })[0];
      if (handle) {
        act(() => handle.focus());
        await press(handle, " ", "Space");
        await press(handle, "ArrowDown");
        expect(document.body.textContent).toMatch(/Draggable item [a-z_-]+-0 was moved over droppable area [a-z_-]+-1\./);
        scan(`${key} (dragging)`);
        await press(handle, "Escape");
      }

      // A menu open: the extra option holds a value, as text only.
      await user.click(byId(menu));
      expect(screen.getAllByRole("option").some((o) => o.textContent?.includes(MARK))).toBe(true);
      scan(`${key} (menu)`);
      await user.keyboard("{Escape}");
    }
    expect(leaks).toEqual([]);
    expect(text()).toBe(marked);
    expect(entries()).toBe(0);
  });

  it("the attributes filter lists' remove buttons say Remove, never the value", async () => {
    const user = renderForm(ATTRIBUTES, <AttributesProcessorForm />);
    await openSection(user, "Filtering");
    const removes = screen.getAllByRole("button", { name: /^Remove/ }).filter((b) => b.getAttribute("aria-label") !== "Remove action");
    expect(removes.map((b) => b.getAttribute("aria-label"))).toEqual(["Remove", "Remove", "Remove", "Remove"]);
  });
});
