import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, MultiValueField, useComponentForm } from "./form-context.js";
import { OperatorPipeline } from "./operators/OperatorPipeline.js";
import { CORSConfigSection } from "./shared/CORSConfigSection.js";
import { IncludeExcludeSection } from "./shared/IncludeExcludeSection.js";
import { KeyValueMapField } from "./shared/KeyValueMapField.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * Rows keyed by their items. A row emptied and left removes its item (a
 * held-row list), and the pointer going down on a Remove button is what
 * leaves it: with rows keyed by index, the next item's row would take the
 * removed row's place, its Remove button with it, and the click that
 * followed would remove that item too. Keyed by item, the removed row's
 * button goes with it. For each list with a Remove button: a row cleared,
 * then its own Remove clicked; a row cleared, then another row's Remove
 * clicked; and a row's typing kept on its item when another row is removed.
 * user-event's click presses, then releases, as a person does, and the form
 * renders between the two.
 */

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TAIL = `exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [filelog]
      exporters: [debug]
`;

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

/** `filelog` with `body` as its value's lines (indented four), and `children` as its form. */
function mount(body: string, children: ReactNode): UserEvent {
  openText(`receivers:\n  filelog:\n${body}${TAIL}`);
  const user = userEvent.setup();
  render(<ComponentForm nodeId={componentNamed("receivers.filelog").id}>{children}</ComponentForm>);
  return user;
}

const value = () => (parseYaml(builderStore().text, { merge: true }) as { receivers: { filelog: Record<string, unknown> } }).receivers.filelog;
const inputs = (placeholder: string) => screen.getAllByPlaceholderText(placeholder) as HTMLInputElement[];
const removes = (name: string, within_: HTMLElement = document.body) => within(within_).getAllByRole("button", { name });

describe("MultiValueField's held-row lists (holdEmpty)", () => {
  const LIST = "    units:\n      - a\n      - b\n      - c\n";
  const field = <MultiValueField path={["units"]} placeholder="unit" addButtonText="Add unit" holdEmpty />;

  it("a row cleared, then its own Remove clicked, removes that item only", async () => {
    const user = mount(LIST, field);
    await user.clear(inputs("unit")[0]!);
    await user.click(removes("Remove")[0]!);
    expect(value().units).toEqual(["b", "c"]);
  });

  it("a row cleared, then another row's Remove clicked, removes the two", async () => {
    const user = mount(LIST, field);
    await user.clear(inputs("unit")[0]!);
    await user.click(removes("Remove")[1]!);
    expect(value().units).toEqual(["c"]);
  });

  it("a row's typing stays on its item when another is removed; the held row's too", async () => {
    const user = mount(LIST, field);
    await user.type(inputs("unit")[1]!, "X");
    await user.click(removes("Remove")[0]!);
    expect(value().units).toEqual(["bX", "c"]);
    expect(inputs("unit").map((input) => input.value)).toEqual(["bX", "c"]);
    await user.click(screen.getByRole("button", { name: "Add unit" }));
    await user.type(inputs("unit")[2]!, "d");
    await user.click(removes("Remove")[0]!);
    expect(value().units).toEqual(["c", "d"]);
  });
});

describe("MultiValueField's lists without held rows", () => {
  const LIST = "    units:\n      - a\n      - b\n      - c\n";
  const field = <MultiValueField path={["units"]} placeholder="unit" addButtonText="Add unit" />;

  it("a row cleared (written empty), then its own Remove or another's clicked", async () => {
    const user = mount(LIST, field);
    await user.clear(inputs("unit")[0]!);
    await user.click(removes("Remove")[0]!);
    expect(value().units).toEqual(["b", "c"]);
  });

  it("a row cleared, then another row's Remove clicked; typing kept on its item", async () => {
    const user = mount(LIST, field);
    await user.clear(inputs("unit")[0]!);
    await user.click(removes("Remove")[1]!);
    expect(value().units).toEqual(["", "c"]);
    await user.type(inputs("unit")[1]!, "X");
    await user.click(removes("Remove")[0]!);
    expect(value().units).toEqual(["cX"]);
  });
});

describe("IncludeExcludeSection's rows", () => {
  const LIST = "    include:\n      devices: [a, b, c]\n      match_type: strict\n";
  const section = (
    <IncludeExcludeSection
      id="filter"
      title="Device Filter"
      includePath={["include"]}
      excludePath={["exclude"]}
      listKey="devices"
      itemLabel="Device"
      placeholder="device"
    />
  );
  const devices = () => (value().include as { devices: string[] }).devices;

  it("a row cleared, then its own Remove clicked, removes that item only", async () => {
    const user = mount(LIST, section);
    await user.clear(inputs("device")[0]!);
    await user.click(removes("Remove device")[0]!);
    expect(devices()).toEqual(["b", "c"]);
  });

  it("a row cleared, then another row's Remove clicked, removes the two", async () => {
    const user = mount(LIST, section);
    await user.clear(inputs("device")[0]!);
    await user.click(removes("Remove device")[1]!);
    expect(devices()).toEqual(["c"]);
  });

  it("a row's typing stays on its item when another is removed", async () => {
    const user = mount(LIST, section);
    await user.type(inputs("device")[1]!, "X");
    await user.click(removes("Remove device")[0]!);
    expect(devices()).toEqual(["bX", "c"]);
  });
});

const NOUNS = { key: "key", value: "value", addLabel: "Add Attribute", removeLabel: "Remove", exists: "Taken." };
const MAP = "    attributes:\n      a: '1'\n      b: '2'\n      c: '3'\n";

describe.each(["rows", "staging"] as const)("KeyValueMapField's %s layout", (layout) => {
  const field = <KeyValueMapField path={["attributes"]} nouns={NOUNS} layout={layout} title="Attributes" />;
  // A cleared key isn't a rename: the row shows its key again.
  it("a key cleared, then its own Remove clicked, removes that key only", async () => {
    const user = mount(MAP, field);
    await user.clear(inputs("key")[0]!);
    await user.click(removes("Remove")[0]!);
    expect(value().attributes).toEqual({ b: "2", c: "3" });
  });

  it("a key cleared, then another row's Remove clicked, removes that one", async () => {
    const user = mount(MAP, field);
    await user.clear(inputs("key")[0]!);
    await user.click(removes("Remove")[1]!);
    expect(value().attributes).toEqual({ a: "1", c: "3" });
  });

  it("a row's typing stays on its key when another is removed", async () => {
    const user = mount(MAP, field);
    await user.type(inputs("value")[1]!, "X");
    await user.click(removes("Remove")[0]!);
    expect(value().attributes).toEqual({ b: "2X", c: "3" });
    expect(inputs("value").map((input) => input.value).slice(0, 2)).toEqual(["2X", "3"]);
  });
});

describe("CORS's lists", () => {
  const CORS = "    cors:\n      allowed_origins: [a, b, c]\n";
  const origins = () => (value().cors as { allowed_origins: string[] }).allowed_origins;

  it("a row's typing stays on its item when another is removed; a cleared row's own Remove removes it", async () => {
    const user = mount(CORS, <CORSConfigSection path={["cors"]} />);
    const rows = () => inputs("e.g. https://*.example.com");
    await user.type(rows()[1]!, "X");
    await user.click(removes("Remove origin")[0]!);
    expect(origins()).toEqual(["bX", "c"]);
    await user.clear(rows()[0]!);
    await user.click(removes("Remove origin")[0]!);
    expect(origins()).toEqual(["c"]);
  });
});

/** The operator card holding the field `id`. */
const cardOf = (id: string) => (document.getElementById(id) as HTMLElement).closest(".rounded-lg.bg-card") as HTMLElement;
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
const operators = () => value().operators as Array<Record<string, unknown>>;
const pipeline = <OperatorPipeline path={["operators"]} source="file" />;

describe("retain's fields", () => {
  const RETAIN = "    operators:\n      - type: retain\n        fields:\n          - a\n          - b\n          - c\n";
  const retainRemoves = () => removes("Remove", cardOf("op-0-retain-field-0"));

  it("a row cleared, then its own Remove clicked, removes that item only", async () => {
    const user = mount(RETAIN, pipeline);
    await user.clear(byId("op-0-retain-field-0"));
    await user.click(retainRemoves()[0]!);
    expect(operators()[0]!.fields).toEqual(["b", "c"]);
  });

  it("a row cleared, then another row's Remove clicked, removes the two", async () => {
    const user = mount(RETAIN, pipeline);
    await user.clear(byId("op-0-retain-field-0"));
    await user.click(retainRemoves()[1]!);
    expect(operators()[0]!.fields).toEqual(["c"]);
  });

  it("a row's typing stays on its item when another is removed, and a held row's", async () => {
    const user = mount(RETAIN, pipeline);
    await user.type(byId("op-0-retain-field-1"), "X");
    await user.click(retainRemoves()[0]!);
    expect(operators()[0]!.fields).toEqual(["bX", "c"]);
    await user.click(within(cardOf("op-0-retain-field-0")).getByRole("button", { name: "Add Field" }));
    await user.type(byId("op-0-retain-field-2"), "d");
    await user.click(retainRemoves()[0]!);
    expect(operators()[0]!.fields).toEqual(["c", "d"]);
  });
});

describe("assign_keys' keys", () => {
  const ASSIGN = "    operators:\n      - type: assign_keys\n        field: body.list\n        keys: [a, b, c]\n";
  const keyRemoves = () => removes("Remove", cardOf("op-0-assign-keys-key-0"));

  it("a key cleared (written empty), then its own Remove or another's clicked", async () => {
    const user = mount(ASSIGN, pipeline);
    await user.clear(byId("op-0-assign-keys-key-0"));
    await user.click(keyRemoves()[1]!);
    expect(operators()[0]!.keys).toEqual(["", "c"]);
    await user.click(keyRemoves()[0]!);
    expect(operators()[0]!.keys).toEqual(["c"]);
  });

  it("a key's typing stays on its item when another is removed", async () => {
    const user = mount(ASSIGN, pipeline);
    await user.type(byId("op-0-assign-keys-key-1"), "X");
    await user.click(keyRemoves()[0]!);
    expect(operators()[0]!.keys).toEqual(["bX", "c"]);
    expect(byId("op-0-assign-keys-key-0").value).toBe("bX");
  });
});

describe("router's routes", () => {
  const ROUTER = "    operators:\n      - type: router\n        routes:\n          - expr: a\n          - expr: b\n          - expr: c\n";
  const routeRemoves = () => removes("Remove", cardOf("op-0-route-expr-0"));

  it("a route's typing stays on its route when another is removed; a cleared route's own Remove removes it", async () => {
    const user = mount(ROUTER, pipeline);
    await user.type(byId("op-0-route-expr-1"), "X");
    await user.click(routeRemoves()[0]!);
    expect(operators()[0]!.routes).toEqual([{ expr: "bX" }, { expr: "c" }]);
    await user.clear(byId("op-0-route-expr-0"));
    await user.click(routeRemoves()[0]!);
    expect(operators()[0]!.routes).toEqual([{ expr: "c" }]);
  });
});

describe("a renamed key follows its row", () => {
  it.each(["rows", "staging"] as const)(
    "%s: a key renamed to an integer-like one moves to the top, keeping its row and focus; a Remove pressed as it is written removes its own",
    async (layout) => {
      const MAP_BA = "    attributes:\n      b: '1'\n      a: '2'\n";
      const user = mount(MAP_BA, <KeyValueMapField path={["attributes"]} nouns={NOUNS} layout={layout} title="Attributes" />);
      const key = inputs("key")[1]!;
      await user.clear(key);
      await user.type(key, "5{Enter}");
      expect(Object.keys(value().attributes as object)).toEqual(["5", "b"]);
      expect(inputs("key")[0]).toBe(key);
      expect(document.activeElement).toBe(key);
      await user.clear(key);
      await user.type(key, "7");
      await user.click(removes("Remove")[1]!);
      expect(value().attributes).toEqual({ 7: "2" });
    },
  );
});
