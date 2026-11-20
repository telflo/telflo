import { render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "../form-context.js";
import { RetryConfigSection } from "./RetryConfigSection.js";
import type { AbsentMeans } from "./section-toggle.js";
import { SendingQueueSection } from "./SendingQueueSection.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The retry and queue sections' off variants and ids: what each
 * `absentMeans` shows over every shape of the block, what ticking and
 * unticking write, two of each section with their own ids, and the remote
 * write default. The sections' other tests are in
 * `shared-sections.test.tsx`.
 */

const TEXT = `exporters:
  loadbalancing/absent:
    protocol:
      otlp: {}
  loadbalancing/null:
    retry_on_failure:
    sending_queue: # on, as the collector reads it
  loadbalancing/empty:
    retry_on_failure: {}
    sending_queue: {}
  loadbalancing/keys:
    retry_on_failure:
      initial_interval: 1s
    sending_queue:
      num_consumers: 5
  loadbalancing/false:
    retry_on_failure:
      enabled: false
    sending_queue:
      enabled: false
  loadbalancing/true:
    retry_on_failure:
      enabled: true
    sending_queue:
      enabled: true
  loadbalancing/odd:
    retry_on_failure: [1]
    sending_queue: yes
receivers:
  otlp:
    protocols:
      grpc: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [loadbalancing/absent, loadbalancing/null, loadbalancing/empty, loadbalancing/keys, loadbalancing/false, loadbalancing/true, loadbalancing/odd]
`;

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function spyWrites(): ValueChange[][] {
  const original = builderStore().setComponentValues;
  const calls: ValueChange[][] = [];
  useEditorStore.setState({
    setComponentValues: (nodeId, changes) => {
      calls.push([...changes]);
      return original(nodeId, changes);
    },
  });
  return calls;
}

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderIn(key: string, children: ReactNode) {
  openText(TEXT);
  return render(<ComponentForm nodeId={componentNamed(key).id}>{children}</ComponentForm>);
}

const text = () => builderStore().text;
const values = (key: string) => (parseYaml(text()) as { exporters: Record<string, Record<string, unknown>> }).exporters[key]!;
const box = (name: string) => screen.getByRole("checkbox", { name });

async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, typed);
  await user.tab();
}

const SHAPES = ["absent", "null", "empty", "keys", "false", "true", "odd"] as const;
type Shown = "on" | "off" | "unshowable";

/** What each variant shows over each shape. */
const EXPECTED: Record<AbsentMeans, Record<(typeof SHAPES)[number], Shown>> = {
  on: { absent: "on", null: "on", empty: "on", keys: "on", false: "off", true: "on", odd: "unshowable" },
  // configoptional.Default: written is on, unless `enabled: false` (core configoptional/optional.go:172-220).
  "off-optional": { absent: "off", null: "on", empty: "on", keys: "on", false: "off", true: "on", odd: "unshowable" },
  // A plain BackOffConfig whose zero value is off (loadbalancingexporter config.go:42): on only with enabled: true.
  "off-struct": { absent: "off", null: "off", empty: "off", keys: "off", false: "off", true: "on", odd: "unshowable" },
};

function shownBy(name: string): Shown {
  const element = box(name);
  if (element.hasAttribute("disabled")) return "unshowable";
  return element.getAttribute("aria-checked") === "true" ? "on" : "off";
}

describe("absentMeans over every shape of the block", () => {
  for (const absentMeans of ["on", "off-optional", "off-struct"] as const) {
    it(`${absentMeans}: retry and queue`, () => {
      for (const shape of SHAPES) {
        const { unmount } = renderIn(
          `exporters.loadbalancing/${shape}`,
          <>
            <RetryConfigSection path={["retry_on_failure"]} absentMeans={absentMeans} />
            <SendingQueueSection path={["sending_queue"]} absentMeans={absentMeans} />
          </>,
        );
        expect([shape, shownBy("Enable Retry on Failure")]).toEqual([shape, EXPECTED[absentMeans][shape]]);
        expect([shape, shownBy("Enable Sending Queue")]).toEqual([shape, EXPECTED[absentMeans][shape]]);
        if (shape === "odd") expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
        unmount();
      }
    });
  }
});

describe("ticking and unticking an off variant", () => {
  it("ticking writes the default block; unticking removes the key", async () => {
    const user = userEvent.setup();
    const calls = spyWrites();
    renderIn(
      "exporters.loadbalancing/absent",
      <>
        <RetryConfigSection path={["retry_on_failure"]} absentMeans="off-struct" />
        <SendingQueueSection path={["sending_queue"]} absentMeans="off-optional" />
      </>,
    );
    await user.click(box("Enable Retry on Failure"));
    await user.click(box("Enable Sending Queue"));
    expect(calls).toEqual([
      [
        {
          path: ["retry_on_failure"],
          value: { enabled: true, initial_interval: "5s", max_interval: "30s", max_elapsed_time: "300s", multiplier: 1.5 },
        },
      ],
      [{ path: ["sending_queue"], value: { enabled: true, num_consumers: 10, queue_size: 1000 } }],
    ]);
    await user.click(box("Enable Retry on Failure"));
    await user.click(box("Enable Sending Queue"));
    expect(calls.slice(2)).toEqual([[{ path: ["retry_on_failure"], remove: true }], [{ path: ["sending_queue"], remove: true }]]);
    expect(values("loadbalancing/absent")).toEqual({ protocol: { otlp: {} } });
  });

  it("a null queue (on) is written as a mapping by its fields; unticking it removes the key", async () => {
    const user = userEvent.setup();
    renderIn("exporters.loadbalancing/null", <SendingQueueSection path={["sending_queue"]} absentMeans="off-optional" />);
    await retypeInto(user, screen.getByRole("textbox", { name: "Consumers" }), "4");
    expect(values("loadbalancing/null").sending_queue).toEqual({ num_consumers: 4 });
    expect(box("Enable Sending Queue")).toBeChecked();
    await user.click(box("Enable Sending Queue"));
    expect(values("loadbalancing/null")).not.toHaveProperty("sending_queue");
  });
});

describe("ids and defaults", () => {
  it("two of each section have their own ids by idPrefix; without it the ids are unprefixed", () => {
    renderIn(
      "exporters.loadbalancing/true",
      <>
        <RetryConfigSection path={["retry_on_failure"]} />
        <SendingQueueSection path={["sending_queue"]} />
        <RetryConfigSection path={["retry_on_failure"]} idPrefix="lb-" absentMeans="off-struct" />
        <SendingQueueSection path={["sending_queue"]} idPrefix="lb-" absentMeans="off-optional" />
      </>,
    );
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "retry-enable",
        "retry-initial-interval",
        "queue-enable",
        "queue-num-consumers",
        "lb-retry-enable",
        "lb-retry-initial-interval",
        "lb-retry-max-interval",
        "lb-retry-max-elapsed-time",
        "lb-retry-multiplier",
        "lb-queue-enable",
        "lb-queue-num-consumers",
        "lb-queue-size",
        "lb-queue-flush-timeout",
        "lb-queue-min-batch-size",
        "lb-queue-max-batch-size",
      ]),
    );
    // Each label names its own box.
    expect(screen.getAllByRole("checkbox", { name: "Enable Retry on Failure" }).map((element) => element.id)).toEqual([
      "retry-enable",
      "lb-retry-enable",
    ]);
  });

  it("initialIntervalDefault is the placeholder and the hint; ticking still writes 5s", async () => {
    const user = userEvent.setup();
    renderIn("exporters.loadbalancing/true", <RetryConfigSection path={["retry_on_failure"]} initialIntervalDefault="50ms" />);
    const field = screen.getByRole("textbox", { name: "Initial Interval" });
    expect(field).toHaveAttribute("placeholder", "50ms");
    expect(screen.getByText("50ms", { selector: "span.font-mono" })).toBeInTheDocument();
    await user.click(box("Enable Retry on Failure"));
    await user.click(box("Enable Retry on Failure"));
    expect(values("loadbalancing/true").retry_on_failure).toMatchObject({ enabled: true, initial_interval: "5s" });
  });
});
