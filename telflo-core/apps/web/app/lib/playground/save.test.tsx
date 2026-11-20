import { createRoutesStub, useLocation } from "react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIGURATION_YAML_MAXIMUM_LENGTH } from "@telflo/contracts";
import { SIGN_IN_TO_SAVE_LOGIN_PATH, SIGN_IN_TO_SAVE_TITLE } from "~/components/playground/SignInToSaveDialog.js";
import { EMPTY_GRAPH } from "~/lib/stores/editor-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { MINE, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { SAAS_SITE, underSite } from "~/test/site.js";
import { PlaygroundProvider } from "./provider.js";
import { SAVE_REFUSED_MESSAGE, UNTITLED_CONFIGURATION_NAME, useStagePlaygroundSave, type PlaygroundSaveSource } from "./save.js";
import { readStagedEdit, STAGED_EDIT_KEY } from "./staged-edit.js";

/*
 * The playground's Save: it stages the edit, then a signed-out visitor
 * sees "Sign in to save" and a signed-in one goes to `/app`. The visitor's
 * text is checked with boolean canaries only.
 */

const CANARY = `canary-${Math.random().toString(36).slice(2)}`;

function source(overrides: Partial<PlaygroundSaveSource> = {}): PlaygroundSaveSource {
  return {
    configuration: { ...MINE, name: `Mine ${CANARY}` },
    text: `receivers:\n  otlp: {}\n# ${CANARY}\n`,
    graph: EMPTY_GRAPH,
    collectorVersion: "0.161.0",
    ...overrides,
  };
}

let given: PlaygroundSaveSource = source();
function SaveButton() {
  const save = useStagePlaygroundSave();
  return (
    <button type="button" onClick={() => save(given)}>
      Save
    </button>
  );
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** With `open`, root's site data has registration open (the SaaS's); without, the open source's invitation-only default. */
function renderSave({ open = false } = {}) {
  const pages = [
    {
      path: "/playground/editor",
      Component: () => (
        <PlaygroundProvider>
          <SaveButton />
        </PlaygroundProvider>
      ),
    },
    { path: "/app", Component: Where },
    { path: "/login", Component: Where },
    { path: "/register", Component: Where },
  ];
  const Stub = createRoutesStub(open ? underSite(SAAS_SITE, pages) : pages);
  return render(<Stub initialEntries={["/playground/editor"]} />);
}

beforeEach(() => {
  window.localStorage.clear();
  useUserStore.getState().clear();
  given = source();
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useUserStore.getState().clear();
});

describe("Save in the playground", () => {
  it("signed out, registration open: the dialog offers Create free account and Sign in", async () => {
    const user = userEvent.setup();
    renderSave({ open: true });
    await user.click(await screen.findByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog", { name: SIGN_IN_TO_SAVE_TITLE });
    expect(within(dialog).getByRole("link", { name: "Create free account" })).toHaveAttribute("href", "/register");
    expect(within(dialog).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", SIGN_IN_TO_SAVE_LOGIN_PATH);
    expect(within(dialog).queryByRole("link", { name: "Sign in to save" })).toBeNull();
  });

  it("signed out: stages the edit, then asks to sign in (no account to create under invitation-only)", async () => {
    const user = userEvent.setup();
    renderSave();
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog", { name: SIGN_IN_TO_SAVE_TITLE });
    const staged = readStagedEdit();
    expect(staged).not.toBeNull();
    expect(staged!.content.name.includes(CANARY)).toBe(true);
    expect(staged!.content.yamlContent.includes(CANARY)).toBe(true);
    expect(staged!.content.collectorVersion).toBe("0.161.0");
    expect(staged!.content.collectorDistribution).toBe(MINE.collectorDistribution);
    // One way on: "Sign in to save", the same sign-in; no "Create free account".
    expect(within(dialog).getByRole("link", { name: "Sign in to save" })).toHaveAttribute("href", SIGN_IN_TO_SAVE_LOGIN_PATH);
    expect(within(dialog).queryByRole("link", { name: "Create free account" })).toBeNull();
    expect(within(dialog).getAllByRole("link")).toHaveLength(1);
    // No attribute holds the visitor's text.
    expect(dialog.outerHTML.includes(CANARY)).toBe(false);
    await user.click(within(dialog).getByRole("link", { name: "Sign in to save" }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/login");
  });

  it("signed in: stages the edit and goes to /app, where the handoff waits", async () => {
    const user = userEvent.setup();
    useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
    renderSave();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/app");
    expect(readStagedEdit()).not.toBeNull();
  });

  it("stages a configuration without a name as untitled, and a blank pin as the newest", async () => {
    const user = userEvent.setup();
    given = source({ configuration: { ...MINE, name: "   " }, collectorVersion: null });
    renderSave();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alertdialog");
    expect(readStagedEdit()!.content.name).toBe(UNTITLED_CONFIGURATION_NAME);
    expect(readStagedEdit()!.content.collectorVersion).toBe("0.162.0");
  });

  it("refuses at once what couldn't be created, with fixed words, and stages nothing", async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(toast, "error");
    given = source({ text: "#".repeat(CONFIGURATION_YAML_MAXIMUM_LENGTH + 1) });
    renderSave();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(error).toHaveBeenCalledWith(SAVE_REFUSED_MESSAGE);
    expect(window.localStorage.getItem(STAGED_EDIT_KEY)).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does nothing outside the playground", () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => {
          const save = useStagePlaygroundSave();
          save(source());
          return null;
        },
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    expect(window.localStorage.getItem(STAGED_EDIT_KEY)).toBeNull();
  });
});

