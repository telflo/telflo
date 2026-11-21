import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { useHeldEdit } from "./held-edits.js";
import { SAVE_AND_CONTINUE_FAILED_MESSAGE, useNavigationGuard } from "./use-navigation-guard.js";
import type { SaveResult } from "./use-save-configuration.js";
import { UnsavedChangesDialog } from "~/components/editor/UnsavedChangesDialog.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { versionFixture } from "~/test/configurations.js";

const SAVED = "receivers: {}\n";
const EDITED = "receivers: {}\n# edited\n";
const initialEditorState = useEditorStore.getState();

/** Where the page is, search included. */
function Here() {
  const { pathname, search } = useLocation();
  return <p>on {pathname + search}</p>;
}

/**
 * A field holding what is typed until it writes it as the store's text, as
 * the Configuration fields hold an edit (held-edits); "fail" is a flush
 * that throws (once: the field then holds nothing).
 */
function HeldField() {
  const [draft, setDraft] = useState<string | null>(null);
  useHeldEdit(draft !== null, () => {
    if (draft === null) return;
    setDraft(null);
    if (draft === "fail") throw new Error("the field couldn't write");
    useEditorStore.setState({ text: draft });
  });
  return <input aria-label="Held field" value={draft ?? ""} onChange={(event) => setDraft(event.target.value)} />;
}

/** A page guarded as the editor page is, with ways to leave it. */
function Guarded({ save }: { save: () => Promise<SaveResult> }) {
  const guard = useNavigationGuard(save);
  const navigate = useNavigate();
  return (
    <>
      <Here />
      <Link to="/app">Leave</Link>
      <Link to="?panel=yaml">Search only</Link>
      <HeldField />
      <button type="button" onClick={() => void navigate(-1)}>
        Back
      </button>
      <button type="button" onClick={() => void navigate("/app")}>
        Away
      </button>
      <button
        type="button"
        onClick={() => {
          // Saved and away in one tick, with no render between.
          const { text } = useEditorStore.getState();
          useEditorStore.setState({ savedText: text });
          void navigate("/app");
        }}
      >
        Saved and away
      </button>
      <UnsavedChangesDialog
        open={guard.isBlocked}
        onOpenChange={(open) => !open && guard.handleCancel()}
        onSaveAndContinue={guard.handleSaveAndProceed}
        onDiscard={guard.handleDiscardAndProceed}
        onCancel={guard.handleCancel}
        isSaving={guard.isSaving}
      />
    </>
  );
}

/**
 * `/editor/1` (or `at`), after `/app` in the history, guarded with `save`.
 * The default save does what a successful one does: the sent text becomes
 * the saved text.
 */
function renderGuarded(
  save = vi.fn(async (): Promise<SaveResult> => {
    const { text } = useEditorStore.getState();
    useEditorStore.setState({ savedText: text });
    return { saved: true };
  }),
  at = "/editor/1",
) {
  const Stub = createRoutesStub([
    { path: "/editor/:configurationId/:versionId?", Component: () => <Guarded save={save} /> },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={["/app", at]} initialIndex={1} />);
  return { save, user: userEvent.setup() };
}

function dirty() {
  useEditorStore.setState({ text: EDITED, savedText: SAVED });
}

async function heldDialog() {
  return screen.findByRole("alertdialog", { name: "Unsaved Changes" });
}

describe("useNavigationGuard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useEditorStore.setState(initialEditorState, true);
  });

  it("holds a link to another path while dirty, and opens the dialog", async () => {
    dirty();
    const { user, save } = renderGuarded();

    await user.click(await screen.findByRole("link", { name: "Leave" }));

    expect(await heldDialog()).toBeInTheDocument();
    expect(screen.getByText("on /editor/1")).toBeInTheDocument();
    expect(screen.queryByText("landed on /app")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("holds Back while dirty", async () => {
    dirty();
    const { user } = renderGuarded();

    await user.click(await screen.findByRole("button", { name: "Back" }));

    expect(await heldDialog()).toBeInTheDocument();
    expect(screen.getByText("on /editor/1")).toBeInTheDocument();
  });

  it("stays on Cancel, keeping the text, and holds the next navigation again", async () => {
    dirty();
    const { user, save } = renderGuarded();
    await user.click(await screen.findByRole("link", { name: "Leave" }));

    await user.click(within(await heldDialog()).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("on /editor/1")).toBeInTheDocument();
    expect(useEditorStore.getState().text).toBe(EDITED);
    expect(save).not.toHaveBeenCalled();

    await user.click(screen.getByRole("link", { name: "Leave" }));
    expect(await heldDialog()).toBeInTheDocument();
  });

  it("stays on Escape, as on Cancel", async () => {
    dirty();
    const { user } = renderGuarded();
    await user.click(await screen.findByRole("link", { name: "Leave" }));
    await heldDialog();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("on /editor/1")).toBeInTheDocument();
    expect(useEditorStore.getState().text).toBe(EDITED);
  });

  it("leaves on Discard Changes, with the text back to the saved text and nothing saved", async () => {
    dirty();
    const { user, save } = renderGuarded();
    await user.click(await screen.findByRole("link", { name: "Leave" }));

    await user.click(within(await heldDialog()).getByRole("button", { name: "Discard Changes" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(useEditorStore.getState().text).toBe(SAVED);
    expect(selectIsDirty(useEditorStore.getState())).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("saves and leaves on Save & Continue", async () => {
    dirty();
    const { user, save } = renderGuarded();
    await user.click(await screen.findByRole("link", { name: "Leave" }));

    await user.click(within(await heldDialog()).getByRole("button", { name: "Save & Continue" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().savedText).toBe(EDITED);
  });

  it("stays, keeps the text and toasts its own message when the save fails saying nothing; a second try can leave", async () => {
    dirty();
    const save = vi.fn(async (): Promise<SaveResult> => ({ saved: false, toasted: false }));
    const error = vi.spyOn(toast, "error");
    const { user } = renderGuarded(save);
    await user.click(await screen.findByRole("link", { name: "Leave" }));

    await user.click(within(await heldDialog()).getByRole("button", { name: "Save & Continue" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to save. Please try again."));
    expect(SAVE_AND_CONTINUE_FAILED_MESSAGE).toBe("Failed to save. Please try again.");
    expect(await heldDialog()).toBeInTheDocument();
    expect(screen.getByText("on /editor/1")).toBeInTheDocument();
    expect(useEditorStore.getState().text).toBe(EDITED);

    save.mockImplementation(async () => {
      useEditorStore.setState({ savedText: EDITED });
      return { saved: true };
    });
    await user.click(within(await heldDialog()).getByRole("button", { name: "Save & Continue" }));
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
  });

  it("stays with the text and adds no toast of its own when the save already toasted why", async () => {
    dirty();
    const save = vi.fn(async (): Promise<SaveResult> => {
      toast.error("This configuration was deleted. Copy your changes before leaving.");
      return { saved: false, toasted: true };
    });
    const error = vi.spyOn(toast, "error");
    const { user } = renderGuarded(save);
    await user.click(await screen.findByRole("link", { name: "Leave" }));

    await user.click(within(await heldDialog()).getByRole("button", { name: "Save & Continue" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await heldDialog()).toBeInTheDocument();
    expect(screen.getByText("on /editor/1")).toBeInTheDocument();
    expect(useEditorStore.getState().text).toBe(EDITED);
    expect(error.mock.calls.map(([message]) => message)).toEqual([
      "This configuration was deleted. Copy your changes before leaving.",
    ]);
  });

  it("stays held with the text and says nothing when the save didn't try, a create being under way; once it can, it saves and leaves", async () => {
    dirty();
    const save = vi.fn(async (): Promise<SaveResult> => ({ saved: false, busy: true }));
    const error = vi.spyOn(toast, "error");
    const { user } = renderGuarded(save);
    await user.click(await screen.findByRole("link", { name: "Leave" }));

    await user.click(within(await heldDialog()).getByRole("button", { name: "Save & Continue" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(error).not.toHaveBeenCalled();
    expect(await heldDialog()).toBeInTheDocument();
    expect(screen.getByText("on /editor/1")).toBeInTheDocument();
    expect(useEditorStore.getState().text).toBe(EDITED);

    save.mockImplementation(async () => {
      useEditorStore.setState({ savedText: EDITED });
      return { saved: true };
    });
    await user.click(within(await heldDialog()).getByRole("button", { name: "Save & Continue" }));
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  });

  it("disables the dialog while a save is under way and holds on through Escape; once saved it leaves without saving again", async () => {
    dirty();
    useEditorStore.setState({ isSaving: true });
    const { user, save } = renderGuarded();
    await user.click(await screen.findByRole("link", { name: "Leave" }));
    const dialog = await heldDialog();

    expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(await heldDialog()).toBeInTheDocument();

    // The save that was under way answers: the editor is clean.
    act(() => useEditorStore.setState({ isSaving: false, savedText: EDITED }));
    await user.click(within(await heldDialog()).getByRole("button", { name: "Save & Continue" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("never holds a change of search alone", async () => {
    dirty();
    const { user } = renderGuarded();

    await user.click(await screen.findByRole("link", { name: "Search only" }));

    expect(await screen.findByText("on /editor/1?panel=yaml")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  describe("at a version's address", () => {
    const HELD_VERSION = "0199c000-0000-7000-8000-000000000001";
    const OTHER_VERSION = "0199c000-0000-7000-8000-000000000003";
    const AT = `/editor/1/${HELD_VERSION}`;

    /** The editor holding `versionId`, dirty. */
    function dirtyHolding(versionId: string) {
      useEditorStore.setState({ version: versionFixture({ id: versionId }) });
      dirty();
    }

    it("never holds a change of search alone when the editor holds the address's version, in either case", async () => {
      dirtyHolding(HELD_VERSION);
      const { user } = renderGuarded(undefined, `/editor/1/${HELD_VERSION.toUpperCase()}`);

      await user.click(await screen.findByRole("link", { name: "Search only" }));

      expect(await screen.findByText(`on /editor/1/${HELD_VERSION.toUpperCase()}?panel=yaml`)).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("holds a navigation to the same address while dirty when the editor holds another version (a create's, before its push lands)", async () => {
      dirtyHolding(OTHER_VERSION);
      const { user } = renderGuarded(undefined, AT);

      await user.click(await screen.findByRole("link", { name: "Search only" }));

      const dialog = await heldDialog();
      expect(screen.getByText(`on ${AT}`)).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByText(`on ${AT}`)).toBeInTheDocument();
      expect(useEditorStore.getState().text).toBe(EDITED);
    });

    it("lets that navigation through while clean", async () => {
      useEditorStore.setState({ version: versionFixture({ id: OTHER_VERSION }), text: SAVED, savedText: SAVED });
      const { user } = renderGuarded(undefined, AT);

      await user.click(await screen.findByRole("link", { name: "Search only" }));

      expect(await screen.findByText(`on ${AT}?panel=yaml`)).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  it("never holds a navigation while clean", async () => {
    const { user } = renderGuarded();

    await user.click(await screen.findByRole("link", { name: "Leave" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  describe("an edit a field holds", () => {
    /** One line: an input holds no newline. */
    const HELD = "receivers: {} # held";

    /** Types into the held field, which keeps its focus: the store doesn't have the edit yet. */
    async function holdAnEdit(value = HELD) {
      useEditorStore.setState({ text: SAVED, savedText: SAVED });
      const field = await screen.findByRole("textbox", { name: "Held field" });
      field.focus();
      fireEvent.change(field, { target: { value } });
      expect(useEditorStore.getState().text).toBe(SAVED);
      expect(selectIsDirty(useEditorStore.getState())).toBe(false);
      // The store's text when the field first loses focus (the dialog takes it).
      const atBlur: { text: string | null } = { text: null };
      field.addEventListener("blur", () => (atBlur.text ??= useEditorStore.getState().text));
      return atBlur;
    }

    it.each([
      { way: "Back (the router going -1, a pop)", control: () => screen.getByRole("button", { name: "Back" }) },
      { way: "a programmatic navigate", control: () => screen.getByRole("button", { name: "Away" }) },
      { way: "a link clicked without blurring the field", control: () => screen.getByRole("link", { name: "Leave" }) },
    ])("is written before $way is judged, so the navigation is held", async ({ control }) => {
      const { save, user } = renderGuarded();
      const atBlur = await holdAnEdit();

      fireEvent.click(control());

      const dialog = await heldDialog();
      // The guard wrote what the field held before anything blurred it.
      expect(atBlur.text).toBe(HELD);
      expect(useEditorStore.getState().text).toBe(HELD);
      expect(screen.getByText("on /editor/1")).toBeInTheDocument();

      await user.click(within(dialog).getByRole("button", { name: "Save & Continue" }));
      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(save).toHaveBeenCalledTimes(1);
      expect(useEditorStore.getState().savedText).toBe(HELD);
    });

    it("Discard Changes after it was written leaves with the saved text", async () => {
      const { save, user } = renderGuarded();
      await holdAnEdit();

      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      await user.click(within(await heldDialog()).getByRole("button", { name: "Discard Changes" }));

      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(save).not.toHaveBeenCalled();
      expect(useEditorStore.getState().text).toBe(SAVED);
    });

    it("isn't written by a change of search alone, which isn't held", async () => {
      renderGuarded();
      await holdAnEdit();

      fireEvent.click(screen.getByRole("link", { name: "Search only" }));

      expect(await screen.findByText("on /editor/1?panel=yaml")).toBeInTheDocument();
      expect(useEditorStore.getState().text).toBe(SAVED);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("holds the navigation when the field's flush throws: what it held would be lost", async () => {
      const { user } = renderGuarded();
      await holdAnEdit("fail");

      fireEvent.click(screen.getByRole("button", { name: "Away" }));

      const dialog = await heldDialog();
      expect(screen.getByText("on /editor/1")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByText("on /editor/1")).toBeInTheDocument();
    });
  });

  it("judges by the store when the navigation starts, not by the last render", async () => {
    dirty();
    const { user } = renderGuarded();

    // Clean and navigating in the same tick: a flag closed over at the last
    // render would still say dirty, and hold it.
    await user.click(await screen.findByRole("button", { name: "Saved and away" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
