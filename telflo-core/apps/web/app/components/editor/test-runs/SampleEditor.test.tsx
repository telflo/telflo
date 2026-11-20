import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorProps } from "@monaco-editor/react";
import { DEFAULT_USER_PREFERENCES, type EditorPreferences, type Theme } from "@telflo/contracts";

/**
 * Monaco stubbed, as the testing tab's tests stub it: the stub records the
 * props, mounts once with a model that keeps the options set on it, and
 * counts its mounts, so a change can be seen to reach the open editor.
 */
const fake = vi.hoisted(() => ({
  props: null as EditorProps | null,
  mounts: 0,
  modelOptions: {} as Record<string, unknown>,
}));

vi.mock("@monaco-editor/react", () => ({
  default: function MonacoStub(props: EditorProps) {
    fake.props = props;
    useEffect(() => {
      const model = { updateOptions: (next: Record<string, unknown>) => void Object.assign(fake.modelOptions, next) };
      props.beforeMount?.({ editor: { defineTheme: () => undefined } } as never);
      props.onMount?.({ getModel: () => model, onDidDispose: () => ({ dispose: () => undefined }) } as never, {} as never);
      fake.mounts += 1;
    }, []);
    return <pre data-monaco-stub="">{props.value}</pre>;
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => Promise.resolve(), setMonacoSchema: () => undefined }));

import { SampleEditor } from "./SampleEditor.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { signedInMember } from "~/test/configurations.js";

/** The user store holding the member with `theme` and `editor` (Settings' choices). */
function choose(theme: Theme, editor: Partial<EditorPreferences> = {}) {
  const member = signedInMember();
  useUserStore.getState().setCurrent({
    ...member,
    preferences: { ...member.preferences, theme, editor: { ...DEFAULT_USER_PREFERENCES.editor, ...editor } },
  });
}

async function renderEditor() {
  render(<SampleEditor value={"{}"} onChange={() => undefined} language="json" />);
  await screen.findByText("{}");
  await waitFor(() => expect(fake.mounts).toBe(1));
}

beforeEach(() => {
  useUserStore.getState().clear();
  fake.props = null;
  fake.mounts = 0;
  fake.modelOptions = { tabSize: 2, indentSize: 2 };
});

describe("the sample editor: the person's editor preferences", () => {
  it("takes the theme and all four preferences from the store", async () => {
    choose("navy", { tabSize: 4, fontSize: 16, lineNumbers: false, minimap: true });
    await renderEditor();

    expect(fake.props?.theme).toBe("telflo-navy");
    expect(fake.props?.options).toMatchObject({ fontSize: 16, lineNumbers: "off", minimap: { enabled: true } });
    // The tab size is the model's, never an option.
    expect(fake.props?.options).not.toHaveProperty("tabSize");
    expect(fake.modelOptions).toMatchObject({ tabSize: 4, indentSize: 4 });
  });

  it("a change of the store's preferences reaches the open editor, the model's tab size included", async () => {
    choose("dark");
    await renderEditor();
    expect(fake.props?.theme).toBe("telflo-dark");

    act(() => choose("light", { tabSize: 4, fontSize: 18, lineNumbers: false, minimap: true }));

    expect(fake.props?.theme).toBe("vs");
    expect(fake.props?.options).toMatchObject({ fontSize: 18, lineNumbers: "off", minimap: { enabled: true } });
    expect(fake.modelOptions).toMatchObject({ tabSize: 4, indentSize: 4 });
    expect(fake.mounts).toBe(1);
  });

  it("the sample editor's tab size and minimap follow the preferences, no longer fixed at 2 and off", async () => {
    choose("dark", { tabSize: 4, minimap: true });
    await renderEditor();
    expect(fake.props?.options).toMatchObject({ minimap: { enabled: true } });
    expect(fake.modelOptions).toMatchObject({ tabSize: 4, indentSize: 4 });

    act(() => choose("dark", { tabSize: 2, minimap: false }));
    expect(fake.props?.options).toMatchObject({ minimap: { enabled: false } });
    expect(fake.modelOptions).toMatchObject({ tabSize: 2, indentSize: 2 });
  });
});
