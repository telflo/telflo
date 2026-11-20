import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FormProvider, useComponentForm, useForm } from "../form-context.js";
import { useAdjustments } from "./AdjustmentAlert.js";
import type { ValuesResult } from "~/lib/stores/editor-store.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The adjustment toast: a write that also adjusted another setting toasts
 * its messages, joined, once; a write refused, or one that changed nothing,
 * toasts nothing. Nothing renders inline. The forms' own tests drive each
 * of the twelve adjusting writes; this one drives the hook's contract.
 */

const TEXT = ["receivers:", "  filelog:", "    start_at: beginning", "exporters:", "  debug: {}", ""].join("\n");
const FIRST = "First line of the notice.";
const SECOND = "Second line of the notice.";

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);

function ComponentForm({ children }: { children: ReactNode }) {
  const form = useComponentForm(componentNamed("receivers.filelog").id);
  return <FormProvider form={form}>{children}</FormProvider>;
}

/** A control that writes start_at and notes the adjustment with the write's result, or with `forced` in its place. */
function Control({ messages, forced }: { messages: readonly string[]; forced?: ValuesResult }) {
  const form = useForm();
  const adjustments = useAdjustments();
  return (
    <button
      type="button"
      onClick={() => {
        const result = form.set(["start_at"], form.read(["start_at"]).value === "end" ? "beginning" : "end");
        adjustments.note(messages, forced ?? result);
      }}
    >
      Write
    </button>
  );
}

function renderControl(messages: readonly string[], forced?: ValuesResult) {
  openText(TEXT);
  const user = userEvent.setup();
  render(
    <ComponentForm>
      <Control messages={messages} {...(forced !== undefined ? { forced } : {})} />
    </ComponentForm>,
  );
  return user;
}

describe("the adjustment toast", () => {
  it("a write made toasts its message once and renders no inline notice", async () => {
    const user = renderControl([FIRST]);
    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(builderStore().text).toContain("    start_at: end\n");
    expect(infoToasts()).toEqual([FIRST]);
    expect(screen.queryByText(FIRST)).toBeNull();
  });

  it("two messages toast once, joined", async () => {
    const user = renderControl([FIRST, SECOND]);
    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(infoToasts()).toEqual([`${FIRST} ${SECOND}`]);
    expect(screen.queryByText(FIRST)).toBeNull();
    expect(screen.queryByText(SECOND)).toBeNull();
  });

  it("each write made toasts again", async () => {
    const user = renderControl([FIRST]);
    await user.click(screen.getByRole("button", { name: "Write" }));
    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(infoToasts()).toEqual([FIRST, FIRST]);
  });

  it("a write refused (manual edit mode locks the text) toasts nothing", async () => {
    const user = renderControl([FIRST]);
    act(() => useEditorStore.setState({ isYamlEditing: true }));
    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(builderStore().text).toBe(TEXT);
    expect(infoToasts()).toEqual([]);
  });

  it.each(["refused", "unchanged"] as const)("a write %s toasts nothing", async (result) => {
    const user = renderControl([FIRST], result);
    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(infoToasts()).toEqual([]);
  });
});
