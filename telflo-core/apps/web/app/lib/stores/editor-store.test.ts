import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useHeldEdit } from "~/lib/editor/held-edits.js";
import { DEFAULT_PANEL_WIDTH, selectIsDirty, summaryOf, useEditorStore } from "./editor-store.js";
import { COLLEAGUE_EMAIL, COLLEAGUE_ID, GROUP_ID, MINE, versionFixture, versionSummaryOf } from "~/test/configurations.js";

const SAVED = "receivers:\n  otlp:\n";

const VERSION = versionFixture({ yamlContent: SAVED });

const initialState = useEditorStore.getState();

function isDirty(): boolean {
  return selectIsDirty(useEditorStore.getState());
}

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  window.localStorage.clear();
});

describe("useEditorStore", () => {
  it("starts with nothing loaded, the panel at 400 px, and the editor's defaults", () => {
    const state = useEditorStore.getState();

    expect(state).toMatchObject({
      configuration: null,
      version: null,
      organizationId: null,
      text: "",
      savedText: "",
      isSaving: false,
      loadCount: 0,
      activeTab: null,
      panelCollapsed: false,
      panelWidth: 400,
    });
    expect(DEFAULT_PANEL_WIDTH).toBe(400);
    // The editor's preferences are the person's, in the user store: none here.
    expect(state).not.toHaveProperty("editorOptions");
    expect(isDirty()).toBe(false);
  });

  it("load sets the configuration, the version, the organization it was loaded in, and both texts", () => {
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });

    const state = useEditorStore.getState();
    expect(state.configuration).toEqual(MINE);
    expect(state.version).toEqual(VERSION);
    expect(state.organizationId).toBe(GROUP_ID);
    expect(state.text).toBe(SAVED);
    expect(state.savedText).toBe(SAVED);
    expect(isDirty()).toBe(false);
  });

  it("typing makes it dirty, and typing back to the saved text makes it clean", () => {
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });

    useEditorStore.getState().setText(`${SAVED}exporters:\n`);
    expect(isDirty()).toBe(true);

    useEditorStore.getState().setText(SAVED);
    expect(isDirty()).toBe(false);
  });

  it("a trailing space or a changed line ending is a change", () => {
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });

    useEditorStore.getState().setText(`${SAVED} `);
    expect(isDirty()).toBe(true);
    useEditorStore.getState().setText(SAVED.replaceAll("\n", "\r\n"));
    expect(isDirty()).toBe(true);
  });

  it("markSaved with the text that was sent leaves it clean when nothing was typed meanwhile", () => {
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    const sent = `${SAVED}exporters:\n`;
    useEditorStore.getState().setText(sent);

    const saved = { ...VERSION, yamlContent: sent, updatedAt: "2026-09-28T12:00:00.000Z" };
    useEditorStore.getState().markSaved(sent, saved);

    expect(useEditorStore.getState().savedText).toBe(sent);
    expect(useEditorStore.getState().version).toEqual(saved);
    expect(isDirty()).toBe(false);
  });

  it("markSaved with the sent text leaves it dirty when the text changed during the save", () => {
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    const sent = `${SAVED}exporters:\n`;
    useEditorStore.getState().setText(sent);
    useEditorStore.getState().setSaving(true);
    useEditorStore.getState().setText(`${sent}  debug:\n`);

    useEditorStore.getState().markSaved(sent, { ...VERSION, yamlContent: sent });
    useEditorStore.getState().setSaving(false);

    expect(useEditorStore.getState().savedText).toBe(sent);
    expect(useEditorStore.getState().text).toBe(`${sent}  debug:\n`);
    expect(isDirty()).toBe(true);
  });

  it("setSaving marks a save under way and over", () => {
    useEditorStore.getState().setSaving(true);
    expect(useEditorStore.getState().isSaving).toBe(true);
    useEditorStore.getState().setSaving(false);
    expect(useEditorStore.getState().isSaving).toBe(false);
  });

  it("renameConfiguration renames the loaded configuration, and does nothing with none loaded", () => {
    useEditorStore.getState().renameConfiguration("Nothing to rename");
    expect(useEditorStore.getState().configuration).toBeNull();

    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    useEditorStore.getState().renameConfiguration("Renamed");

    expect(useEditorStore.getState().configuration).toEqual({ ...MINE, name: "Renamed" });
  });

  it("counts every load, and reset keeps the count, so a load after leaving is never the one before", () => {
    const load = () => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });

    load();
    expect(useEditorStore.getState().loadCount).toBe(1);
    useEditorStore.getState().reset();
    expect(useEditorStore.getState().loadCount).toBe(1);
    load();
    expect(useEditorStore.getState().loadCount).toBe(2);
  });

  it("sets the active tab and the panel's collapse and width", () => {
    useEditorStore.getState().setActiveTab("yaml");
    useEditorStore.getState().setPanelCollapsed(true);
    useEditorStore.getState().setPanelWidth(480);

    expect(useEditorStore.getState()).toMatchObject({ activeTab: "yaml", panelCollapsed: true, panelWidth: 480 });
  });

  it("writes every held edit before the active tab changes, whoever changes it; naming the tab already named writes nothing", () => {
    const flushes: (string | null)[] = [];
    const { unmount } = renderHook(() => useHeldEdit(true, () => flushes.push(useEditorStore.getState().activeTab)));

    useEditorStore.getState().setActiveTab("yaml");
    expect(flushes).toEqual([null]);
    expect(useEditorStore.getState().activeTab).toBe("yaml");

    useEditorStore.getState().setActiveTab("yaml");
    expect(flushes).toEqual([null]);

    useEditorStore.getState().setActiveTab("config");
    expect(flushes).toEqual([null, "yaml"]);
    expect(useEditorStore.getState().activeTab).toBe("config");
    unmount();
  });

  it("reset forgets the configuration and its text, even while dirty or saving, and keeps the layout", () => {
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    useEditorStore.getState().setText("changed");
    useEditorStore.getState().setSaving(true);
    useEditorStore.getState().setActiveTab("yaml");
    useEditorStore.getState().setPanelCollapsed(true);
    useEditorStore.getState().setPanelWidth(480);

    useEditorStore.getState().reset();

    expect(useEditorStore.getState()).toMatchObject({
      configuration: null,
      version: null,
      organizationId: null,
      text: "",
      savedText: "",
      isSaving: false,
      activeTab: "yaml",
      panelCollapsed: true,
      panelWidth: 480,
    });
    expect(isDirty()).toBe(false);
  });

  describe("versions", () => {
    const VERSION_2 = versionFixture({
      id: "0199c000-0000-7000-8000-000000000012",
      versionNumber: 2,
      label: "Add tail sampling",
      createdBy: { userId: COLLEAGUE_ID, email: COLLEAGUE_EMAIL },
      yamlContent: "exporters:\n  debug: {}\n",
      updatedAt: "2026-05-01T12:00:00.000Z",
    });
    const VERSION_3 = versionFixture({
      id: "0199c000-0000-7000-8000-000000000013",
      versionNumber: 3,
      yamlContent: `${SAVED}# created\n`,
      createdAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-09-30T12:00:00.000Z",
    });
    const LISTED = [versionSummaryOf(VERSION_2), versionSummaryOf(VERSION)];

    it("summaryOf is the version without its content", () => {
      expect(summaryOf(VERSION_2)).toEqual({
        id: VERSION_2.id,
        versionNumber: 2,
        label: "Add tail sampling",
        createdBy: { userId: COLLEAGUE_ID, email: COLLEAGUE_EMAIL },
        createdAt: VERSION_2.createdAt,
        updatedAt: VERSION_2.updatedAt,
        publishedAt: null,
        publishedBy: null,
        collectorVersion: VERSION_2.collectorVersion,
        collectorVersionDeprecated: false,
        collectorVersionDeprecatedNote: null,
      });
    });

    it("summaryOf copies the collector version and whether the catalogue deprecated it, with its note", () => {
      const deprecated = {
        ...VERSION_2,
        collectorVersion: "0.155.0",
        collectorVersionDeprecated: true,
        collectorVersionDeprecatedNote: "Retired: upgrade to 0.162.0.",
      };
      expect(summaryOf(deprecated)).toMatchObject({
        collectorVersion: "0.155.0",
        collectorVersionDeprecated: true,
        collectorVersionDeprecatedNote: "Retired: upgrade to 0.162.0.",
      });
    });

    it("summaryOf copies a published version's time and publisher", () => {
      const published = {
        ...VERSION_2,
        publishedAt: "2026-04-21T12:00:00.000Z",
        publishedBy: { userId: COLLEAGUE_ID, email: COLLEAGUE_EMAIL },
      };
      expect(summaryOf(published)).toMatchObject({
        publishedAt: "2026-04-21T12:00:00.000Z",
        publishedBy: { userId: COLLEAGUE_ID, email: COLLEAGUE_EMAIL },
      });
    });

    it("load keeps the versions it is given, or the version's own summary alone; reset forgets them", () => {
      expect(useEditorStore.getState().versions).toEqual([]);

      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION, versions: LISTED });
      expect(useEditorStore.getState().versions).toEqual(LISTED);

      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
      expect(useEditorStore.getState().versions).toEqual([versionSummaryOf(VERSION)]);

      useEditorStore.getState().reset();
      expect(useEditorStore.getState().versions).toEqual([]);
    });

    it("adoptCreatedVersion opens the created version clean, in the same configuration and organization, history cleared, its summary first", () => {
      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION, versions: LISTED });
      useEditorStore.getState().setPanelWidth(480);
      useEditorStore.getState().setActiveTab("yaml");
      // A change on the canvas (an undo entry), then typing (manual edit mode): the source is dirty.
      expect(useEditorStore.getState().addPipeline("logs/extra")).not.toBeNull();
      useEditorStore.getState().setText(VERSION_3.yamlContent);
      useEditorStore.getState().setSaving(true);
      const before = useEditorStore.getState();
      expect(before.history.past.length).toBeGreaterThan(0);
      expect(before.isYamlEditing).toBe(true);
      expect(isDirty()).toBe(true);

      useEditorStore.getState().adoptCreatedVersion(VERSION_3);

      const state = useEditorStore.getState();
      expect(state.configuration).toBe(before.configuration);
      expect(state.organizationId).toBe(GROUP_ID);
      expect(state.version).toEqual(VERSION_3);
      expect(state.versions).toEqual([versionSummaryOf(VERSION_3), ...LISTED]);
      expect(state.text).toBe(VERSION_3.yamlContent);
      expect(state.savedText).toBe(VERSION_3.yamlContent);
      expect(isDirty()).toBe(false);
      expect(state.history).toEqual({ past: [], future: [] });
      expect(state.isYamlEditing).toBe(false);
      expect(state.selectedNode).toBeNull();
      // A late answer of the save under way is the source's: the load count moved on.
      expect(state.isSaving).toBe(false);
      expect(state.loadCount).toBe(before.loadCount + 1);
      expect(state.canvasKey).toBe(before.canvasKey + 1);
      expect(state).toMatchObject({ activeTab: "yaml", panelWidth: 480 });
    });

    it("adoptCreatedVersion lists the created version once, and does nothing with no configuration open", () => {
      useEditorStore.getState().adoptCreatedVersion(VERSION_3);
      expect(useEditorStore.getState().version).toBeNull();
      expect(useEditorStore.getState().loadCount).toBe(0);

      useEditorStore.getState().load({
        organizationId: GROUP_ID,
        configuration: MINE,
        version: VERSION,
        versions: [versionSummaryOf(VERSION_3), ...LISTED],
      });
      useEditorStore.getState().adoptCreatedVersion(VERSION_3);
      expect(useEditorStore.getState().versions).toEqual([versionSummaryOf(VERSION_3), ...LISTED]);
    });

    it("setVersionLabel renames the open version and its summary", () => {
      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION, versions: LISTED });

      useEditorStore.getState().setVersionLabel(VERSION.id, "Baseline");

      const state = useEditorStore.getState();
      expect(state.version).toEqual({ ...VERSION, label: "Baseline" });
      expect(state.versions).toEqual([versionSummaryOf(VERSION_2), { ...versionSummaryOf(VERSION), label: "Baseline" }]);
      expect(isDirty()).toBe(false);
    });

    it("setVersionLabel renames another version's summary alone", () => {
      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION, versions: LISTED });
      const open = useEditorStore.getState().version;

      useEditorStore.getState().setVersionLabel(VERSION_2.id, "Renamed");

      const state = useEditorStore.getState();
      expect(state.version).toBe(open);
      expect(state.versions).toEqual([{ ...versionSummaryOf(VERSION_2), label: "Renamed" }, versionSummaryOf(VERSION)]);
    });

    it("markSaved gives the open version's summary the save's time, and leaves the others", () => {
      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION, versions: LISTED });
      const sent = `${SAVED}exporters:\n`;
      useEditorStore.getState().setText(sent);

      useEditorStore.getState().markSaved(sent, { ...VERSION, yamlContent: sent, updatedAt: "2026-09-28T12:00:00.000Z" });

      expect(useEditorStore.getState().versions).toEqual([
        versionSummaryOf(VERSION_2),
        { ...versionSummaryOf(VERSION), updatedAt: "2026-09-28T12:00:00.000Z" },
      ]);
    });

    it("markSaved keeps the open version's label: a rename answered before an older save's answer stays", () => {
      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION, versions: LISTED });
      const sent = `${SAVED}exporters:\n`;
      useEditorStore.getState().setText(sent);
      // The save read the version unnamed; the rename's answer arrives first.
      useEditorStore.getState().setVersionLabel(VERSION.id, "Baseline");

      useEditorStore
        .getState()
        .markSaved(sent, { ...VERSION, label: null, yamlContent: sent, updatedAt: "2026-09-28T12:00:00.000Z" });

      const state = useEditorStore.getState();
      expect(state.version).toEqual({ ...VERSION, label: "Baseline", yamlContent: sent, updatedAt: "2026-09-28T12:00:00.000Z" });
      expect(state.versions).toEqual([
        versionSummaryOf(VERSION_2),
        { ...versionSummaryOf(VERSION), label: "Baseline", updatedAt: "2026-09-28T12:00:00.000Z" },
      ]);
      expect(isDirty()).toBe(false);
    });
  });

  it("does not persist anything", () => {
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    useEditorStore.getState().setText("changed");
    useEditorStore.getState().setPanelCollapsed(true);

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(useEditorStore).not.toHaveProperty("persist");
  });
});
