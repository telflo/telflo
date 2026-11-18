import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConfigurationVersionResponse, ConfigurationVersionSummary } from "@telflo/contracts";
import { useEffect } from "react";
import { createRoutesStub, useLocation, useNavigate, type NavigateFunction } from "react-router";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VersionSelect } from "./VersionSelect.js";
import * as apiClient from "~/lib/api-client.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import {
  COLLEAGUE_EMAIL,
  COLLEAGUE_ID,
  GROUP_ID,
  MEMBER_EMAIL,
  MEMBER_ID,
  MINE,
  PUBLISHED_FIELDS,
  versionFixture,
  versionSummaryOf,
} from "~/test/configurations.js";

/*
 * The version picker (D10 decision 10): the trigger, the rows with
 * their creator and last saved date, choosing a row, its pencil, "Create New
 * Version", and no label or email in any attribute (ADR 0024).
 */

const LABEL_3 = "Add tail sampling 7c2e";
const LABEL_1 = "Initial version 5d1a";
const VERSION_1 = versionFixture({
  yamlContent: "receivers: {}\n",
  label: LABEL_1,
  createdBy: { userId: MEMBER_ID, email: MEMBER_EMAIL },
  updatedAt: "2026-04-20T12:00:00.000Z",
});
const VERSION_2 = versionFixture({
  id: "0199c000-0000-7000-8000-000000000012",
  versionNumber: 2,
  label: null,
  createdBy: null,
  yamlContent: "exporters: {}\n",
  updatedAt: "2026-05-01T12:00:00.000Z",
});
const VERSION_3 = versionFixture({
  id: "0199c000-0000-7000-8000-000000000013",
  versionNumber: 3,
  label: LABEL_3,
  createdBy: { userId: COLLEAGUE_ID, email: COLLEAGUE_EMAIL },
  yamlContent: "processors: {}\n",
  updatedAt: "2026-06-02T12:00:00.000Z",
});
const LISTED = [versionSummaryOf(VERSION_3), versionSummaryOf(VERSION_2), versionSummaryOf(VERSION_1)];

const initialState = useEditorStore.getState();

/** The page's router's navigate, for Back. */
let navigateInPage: NavigateFunction | null = null;

/** The picker at the open version's address, with MINE loaded in the group organization. */
function renderPicker({
  open = VERSION_3,
  configurationSegment = MINE.id,
  before,
  versions = LISTED,
}: { open?: typeof VERSION_3; configurationSegment?: string; before?: string; versions?: ConfigurationVersionSummary[] } = {}) {
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: open, versions });
  function Page() {
    const navigate = useNavigate();
    useEffect(() => {
      navigateInPage = navigate;
    }, [navigate]);
    return (
      <>
        <p data-testid="address">{useLocation().pathname}</p>
        <p data-testid="entry">{useLocation().key}</p>
        <VersionSelect />
      </>
    );
  }
  const path = `/editor/${configurationSegment}/${open.id}`;
  const Stub = createRoutesStub([
    { path: "/editor/:configurationId/:versionId?", Component: Page, loader: () => null, HydrateFallback: () => null },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={before === undefined ? [path] : [before, path]} initialIndex={before === undefined ? 0 : 1} />);
  return userEvent.setup();
}

const trigger = () => screen.findByRole("combobox", { name: /^Version:/ });
const address = () => screen.getByTestId("address").textContent;
/** The history entry's key: a navigation, even to the same address, makes another. */
const entry = () => screen.getByTestId("entry").textContent;

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await trigger());
  return screen.findByRole("listbox");
}

/** A row's two lines: the label, then `v{n} · email · date`. */
function rowLines(option: HTMLElement): string[] {
  const text = option.querySelector(".flex-col")!;
  return [...text.children].map((line) => line.textContent ?? "");
}

const dateOf = (summary: ConfigurationVersionSummary) => new Date(summary.updatedAt).toLocaleDateString();

beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState(initialState, true);
  navigateInPage = null;
});

describe("VersionSelect", () => {
  it('shows "Version:" and the open version as `v{n}: label`, 14 rem wide, named by both; below the widest screens "Version:" is read only and the trigger 10 rem wide (D13a Ruling 42)', async () => {
    renderPicker();
    const select = await trigger();

    expect(screen.getByText("Version:")).toHaveClass("text-xs", "text-muted-foreground", "sr-only", "2xl:not-sr-only");
    expect(select).toHaveTextContent(`v3: ${LABEL_3}`);
    expect(select).toHaveAccessibleName(`Version: v3: ${LABEL_3}`);
    expect(select).toHaveClass("h-7", "w-40", "2xl:w-56", "text-xs");
    expect(within(select).getByText("v3:")).toHaveClass("font-mono");
    expect(within(select).getByText(LABEL_3)).toHaveClass("truncate");
  });

  it('shows an unnamed open version as "Version N"', async () => {
    renderPicker({ open: VERSION_2 });

    expect(await trigger()).toHaveTextContent("v2: Version 2");
  });

  it("lists every version highest first: the label, then v{n}, the creator's email (— without one) and the last saved date; the open one checked", async () => {
    const user = renderPicker();
    const listbox = await openPicker(user);

    const options = within(listbox).getAllByRole("option");
    expect(options.map(rowLines)).toEqual([
      [LABEL_3, `v3 · ${COLLEAGUE_EMAIL} · ${dateOf(VERSION_3)}`],
      ["Version 2", `v2 · — · ${dateOf(VERSION_2)}`],
      [LABEL_1, `v1 · ${MEMBER_EMAIL} · ${dateOf(VERSION_1)}`],
    ]);
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(options[0]).toHaveAttribute("data-state", "checked");
    // 20 rem wide, so the second line fits.
    expect(listbox.closest(".w-80")).not.toBeNull();
    expect(within(listbox).getByRole("button", { name: "Create New Version" })).toBeEnabled();
  });

  it("choosing a row navigates to its address, replacing the history entry", async () => {
    const user = renderPicker({ before: "/app" });
    const listbox = await openPicker(user);

    await user.click(within(listbox).getByRole("option", { name: new RegExp(LABEL_1) }));

    await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${VERSION_1.id}`));
    expect(screen.queryByRole("listbox")).toBeNull();
    // Replaced, not pushed: Back leaves the editor.
    act(() => void navigateInPage!(-1));
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
  });

  it("keeps the configuration's id as the address spells it (D10 Preflight ruling 5)", async () => {
    const upper = MINE.id.toUpperCase();
    const user = renderPicker({ configurationSegment: upper });
    const listbox = await openPicker(user);

    await user.click(within(listbox).getByRole("option", { name: /Version 2/ }));

    await waitFor(() => expect(address()).toBe(`/editor/${upper}/${VERSION_2.id}`));
  });

  it("choosing the open row goes nowhere: the same history entry (D10 Ruling 31)", async () => {
    const user = renderPicker({ before: "/app" });
    const listbox = await openPicker(user);
    const before = entry();
    expect(before).not.toBe("");

    await user.click(within(listbox).getByRole("option", { name: new RegExp(LABEL_3) }));

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await act(async () => {});
    expect(address()).toBe(`/editor/${MINE.id}/${VERSION_3.id}`);
    expect(entry()).toBe(before);
  });

  it("each row's pencil, \"Rename version\", opens the rename dialog for its version, and doesn't choose the row", async () => {
    const user = renderPicker();
    const listbox = await openPicker(user);
    const pencils = within(listbox).getAllByRole("button", { name: "Rename version" });
    expect(pencils).toHaveLength(3);

    await user.click(pencils[2]!);

    const dialog = await screen.findByRole("dialog", { name: "Rename Version" });
    expect(within(dialog).getByRole("textbox", { name: "Version name" })).toHaveValue(LABEL_1);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(address()).toBe(`/editor/${MINE.id}/${VERSION_3.id}`);
    expect(useEditorStore.getState().version).toEqual(VERSION_3);
    // Opened once the list had gone and returned the focus: the field keeps it.
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Version name" })).toHaveFocus());
  });

  it("describes each pencil by its row's text, through opaque ids (D10 Ruling 33)", async () => {
    const user = renderPicker();
    const listbox = await openPicker(user);
    const options = within(listbox).getAllByRole("option");

    for (const [index, option] of options.entries()) {
      const pencil = within(option).getByRole("button", { name: "Rename version" });
      const [label, detail] = [...option.querySelector(".flex-col")!.children];
      // The row's own two lines, by id; the ids say nothing of the label.
      expect(pencil.getAttribute("aria-describedby")).toBe(`${label!.id} ${detail!.id}`);
      expect(label!.id).not.toBe("");
      expect(detail!.id).not.toBe("");
      expect(pencil).toHaveAccessibleDescription(rowLines(option).join(" "));
      expect(pencil).toHaveAccessibleName("Rename version");
      expect(index).toBeLessThan(3);
    }
    expect(within(options[1]!).getByRole("button", { name: "Rename version" })).toHaveAccessibleDescription(
      `Version 2 v2 · — · ${dateOf(VERSION_2)}`,
    );
  });

  it("a rename shows in the trigger and the row", async () => {
    vi.spyOn(apiClient, "renameConfigurationVersion").mockResolvedValue({
      version: { ...versionSummaryOf(VERSION_3), label: "Tail sampling, renamed" },
    });
    vi.spyOn(toast, "success");
    const user = renderPicker();
    let listbox = await openPicker(user);
    await user.click(within(listbox).getAllByRole("button", { name: "Rename version" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Rename Version" });
    const field = within(dialog).getByRole("textbox", { name: "Version name" });

    await user.clear(field);
    await user.type(field, "Tail sampling, renamed{Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await trigger()).toHaveTextContent("v3: Tail sampling, renamed");
    listbox = await openPicker(user);
    expect(rowLines(within(listbox).getAllByRole("option")[0]!)[0]).toBe("Tail sampling, renamed");
  });

  it('"Create New Version" opens the Copy Version dialog', async () => {
    const user = renderPicker();
    const listbox = await openPicker(user);

    await user.click(within(listbox).getByRole("button", { name: "Create New Version" }));

    expect(await screen.findByRole("dialog", { name: "Copy Version" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it('"Create New Version" is disabled while a save is under way', async () => {
    const user = renderPicker();
    act(() => useEditorStore.getState().setSaving(true));
    const listbox = await openPicker(user);

    expect(within(listbox).getByRole("button", { name: "Create New Version" })).toBeDisabled();
  });

  it('"Create New Version" is disabled while the store says a create is under way, whichever started it (D10 Ruling 45)', async () => {
    const user = renderPicker();
    act(() => useEditorStore.getState().setCreatingVersion(true));
    let listbox = await openPicker(user);

    expect(within(listbox).getByRole("button", { name: "Create New Version" })).toBeDisabled();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    act(() => useEditorStore.getState().setCreatingVersion(false));
    listbox = await openPicker(user);
    expect(within(listbox).getByRole("button", { name: "Create New Version" })).toBeEnabled();
  });

  it('"Create New Version" is disabled while a create is under way', async () => {
    let finish!: (response: ConfigurationVersionResponse) => void;
    vi.spyOn(apiClient, "createConfigurationVersion").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const user = renderPicker();
    let listbox = await openPicker(user);
    await user.click(within(listbox).getByRole("button", { name: "Create New Version" }));
    const dialog = await screen.findByRole("dialog", { name: "Copy Version" });
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await within(dialog).findByRole("button", { name: "Creating…" });

    // The picker under the dialog, as a create's pointer would find it were the dialog gone.
    act(() => screen.getByRole("combobox", { hidden: true }).focus());
    await act(async () => {
      await user.keyboard("{ArrowDown}");
    });
    listbox = await screen.findByRole("listbox", { hidden: true });
    expect(within(listbox).getByRole("button", { name: "Create New Version", hidden: true })).toBeDisabled();

    const created = versionFixture({ id: "0199c000-0000-7000-8000-000000000014", versionNumber: 4 });
    await act(async () => finish({ version: created }));
  });

  describe("the focus once a dialog closes: back on the trigger (D10's final review)", () => {
    /** Opens the rename dialog from the first row's pencil. */
    async function openRename(user: ReturnType<typeof userEvent.setup>) {
      const listbox = await openPicker(user);
      await user.click(within(listbox).getAllByRole("button", { name: "Rename version" })[0]!);
      const dialog = await screen.findByRole("dialog", { name: "Rename Version" });
      await waitFor(() => expect(within(dialog).getByRole("textbox")).toHaveFocus());
      return dialog;
    }

    /** Opens the Copy Version dialog from "Create New Version". */
    async function openCreate(user: ReturnType<typeof userEvent.setup>) {
      const listbox = await openPicker(user);
      await user.click(within(listbox).getByRole("button", { name: "Create New Version" }));
      const dialog = await screen.findByRole("dialog", { name: "Copy Version" });
      await waitFor(() => expect(within(dialog).getByRole("textbox")).toHaveFocus());
      return dialog;
    }

    it("the rename dialog's Cancel, Escape and a rename", async () => {
      vi.spyOn(apiClient, "renameConfigurationVersion").mockResolvedValue({
        version: { ...versionSummaryOf(VERSION_3), label: "Renamed 9b1c" },
      });
      vi.spyOn(toast, "success");
      const user = renderPicker();

      let dialog = await openRename(user);
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(async () => expect(await trigger()).toHaveFocus());

      dialog = await openRename(user);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(async () => expect(await trigger()).toHaveFocus());

      dialog = await openRename(user);
      await user.clear(within(dialog).getByRole("textbox"));
      await user.type(within(dialog).getByRole("textbox"), "Renamed 9b1c{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(async () => expect(await trigger()).toHaveFocus());
      expect(document.activeElement).not.toBe(document.body);
    });

    it("the Copy Version dialog's Cancel, Escape and a create", async () => {
      const created = versionFixture({ id: "0199c000-0000-7000-8000-000000000014", versionNumber: 4 });
      vi.spyOn(apiClient, "createConfigurationVersion").mockResolvedValue({ version: created });
      const user = renderPicker();

      let dialog = await openCreate(user);
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(async () => expect(await trigger()).toHaveFocus());

      dialog = await openCreate(user);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(async () => expect(await trigger()).toHaveFocus());

      dialog = await openCreate(user);
      await user.click(within(dialog).getByRole("button", { name: "Continue" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${created.id}`));
      await waitFor(async () => expect(await trigger()).toHaveFocus());
      expect(await trigger()).toHaveTextContent("v4: Version 4");
    });
  });

  describe("by keyboard alone (D10 Ruling 28)", () => {
    /** The element with focus. */
    const focused = () => document.activeElement as HTMLElement;
    /** The row `option`'s pencil. */
    const pencilIn = (option: HTMLElement) => within(option).getByRole("button", { name: "Rename version" });

    /** Focuses the trigger without a pointer, and opens the list with Enter: the open row has focus. */
    async function openByKeyboard(user: ReturnType<typeof userEvent.setup>) {
      const select = await trigger();
      act(() => select.focus());
      await user.keyboard("{Enter}");
      const listbox = await screen.findByRole("listbox");
      const options = within(listbox).getAllByRole("option");
      await waitFor(() => expect(focused()).toBe(options[0]));
      return { listbox, options };
    }

    it("Tab goes from the focused row to its pencil, then to Create New Version; Shift+Tab goes back; the arrows still move between rows", async () => {
      const user = renderPicker();
      const { listbox, options } = await openByKeyboard(user);
      const create = within(listbox).getByRole("button", { name: "Create New Version" });

      await user.keyboard("{Tab}");
      expect(focused()).toBe(pencilIn(options[0]!));
      await user.keyboard("{Tab}");
      expect(focused()).toBe(create);
      // The foot is the end: Tab stays.
      await user.keyboard("{Tab}");
      expect(focused()).toBe(create);
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(focused()).toBe(pencilIn(options[0]!));
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(focused()).toBe(options[0]);

      // Radix's arrows, from a row.
      await user.keyboard("{ArrowDown}");
      await waitFor(() => expect(focused()).toBe(options[1]));
      await user.keyboard("{Tab}");
      expect(focused()).toBe(pencilIn(options[1]!));
      // From a pencil, the arrows move on from its row.
      await user.keyboard("{ArrowDown}");
      await waitFor(() => expect(focused()).toBe(options[2]));
      await user.keyboard("{Tab}{ArrowUp}");
      await waitFor(() => expect(focused()).toBe(options[1]));
      // From Create New Version, up is the last row.
      await user.keyboard("{Tab}{Tab}");
      expect(focused()).toBe(create);
      await user.keyboard("{ArrowUp}");
      await waitFor(() => expect(focused()).toBe(options[2]));
      // Enter on a row still chooses it.
      await user.keyboard("{ArrowUp}");
      await waitFor(() => expect(focused()).toBe(options[1]));
      await user.keyboard("{Enter}");
      await waitFor(() => expect(address()).toBe(`/editor/${MINE.id}/${VERSION_2.id}`));
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it.each([
      ["Enter", "{Enter}"],
      ["Space", " "],
    ])("%s on a pencil opens the rename dialog for its version, without choosing the row", async (_key, keys) => {
      const user = renderPicker({ before: "/app" });
      const { options } = await openByKeyboard(user);
      const before = entry();

      await user.keyboard("{ArrowDown}");
      await waitFor(() => expect(focused()).toBe(options[1]));
      await user.keyboard("{Tab}");
      expect(focused()).toBe(pencilIn(options[1]!));
      await user.keyboard(keys);

      const dialog = await screen.findByRole("dialog", { name: "Rename Version" });
      expect(within(dialog).getByRole("textbox", { name: "Version name" })).toHaveValue("Version 2");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(address()).toBe(`/editor/${MINE.id}/${VERSION_3.id}`);
      expect(entry()).toBe(before);
      expect(useEditorStore.getState().version).toEqual(VERSION_3);
    });

    it("Enter on Create New Version opens the Copy Version dialog", async () => {
      const user = renderPicker();
      await openByKeyboard(user);

      await user.keyboard("{Tab}{Tab}{Enter}");

      const dialog = await screen.findByRole("dialog", { name: "Copy Version" });
      await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Version name (optional)" })).toHaveFocus());
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(address()).toBe(`/editor/${MINE.id}/${VERSION_3.id}`);
    });

    it("Tab from a pencil stays while Create New Version is disabled; Escape still closes the list", async () => {
      const user = renderPicker();
      act(() => useEditorStore.getState().setSaving(true));
      const { options } = await openByKeyboard(user);

      await user.keyboard("{Tab}{Tab}");
      expect(focused()).toBe(pencilIn(options[0]!));
      await user.keyboard("{Escape}");

      await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
      expect(address()).toBe(`/editor/${MINE.id}/${VERSION_3.id}`);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("puts no label or email in any attribute: closed, open, renaming and creating (ADR 0024)", async () => {
    const user = renderPicker();
    const privateValues = [LABEL_3, LABEL_1, "Version 2", COLLEAGUE_EMAIL, MEMBER_EMAIL, "Typed name 3f9a"];

    /** Every attribute in the document, portals included; a field's own value is its text (replay masks inputs). */
    function assertNoAttributeCarries() {
      const attributes = [...document.querySelectorAll("*")].flatMap((element) =>
        [...element.attributes]
          .filter((attribute) => !(element.tagName === "INPUT" && attribute.name === "value"))
          .map((attribute) => `${element.tagName} ${attribute.name}="${attribute.value}"`),
      );
      expect(attributes.length).toBeGreaterThan(0);
      for (const value of privateValues) {
        expect(attributes.filter((attribute) => attribute.includes(value))).toEqual([]);
      }
    }

    // The text is on the page, so the walk would find it in an attribute.
    expect(await trigger()).toHaveTextContent(LABEL_3);
    assertNoAttributeCarries();

    let listbox = await openPicker(user);
    expect(listbox).toHaveTextContent(COLLEAGUE_EMAIL);
    expect(listbox).toHaveTextContent(MEMBER_EMAIL);
    // The options' values are the versions' ids.
    assertNoAttributeCarries();

    await user.click(within(listbox).getAllByRole("button", { name: "Rename version" })[0]!);
    const rename = await screen.findByRole("dialog", { name: "Rename Version" });
    expect(within(rename).getByRole("textbox")).toHaveValue(LABEL_3);
    assertNoAttributeCarries();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    listbox = await openPicker(user);
    await user.click(within(listbox).getByRole("button", { name: "Create New Version" }));
    const create = await screen.findByRole("dialog", { name: "Copy Version" });
    await user.type(within(create).getByRole("textbox"), "Typed name 3f9a");
    assertNoAttributeCarries();
  });

  describe("published rows (D11b decisions 4 and 13)", () => {
    const LOCK = "Published versions are immutable";
    /** v3 and v1 published, v2 a draft; v3 open. */
    const OPEN = { ...VERSION_3, ...PUBLISHED_FIELDS };
    const MIXED = [
      versionSummaryOf(OPEN),
      versionSummaryOf(VERSION_2),
      { ...versionSummaryOf(VERSION_1), ...PUBLISHED_FIELDS },
    ];
    const focused = () => document.activeElement as HTMLElement;

    it("show the lock in the pencil's place, with fixed text as its name and tooltip, and say Published; drafts keep the pencil", async () => {
      const user = renderPicker({ open: OPEN, versions: MIXED });
      const listbox = await openPicker(user);
      const [v3, v2, v1] = within(listbox).getAllByRole("option");

      for (const row of [v3!, v1!]) {
        expect(within(row).queryByRole("button", { name: "Rename version" })).toBeNull();
        const lock = within(row).getByRole("img", { name: LOCK });
        expect(lock).toHaveAttribute("title", LOCK);
        expect(lock).toHaveAccessibleName(LOCK);
        expect(lock.querySelector("svg.lucide-lock")).not.toBeNull();
        expect(rowLines(row)[1]).toMatch(/ · Published$/);
      }
      expect(within(v2!).getByRole("button", { name: "Rename version" })).toBeInTheDocument();
      expect(within(v2!).queryByRole("img", { name: LOCK })).toBeNull();
      expect(rowLines(v2!)[1]).not.toContain("Published");
      expect(rowLines(v1!)).toEqual([LABEL_1, `v1 · ${MEMBER_EMAIL} · ${dateOf(VERSION_1)} · Published`]);
    });

    it("describe the lock by its row's text, through opaque ids, as a pencil is", async () => {
      const user = renderPicker({ open: OPEN, versions: MIXED });
      const listbox = await openPicker(user);
      const v1 = within(listbox).getAllByRole("option")[2]!;
      const lock = within(v1).getByRole("img", { name: LOCK });
      expect(lock).toHaveAccessibleDescription(rowLines(v1).join(" "));
    });

    it("a click on the lock opens nothing and chooses nothing", async () => {
      const user = renderPicker({ open: OPEN, versions: MIXED });
      const listbox = await openPicker(user);
      await user.click(within(within(listbox).getAllByRole("option")[2]!).getByRole("img", { name: LOCK }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(address()).toBe(`/editor/${MINE.id}/${OPEN.id}`);
    });

    it("by keyboard: Tab goes from a published row to its lock, then to Create New Version; Shift+Tab goes back; Enter on it does nothing", async () => {
      const user = renderPicker({ open: OPEN, versions: MIXED });
      const select = await trigger();
      act(() => select.focus());
      await user.keyboard("{Enter}");
      const listbox = await screen.findByRole("listbox");
      const options = within(listbox).getAllByRole("option");
      await waitFor(() => expect(focused()).toBe(options[0]));
      const create = within(listbox).getByRole("button", { name: "Create New Version" });
      const lock = within(options[0]!).getByRole("img", { name: LOCK });

      await user.keyboard("{Tab}");
      expect(focused()).toBe(lock);
      expect(focused()).toHaveAccessibleName(LOCK);
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(focused()).toBe(lock);
      await user.keyboard("{Tab}");
      expect(focused()).toBe(create);
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(focused()).toBe(lock);
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(focused()).toBe(options[0]);
      // The arrows from the lock move on from its row, to the draft with its pencil.
      await user.keyboard("{Tab}{ArrowDown}");
      await waitFor(() => expect(focused()).toBe(options[1]));
      await user.keyboard("{Tab}");
      expect(focused()).toBe(within(options[1]!).getByRole("button", { name: "Rename version" }));
    });

    it("put no label or email in any attribute", async () => {
      const user = renderPicker({ open: OPEN, versions: MIXED });
      const listbox = await openPicker(user);
      expect(listbox).toHaveTextContent(LABEL_1);
      const attributes = [...document.querySelectorAll("*")].flatMap((element) =>
        [...element.attributes].map((attribute) => attribute.value),
      );
      for (const value of [LABEL_3, LABEL_1, COLLEAGUE_EMAIL, MEMBER_EMAIL]) {
        expect(attributes.filter((attribute) => attribute.includes(value))).toEqual([]);
      }
    });
  });
});
