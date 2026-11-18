import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Configuration, ConfigurationVersionListItem } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import type { OpeningRead } from "~/lib/hooks/use-opening-reads.js";
import { GROUP_ID, THEIRS } from "~/test/configurations.js";
import {
  CONFIGURATION_ID,
  configurationVersionListItem,
  publishedVersion,
  VERSION_ID,
} from "~/test/fleets.js";
import {
  ConfigurationVersionPicker,
  usePublishedConfigurations,
  type ConfigurationsRead,
  type VersionsRead,
} from "./CollectorPinPicker.js";
import { pickerDate, VersionOptionLabel } from "./VersionOptionLabel.js";

/*
 * The pin picker (D17b-1 decision 26; Preflight rulings 6 and 12) and its
 * version labels. Selecting a different configuration selects its newest
 * version in the dialog (once the versions route answers):
 * `EditCollectorDialog.test.tsx`'s "a configuration chosen selects its newest
 * version". The reads, their failures and "Load more" are tested through the
 * dialog too. No search box (D17b-2 Ruling 35, the owner's).
 */

const OTHER_ID = "c0ffee00-0000-4000-8000-000000000001";
const V1_ID = "c0ffee00-0000-4000-8000-000000000011";

const CONFIG_A: Configuration = { ...THEIRS, id: CONFIGURATION_ID, name: "Config A" };
const CONFIG_B: Configuration = { ...THEIRS, id: OTHER_ID, name: "Config B" };

function configurationsRead(items: Configuration[]): ConfigurationsRead {
  return { status: "read", items, nextCursor: null, loadingMore: false, loadMore: vi.fn(), retry: vi.fn() };
}

// Config A has @v1 and @v4 (its newest first, as the versions route answers).
const A_VERSIONS: ConfigurationVersionListItem[] = [
  configurationVersionListItem(),
  configurationVersionListItem({ id: V1_ID, versionNumber: 1 }),
];

function versionsRead(versions: ConfigurationVersionListItem[] = A_VERSIONS): VersionsRead {
  return { configurationId: CONFIGURATION_ID, status: "read", versions, retry: vi.fn() };
}

function renderPicker({ groupDefault = null as ReturnType<typeof publishedVersion> | null } = {}) {
  const onConfiguration = vi.fn();
  const onVersion = vi.fn();
  render(
    <ConfigurationVersionPicker
      configurations={configurationsRead([CONFIG_A, CONFIG_B])}
      versions={versionsRead()}
      configurationId={CONFIGURATION_ID}
      versionId={V1_ID}
      pinned={null}
      groupDefault={groupDefault}
      onConfiguration={onConfiguration}
      onVersion={onVersion}
      disabled={false}
    />,
  );
  return { onConfiguration, onVersion };
}

describe("ConfigurationVersionPicker", () => {
  it("shows the selected configuration's versions", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByLabelText("Version"));
    expect(await screen.findByRole("option", { name: /@v1/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /@v4/ })).toBeInTheDocument();
  });

  it("emits a configuration chosen by its id", async () => {
    const user = userEvent.setup();
    const { onConfiguration } = renderPicker();
    await user.click(screen.getByLabelText("Configuration"));
    await user.click(await screen.findByRole("option", { name: "Config B" }));
    expect(onConfiguration).toHaveBeenCalledWith(OTHER_ID);
  });

  it("emits a version chosen by its id", async () => {
    const user = userEvent.setup();
    const { onVersion } = renderPicker();
    await user.click(screen.getByLabelText("Version"));
    await user.click(await screen.findByRole("option", { name: /@v4/ }));
    expect(onVersion).toHaveBeenCalledWith(VERSION_ID);
  });

  it("marks the group-default configuration and version", async () => {
    const user = userEvent.setup();
    renderPicker({ groupDefault: publishedVersion() });
    await user.click(screen.getByLabelText("Configuration"));
    expect(await screen.findByRole("option", { name: "Config A (group default)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Config B" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByLabelText("Version"));
    expect(await screen.findByRole("option", { name: /@v4 \(group default\)/ })).toBeInTheDocument();
  });

  it('shows "Load more" only while the API has a next page', () => {
    const { rerender } = render(
      <ConfigurationVersionPicker
        configurations={{ ...configurationsRead([CONFIG_A]), nextCursor: "next" }}
        versions={versionsRead()}
        configurationId={null}
        versionId={null}
        pinned={null}
        groupDefault={null}
        onConfiguration={vi.fn()}
        onVersion={vi.fn()}
        disabled={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    rerender(
      <ConfigurationVersionPicker
        configurations={configurationsRead([CONFIG_A])}
        versions={versionsRead()}
        configurationId={null}
        versionId={null}
        pinned={null}
        groupDefault={null}
        onConfiguration={vi.fn()}
        onVersion={vi.fn()}
        disabled={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    // No configuration chosen: no version to pick yet.
    expect(screen.getByLabelText("Version")).toBeDisabled();
  });

  // D17b-2 Ruling 35 (the owner's): more than a page is reached by "Load more" alone.
  it("offers no configuration search box", () => {
    const { container } = render(
      <ConfigurationVersionPicker
        configurations={{ ...configurationsRead([CONFIG_A, CONFIG_B]), nextCursor: "next" }}
        versions={versionsRead()}
        configurationId={CONFIGURATION_ID}
        versionId={V1_ID}
        pinned={publishedVersion()}
        groupDefault={null}
        onConfiguration={vi.fn()}
        onVersion={vi.fn()}
        disabled={false}
      />,
    );
    expect(screen.queryByRole("searchbox", { hidden: true })).toBeNull();
    expect(screen.queryByRole("textbox", { hidden: true })).toBeNull();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    // The Selects and "Load more" are all it shows.
    expect(screen.getAllByRole("combobox")).toEqual([
      screen.getByRole("combobox", { name: "Configuration" }),
      screen.getByRole("combobox", { name: "Version" }),
    ]);
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  });

  it("keeps offering the current pin's configuration and the configurations chosen when the list no longer holds them", async () => {
    const user = userEvent.setup();
    const pinned = publishedVersion({ configurationId: "c0ffee00-0000-4000-8000-0000000000aa", configurationName: "Pinned config" });
    const picker = (items: Configuration[]) => (
      <ConfigurationVersionPicker
        configurations={configurationsRead(items)}
        versions={versionsRead()}
        configurationId={CONFIGURATION_ID}
        versionId={V1_ID}
        pinned={pinned}
        groupDefault={null}
        onConfiguration={vi.fn()}
        onVersion={vi.fn()}
        disabled={false}
      />
    );
    const { rerender } = render(picker([CONFIG_A, CONFIG_B]));
    await user.click(screen.getByLabelText("Configuration"));
    await user.click(await screen.findByRole("option", { name: "Config B" }));
    // The list read again holds neither the pin's configuration nor Config B.
    rerender(picker([CONFIG_A]));
    await user.click(screen.getByLabelText("Configuration"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Pinned config", "Config B", "Config A"]);
  });
});

describe("usePublishedConfigurations's Load more (Preflight ruling 6)", () => {
  it("appends each configuration once: a page repeating one already shown (the cursor is positional) adds only the new", async () => {
    // A configuration updated between the pages moves in the API's order, so the next page can hold it again.
    const getConfigurations = vi
      .spyOn(apiClient, "getConfigurations")
      .mockImplementation(async (_organizationId, query = {}) =>
        query.cursor === undefined ? { items: [CONFIG_A], nextCursor: "1" } : { items: [CONFIG_A, CONFIG_B], nextCursor: null },
      );
    const read: OpeningRead = async (run) => {
      try {
        return { ok: true, value: await run(new AbortController().signal) };
      } catch (error) {
        return { ok: false, error };
      }
    };
    const { result } = renderHook(() => usePublishedConfigurations(true, read, GROUP_ID));
    await waitFor(() => expect(result.current.status).toBe("read"));
    expect(result.current.items.map((item) => item.id)).toEqual([CONFIGURATION_ID]);
    // No search (Ruling 35): the first read sends no q, and the hook offers none.
    expect(getConfigurations.mock.calls[0]![1]).toEqual({ filter: "published", limit: 100 });
    expect(result.current).not.toHaveProperty("search");

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(getConfigurations).toHaveBeenCalledTimes(2);
    expect(getConfigurations.mock.calls[1]![1]).toEqual({ filter: "published", limit: 100, cursor: "1" });
    expect(result.current.items.map((item) => item.id)).toEqual([CONFIGURATION_ID, OTHER_ID]);
    expect(result.current.nextCursor).toBeNull();
    getConfigurations.mockRestore();
  });
});

describe("VersionOptionLabel", () => {
  it("shows the version's label alongside the version tag, and its date in en-US", () => {
    render(<VersionOptionLabel versionNumber={3} label="add redis cache" publishedAt="2026-01-02T12:00:00.000Z" />);
    expect(screen.getByText("add redis cache")).toBeInTheDocument();
    expect(screen.getByText(/@v3/)).toBeInTheDocument();
    expect(screen.getByText(pickerDate("2026-01-02T12:00:00.000Z"))).toBeInTheDocument();
    expect(pickerDate("2026-01-02T12:00:00.000Z")).toMatch(/^Jan \d, 2026$/);
  });

  it("omits the label for an unnamed or blank one", () => {
    const { rerender, container } = render(<VersionOptionLabel versionNumber={1} label={null} />);
    expect(container.textContent).toBe("@v1");
    rerender(<VersionOptionLabel versionNumber={1} label="   " />);
    expect(container.textContent).toBe("@v1");
  });

  it("renders an optional marker", () => {
    render(<VersionOptionLabel versionNumber={2} marker="group default" />);
    expect(screen.getByText(/\(group default\)/)).toBeInTheDocument();
  });

  it("falls back to '?' when the version number is null", () => {
    render(<VersionOptionLabel versionNumber={null} />);
    expect(screen.getByText(/@v\?/)).toBeInTheDocument();
  });
});
