import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Configuration, ConfigurationVersion } from "@telflo/contracts";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollectorVersionSelect, DEPRECATION_NOTE_LABEL, DISTRIBUTION_LOCKED_TOOLTIP } from "./CollectorVersionSelect.js";
import { EditorToolbar } from "./EditorToolbar.js";
import { resetCollectorCatalogue } from "~/lib/stores/collector-catalogue-store.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import {
  ACME,
  CATALOGUE,
  CONTRIB,
  CONTRIB_LABEL,
  RETIRED_NOTE,
  RETIRED_VERSION,
  seedCatalogue,
} from "~/test/collector-distributions.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, THEIRS, versionFixture } from "~/test/configurations.js";

/*
 * The toolbar's collector picker: the `CollectorVersionSelect` cases (no
 * ClickStack flag or public picker), then the deprecated pin, the read-only
 * published version and privacy. The editor's store holds the configuration
 * and the pin (`load`), so the hydration cases are the store's loads.
 */

const LABEL = "Tail sampling zq7c";
const VERSION = versionFixture({ label: LABEL, yamlContent: "receivers: {}\n" });
const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

function open(version: ConfigurationVersion = VERSION, configuration: Configuration = MINE) {
  store().load({ organizationId: GROUP_ID, configuration, version });
}

function renderPicker() {
  render(<CollectorVersionSelect />);
  return userEvent.setup();
}

/** The read-only distribution, by its name. */
function queryLockedDistribution() {
  return screen.queryByLabelText(/distribution: .* \(locked at creation\)/i);
}

function findLockedDistribution() {
  return screen.findByLabelText(/distribution: .* \(locked at creation\)/i);
}

const versionPicker = () => screen.getByRole("combobox", { name: /collector version/i });

/** A deprecated pin's note mark, whose tooltip is the note. */
const queryNoteMark = () => screen.queryByRole("img", { name: DEPRECATION_NOTE_LABEL });

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  resetCollectorCatalogue();
  seedCatalogue();
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CollectorVersionSelect", () => {
  it("renders the locked distribution and an interactive version dropdown", async () => {
    open();
    renderPicker();

    const locked = await findLockedDistribution();
    expect(locked).toHaveTextContent(/Otel Contrib/);
    // The distribution is NOT a dropdown: it is locked at creation.
    expect(screen.queryByRole("combobox", { name: /distribution/i })).toBeNull();
    expect(versionPicker()).toBeEnabled();
    expect(versionPicker()).toHaveTextContent(/^v0\.162\.0$/);
  });

  it("shows the compact short label on the locked display", async () => {
    open();
    renderPicker();

    const locked = await findLockedDistribution();
    expect(locked).toHaveTextContent("Otel Contrib");
    expect(locked).not.toHaveTextContent(CONTRIB_LABEL);
  });

  it("explains the lock in a tooltip, in its fixed words", async () => {
    open();
    const user = renderPicker();
    expect(screen.queryAllByText(DISTRIBUTION_LOCKED_TOOLTIP)).toHaveLength(0);

    await user.hover(await findLockedDistribution());

    expect((await screen.findAllByText(DISTRIBUTION_LOCKED_TOOLTIP)).length).toBeGreaterThan(0);
    expect(DISTRIBUTION_LOCKED_TOOLTIP).toBe("Set when this configuration was created.");
  });

  it("is an image named for the distribution and its lock (VersionSelect's lock's pattern)", async () => {
    open();
    renderPicker();

    expect(await screen.findByRole("img", { name: "Distribution: Otel Contrib (locked at creation)" })).toBe(
      await findLockedDistribution(),
    );
  });

  it("says \"Collector:\" to the eye only, on wide screens: the picker's name says it, so it isn't read twice", async () => {
    open();
    renderPicker();

    const word = await screen.findByText("Collector:");
    expect(word).toHaveAttribute("aria-hidden", "true");
    expect(word).toHaveClass("hidden", "2xl:inline");
    expect(versionPicker()).toHaveAccessibleName("Collector version v0.162.0");
  });

  it("explains the lock to the keyboard too: the display takes the focus, which opens the tooltip", async () => {
    open();
    const user = renderPicker();

    await user.tab();

    expect(await findLockedDistribution()).toHaveFocus();
    expect((await screen.findAllByText(DISTRIBUTION_LOCKED_TOOLTIP)).length).toBeGreaterThan(0);
  });

  it("offers no way to change the distribution", async () => {
    open();
    const user = renderPicker();

    const locked = await findLockedDistribution();
    // Clicking the read-only display neither opens a menu nor changes anything.
    await user.click(locked);
    expect(screen.queryByRole("option")).toBeNull();
    expect(store().configuration?.collectorDistribution).toBe(CONTRIB.id);
    expect(selectIsDirty(store())).toBe(false);
  });

  it("keeps the distribution when picking a version, and changing the version marks the version unsaved", async () => {
    open();
    const user = renderPicker();

    await user.click(versionPicker());
    await user.click(await screen.findByRole("option", { name: /0\.161\.0/ }));

    await waitFor(() => expect(store().collectorVersion).toBe("0.161.0"));
    expect(versionPicker()).toHaveTextContent(/^v0\.161\.0$/);
    expect(store().configuration?.collectorDistribution).toBe(CONTRIB.id);
    expect(selectIsDirty(store())).toBe(true);
  });

  it("keeps a distribution the catalogue doesn't list instead of swapping it, the pin as text", async () => {
    open(versionFixture({ collectorVersion: "1.0.0" }), { ...MINE, collectorDistribution: "grafana-alloy" });
    renderPicker();

    const locked = await findLockedDistribution();
    expect(locked).toHaveTextContent("grafana-alloy");
    expect(store()).toMatchObject({ collectorVersion: "1.0.0" });
    // No version list for an unknown distribution: the pinned version as plain text.
    expect(screen.queryByRole("combobox", { name: /collector version/i })).toBeNull();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });

  it("shows the distribution and the pin even when the catalogue is unreachable", async () => {
    resetCollectorCatalogue();
    open();
    renderPicker();

    const locked = await findLockedDistribution();
    expect(locked).toHaveTextContent("Otel Contrib");
    expect(locked.querySelector('svg[aria-label="OpenTelemetry"]')).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: /collector version/i })).toBeNull();
    expect(screen.getByText("v0.162.0")).toBeInTheDocument();
  });

  // Every version has a pin, so the leak to guard against is the previous
  // version's pin, not a previous distribution.
  it("does not leak the previous version's pin when another configuration's version opens", async () => {
    open(versionFixture({ collectorVersion: "0.160.0" }));
    renderPicker();
    expect(versionPicker()).toHaveTextContent(/^v0\.160\.0$/);

    act(() => open(versionFixture({ id: "0199c000-0000-7000-8000-000000000021", collectorVersion: "0.161.0" }), THEIRS));

    expect(versionPicker()).toHaveTextContent(/^v0\.161\.0$/);
    expect(store().collectorVersion).toBe("0.161.0");
  });

  it("re-hydrates from the newly opened version when another configuration of another distribution opens", async () => {
    seedCatalogue([...CATALOGUE, ACME]);
    open();
    renderPicker();
    expect(await findLockedDistribution()).toHaveTextContent(/Otel Contrib/);

    act(() =>
      open(versionFixture({ id: "0199c000-0000-7000-8000-000000000022", collectorVersion: "2.36.0" }), {
        ...THEIRS,
        collectorDistribution: ACME.id,
      }),
    );

    await waitFor(() => expect(queryLockedDistribution()).toHaveTextContent(/Acme Collector/));
    expect(versionPicker()).toHaveTextContent(/^v2\.36\.0$/);
  });

  it("re-hydrates when the page reloads the SAME version after the store was emptied", async () => {
    open();
    renderPicker();
    await findLockedDistribution();

    act(() => store().reset());
    expect(queryLockedDistribution()).toBeNull();
    act(() => open({ ...VERSION, collectorVersion: "0.161.0" }));

    expect(await findLockedDistribution()).toHaveTextContent(/Otel Contrib/);
    expect(versionPicker()).toHaveTextContent(/^v0\.161\.0$/);
  });

  it("shows nothing (no display, no default) while no version is loaded", async () => {
    renderPicker();

    expect(queryLockedDistribution()).toBeNull();
    expect(screen.queryByText("Collector:")).toBeNull();
    expect(store().collectorVersion).toBeNull();

    act(() => open());
    expect(await findLockedDistribution()).toHaveTextContent(/Otel Contrib/);
  });
});

describe("CollectorVersionSelect's list", () => {
  it("lists the distribution's offered versions newest first, each v-prefixed with its description, the default marked", async () => {
    open();
    const user = renderPicker();

    await user.click(versionPicker());
    const options = await screen.findAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual([
      "v0.162.0DefaultCurrent default.",
      "v0.161.0",
      "v0.160.0",
    ]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(CONTRIB_LABEL)).toBeInTheDocument();
  });

  it("shows a version's catalogue label beside it when it says more than the version", async () => {
    seedCatalogue([{ ...CONTRIB, versions: [{ ...CONTRIB.versions[0]!, label: "Recommended" }] }]);
    open();
    const user = renderPicker();

    await user.click(versionPicker());

    expect((await screen.findByRole("option")).textContent).toBe("v0.162.0RecommendedDefaultCurrent default.");
  });
});

describe("a deprecated pin", () => {
  const RETIRED = versionFixture({
    label: LABEL,
    collectorVersion: RETIRED_VERSION,
    collectorVersionDeprecated: true,
    collectorVersionDeprecatedNote: RETIRED_NOTE,
  });

  it("is shown as v0.155.0 (deprecated), with the catalogue's note behind a mark that takes the focus, and kept", async () => {
    open(RETIRED);
    const user = renderPicker();

    expect(versionPicker()).toHaveTextContent(/^v0\.155\.0 \(deprecated\)$/);
    expect(versionPicker()).not.toHaveAttribute("title");
    expect(versionPicker()).toHaveAccessibleName("Collector version v0.155.0 (deprecated)");
    expect(store().collectorVersion).toBe(RETIRED_VERSION);
    expect(selectIsDirty(store())).toBe(false);

    // The keyboard reaches the note: the lock, the picker, then the mark, whose tooltip is the note.
    expect(screen.queryAllByText(RETIRED_NOTE)).toHaveLength(0);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(queryNoteMark()).toHaveFocus();
    expect((await screen.findAllByText(RETIRED_NOTE)).length).toBeGreaterThan(0);
  });

  it("shows its note on hover too", async () => {
    open(RETIRED);
    const user = renderPicker();

    await user.hover(queryNoteMark()!);

    expect((await screen.findAllByText(RETIRED_NOTE)).length).toBeGreaterThan(0);
  });

  it("is listed first while it is the pin, with its note; once another is picked it can't be picked again", async () => {
    open(RETIRED);
    const user = renderPicker();

    await user.click(versionPicker());
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent(`v0.155.0 (deprecated)${RETIRED_NOTE}`);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("option", { name: /0\.162\.0/ }));

    await waitFor(() => expect(store().collectorVersion).toBe("0.162.0"));
    expect(versionPicker()).toHaveTextContent(/^v0\.162\.0$/);
    expect(queryNoteMark()).toBeNull();
    expect(selectIsDirty(store())).toBe(true);

    await user.click(versionPicker());
    const after = await screen.findAllByRole("option");
    expect(after.some((option) => option.textContent?.includes("0.155.0"))).toBe(false);
  });

  it("comes back with its note when Discard puts the saved pin back", async () => {
    open(RETIRED);
    renderPicker();
    act(() => store().setCollectorVersion("0.162.0"));
    expect(versionPicker()).toHaveTextContent(/^v0\.162\.0$/);

    expect(queryNoteMark()).toBeNull();

    act(() => store().discardChanges());

    expect(versionPicker()).toHaveTextContent(/^v0\.155\.0 \(deprecated\)$/);
    expect(queryNoteMark()).toBeInTheDocument();
  });

  it("is shown as deprecated, with its note, while the catalogue is unread", async () => {
    resetCollectorCatalogue();
    open(RETIRED);
    renderPicker();

    expect(screen.getByText("v0.155.0 (deprecated)")).toBeInTheDocument();
    expect(queryNoteMark()).toBeInTheDocument();
  });

  it("the saved pin's deprecation is the server's, not the catalogue read with the page: a release it doesn't list isn't marked deprecated", async () => {
    // A teammate picked 0.163.0, released since this page read the catalogue; the server says it is offered.
    open(versionFixture({ collectorVersion: "0.163.0" }));
    const user = renderPicker();

    expect(versionPicker()).toHaveTextContent(/^v0\.163\.0$/);
    expect(queryNoteMark()).toBeNull();
    // Still listed first, as the pin, so the dropdown shows it selected.
    await user.click(versionPicker());
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent(/^v0\.163\.0$/);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("the server's flag marks a saved pin deprecated that the page's catalogue still offers (retired since the page read it)", async () => {
    open(
      versionFixture({ collectorVersion: "0.160.0", collectorVersionDeprecated: true, collectorVersionDeprecatedNote: RETIRED_NOTE }),
    );
    renderPicker();

    expect(versionPicker()).toHaveTextContent(/^v0\.160\.0 \(deprecated\)$/);
    expect(queryNoteMark()).toBeInTheDocument();
  });

  it("a pick's deprecation is the catalogue's: a pin on screen that isn't the saved one and that the catalogue doesn't offer is marked", async () => {
    open();
    renderPicker();
    // Not reachable through the dropdown (it offers only what the catalogue does): a store write stands for it.
    act(() => store().setCollectorVersion(RETIRED_VERSION));

    expect(versionPicker()).toHaveTextContent(/^v0\.155\.0 \(deprecated\)$/);
    // The note is the server's, for the saved pin only.
    expect(queryNoteMark()).toBeNull();
  });
});

describe("on a published version", () => {
  it("is read-only with the rest of the editor: the dropdown is disabled, showing the pin", async () => {
    open(versionFixture({ ...VERSION, ...PUBLISHED_FIELDS, collectorVersion: "0.161.0" }));
    const user = renderPicker();

    expect(versionPicker()).toBeDisabled();
    expect(versionPicker()).toHaveTextContent(/^v0\.161\.0$/);
    await user.click(versionPicker());
    expect(screen.queryByRole("option")).toBeNull();
    expect(store().collectorVersion).toBe("0.161.0");
    // The distribution still explains itself.
    expect(await findLockedDistribution()).toHaveTextContent(/Otel Contrib/);
  });

  it("a deprecated pin's note is still reached by the keyboard while the dropdown is disabled", async () => {
    open(
      versionFixture({
        ...VERSION,
        ...PUBLISHED_FIELDS,
        collectorVersion: RETIRED_VERSION,
        collectorVersionDeprecated: true,
        collectorVersionDeprecatedNote: RETIRED_NOTE,
      }),
    );
    const user = renderPicker();
    expect(versionPicker()).toBeDisabled();

    // The lock, then (the disabled picker skipped) the note's mark.
    await user.tab();
    await user.tab();

    expect(queryNoteMark()).toHaveFocus();
    expect((await screen.findAllByText(RETIRED_NOTE)).length).toBeGreaterThan(0);
  });

  it("becomes read-only when the version is published under it", async () => {
    open();
    renderPicker();
    expect(versionPicker()).toBeEnabled();

    act(() => store().replaceVersionSummary({ ...VERSION, ...PUBLISHED_FIELDS }));

    expect(versionPicker()).toBeDisabled();
  });
});

describe("privacy", () => {
  it("puts neither the configuration's name nor the version's label in any attribute, open or closed", async () => {
    open();
    const user = renderPicker();
    await user.click(versionPicker());
    await screen.findAllByRole("option");

    for (const element of document.body.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.value).not.toContain(MINE.name);
        expect(attribute.value).not.toContain(LABEL);
      }
    }
    // Nor in its text: it shows catalogue data only.
    expect(document.body).not.toHaveTextContent(MINE.name);
    expect(document.body).not.toHaveTextContent(LABEL);
  });
});

describe("in the toolbar", () => {
  function renderToolbar(onSave = vi.fn()) {
    const Stub = createRoutesStub([
      {
        path: "/editor",
        Component: () => <EditorToolbar onSave={onSave} />,
        loader: () => null,
        HydrateFallback: () => null,
      },
    ]);
    render(<Stub initialEntries={["/editor"]} />);
    return { onSave, user: userEvent.setup() };
  }

  it("sits at the tail of the left group, and a pick shows Unsaved and enables Save, which saves", async () => {
    open();
    const { onSave, user } = renderToolbar();
    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(screen.queryByText("Unsaved", { exact: true })).toBeNull();
    const name = screen.getByRole("heading", { level: 1 });
    const leftGroup = name.closest("div.flex.items-center.gap-3")!;
    expect(within(leftGroup as HTMLElement).getByRole("combobox", { name: /collector version/i })).toBe(versionPicker());

    await user.click(versionPicker());
    await user.click(await screen.findByRole("option", { name: /0\.160\.0/ }));

    expect(await screen.findByText("Unsaved", { exact: true })).toBeInTheDocument();
    expect(save).toBeEnabled();
    await user.click(save);
    expect(onSave).toHaveBeenCalledOnce();
  });
});
