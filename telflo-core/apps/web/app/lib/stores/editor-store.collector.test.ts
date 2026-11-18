import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectIsDirty, selectIsVersionPublished, useEditorStore } from "./editor-store.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { RETIRED_NOTE, RETIRED_VERSION } from "~/test/collector-distributions.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, versionFixture } from "~/test/configurations.js";

/*
 * The open version's collector version in the editor's store (D13a decision
 * 8; Preflight ruling 18): the pin on screen and the pin last loaded or
 * saved, an unsaved change while they differ, restored by everything that
 * restores the text.
 */

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

const DRAFT = versionFixture({ yamlContent: STARTER });
const PUBLISHED = versionFixture({ yamlContent: STARTER, ...PUBLISHED_FIELDS });

function open(version = DRAFT) {
  store().load({ organizationId: GROUP_ID, configuration: MINE, version });
}

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the collector version in the editor's store (D13a decision 8)", () => {
  it("has none before a load; a load takes the version's pin, on screen and saved, clean", () => {
    expect(store()).toMatchObject({ collectorVersion: null, savedCollectorVersion: null });

    open(versionFixture({ yamlContent: STARTER, collectorVersion: "0.161.0" }));

    expect(store()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a pick marks the version unsaved, and picking the saved pin back makes it clean again", () => {
    open();

    store().setCollectorVersion("0.161.0");

    expect(store()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.162.0" });
    expect(selectIsDirty(store())).toBe(true);
    // Neither the text nor the canvas changed, and no undo entry was taken.
    expect(store().text).toBe(STARTER);
    expect(store().history.past).toHaveLength(0);

    store().setCollectorVersion("0.162.0");
    expect(selectIsDirty(store())).toBe(false);
  });

  it("refuses a pick on a published version, which is read-only (D11b decision 4), and with no version open", () => {
    store().setCollectorVersion("0.161.0");
    expect(store().collectorVersion).toBeNull();

    open(PUBLISHED);
    expect(selectIsVersionPublished(store())).toBe(true);
    store().setCollectorVersion("0.161.0");

    expect(store().collectorVersion).toBe("0.162.0");
    expect(selectIsDirty(store())).toBe(false);
  });

  it("markSaved takes the answer's pin as saved: a pick during the save stays unsaved, as typing does", () => {
    open();
    store().setCollectorVersion("0.161.0");
    // The save sent 0.161.0; the person picks 0.160.0 before its answer.
    const picks = store().collectorVersionPicks;
    store().setCollectorVersion("0.160.0");

    store().markSaved(STARTER, { ...DRAFT, collectorVersion: "0.161.0", updatedAt: "2026-10-05T12:00:00.000Z" }, undefined, picks);

    expect(store()).toMatchObject({ collectorVersion: "0.160.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(store())).toBe(true);

    store().markSaved(STARTER, { ...DRAFT, collectorVersion: "0.160.0", updatedAt: "2026-10-05T12:01:00.000Z" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a pick during the save that picks the old saved pin back still counts as a pick: it stays on screen, unsaved (Ruling 37)", () => {
    open();
    store().setCollectorVersion("0.161.0");
    // The save sent 0.161.0; the person picks the old saved pin, 0.162.0, back before its answer.
    const picks = store().collectorVersionPicks;
    store().setCollectorVersion("0.162.0");

    store().markSaved(STARTER, { ...DRAFT, collectorVersion: "0.161.0", updatedAt: "2026-10-05T12:00:00.000Z" }, undefined, picks);

    expect(store()).toMatchObject({ collectorVersion: "0.162.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(store())).toBe(true);
  });

  it("an untouched picker takes the pin a save answers, a teammate's the server kept (Ruling 37)", () => {
    open(
      versionFixture({
        yamlContent: STARTER,
        collectorVersion: RETIRED_VERSION,
        collectorVersionDeprecated: true,
        collectorVersionDeprecatedNote: RETIRED_NOTE,
      }),
    );
    store().setText(`${STARTER}# typed\n`);
    const picks = store().collectorVersionPicks;

    // A teammate picked 0.162.0 and saved; this tab's text save sent no pin, and the server kept theirs.
    store().markSaved(`${STARTER}# typed\n`, { ...DRAFT, collectorVersion: "0.162.0" }, undefined, picks);

    expect(store()).toMatchObject({ collectorVersion: "0.162.0", savedCollectorVersion: "0.162.0" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("counts every pick, and a load starts the count again", () => {
    open();
    expect(store().collectorVersionPicks).toBe(0);
    store().setCollectorVersion("0.161.0");
    store().setCollectorVersion("0.162.0");
    // Picking what is on screen picks nothing.
    store().setCollectorVersion("0.162.0");
    expect(store().collectorVersionPicks).toBe(2);

    open();
    expect(store().collectorVersionPicks).toBe(0);
  });

  it("discardChanges puts back the saved pin, with the text", () => {
    open();
    store().setText(`${STARTER}# typed\n`);
    store().setCollectorVersion("0.161.0");

    store().discardChanges();

    expect(store()).toMatchObject({ text: STARTER, collectorVersion: "0.162.0" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a deprecated pin is kept until another is picked, and Discard puts it back (decision 4)", () => {
    open(
      versionFixture({
        yamlContent: STARTER,
        collectorVersion: RETIRED_VERSION,
        collectorVersionDeprecated: true,
        collectorVersionDeprecatedNote: RETIRED_NOTE,
      }),
    );
    expect(store().collectorVersion).toBe(RETIRED_VERSION);
    expect(selectIsDirty(store())).toBe(false);

    store().setCollectorVersion("0.162.0");
    expect(selectIsDirty(store())).toBe(true);

    store().discardChanges();
    expect(store().collectorVersion).toBe(RETIRED_VERSION);
    expect(selectIsDirty(store())).toBe(false);
  });

  // Clearing the canvas preserves the collector's identity, not canvas
  // content: the distribution is the configuration's, which the store never
  // changes, and the pin is the version's.
  it("clearing the canvas keeps the pin and the configuration's distribution", () => {
    open();
    store().setCollectorVersion("0.161.0");

    expect(store().clearCanvas()).toBe(true);

    expect(store().collectorVersion).toBe("0.161.0");
    expect(store().configuration?.collectorDistribution).toBe("otelcol-contrib");
    // Undoing the clear doesn't touch it either.
    expect(store().undo()).toBe(true);
    expect(store().collectorVersion).toBe("0.161.0");
  });

  it("opening another version (switching) takes that version's pin, an unsaved pick dropped with its text", () => {
    open();
    store().setCollectorVersion("0.160.0");

    open(versionFixture({ id: "0199c000-0000-7000-8000-000000000012", versionNumber: 2, collectorVersion: "0.161.0" }));

    expect(store()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("adoptCreatedVersion takes the created version's pin, clean", () => {
    open();
    store().setCollectorVersion("0.161.0");

    store().adoptCreatedVersion(
      versionFixture({ id: "0199c000-0000-7000-8000-000000000013", versionNumber: 2, collectorVersion: "0.161.0" }),
    );

    expect(store()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsDirty(store())).toBe(false);
  });
});

describe("the pin on a version published under the editor (D11b Rulings 34 and 35)", () => {
  // A teammate changed the text, picked 0.160.0, saved and published: a text
  // and a pin this tab never loaded.
  const TEAMMATE_TEXT = `${STARTER}# Ben's published change\n`;
  const TEAMMATE_PUBLISHED = {
    ...DRAFT,
    ...PUBLISHED_FIELDS,
    yamlContent: TEAMMATE_TEXT,
    collectorVersion: "0.160.0",
    updatedAt: "2026-10-04T11:30:00.000Z",
  };
  /** Dirty by the pin alone: the text and layout are the saved ones. */
  const expectDirtyByThePinOnly = () => {
    const state = store();
    expect(state.text).toBe(state.savedText);
    expect(selectIsDirty({ ...state, collectorVersion: state.savedCollectorVersion })).toBe(false);
    expect(selectIsDirty(state)).toBe(true);
  };

  it("a clean tab's re-read (no typing, no pick) shows the published text and takes the published pin, clean", () => {
    open();

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({
      text: TEAMMATE_TEXT,
      savedText: TEAMMATE_TEXT,
      collectorVersion: "0.160.0",
      savedCollectorVersion: "0.160.0",
    });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a stale tab's typed text and pick both stay on screen, dirty against the published text and pin; Undo All then puts back both (Ruling 34)", () => {
    open();
    const typed = `${STARTER}# typed before the teammate published\n`;
    store().setText(typed);
    store().setCollectorVersion("0.161.0");

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({
      text: typed,
      savedText: TEAMMATE_TEXT,
      collectorVersion: "0.161.0",
      savedCollectorVersion: "0.160.0",
      isYamlEditing: true,
    });
    expect(selectIsDirty(store())).toBe(true);

    store().undoAll();

    expect(store()).toMatchObject({ text: TEAMMATE_TEXT, collectorVersion: "0.160.0", isYamlEditing: false });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a stale tab that only picked (no typing) shows the teammate's published text with its pick, dirty by the pin alone; Discard puts back the published pin (Ruling 41)", () => {
    open();
    store().setCollectorVersion("0.161.0");

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({
      text: TEAMMATE_TEXT,
      savedText: TEAMMATE_TEXT,
      collectorVersion: "0.161.0",
      savedCollectorVersion: "0.160.0",
      isYamlEditing: false,
    });
    expectDirtyByThePinOnly();

    store().discardChanges();
    expect(store()).toMatchObject({ text: TEAMMATE_TEXT, collectorVersion: "0.160.0" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a stale tab that only picked, in a clean manual edit mode (saved there): leaves the mode for the published text, as a clean load would, its pick kept (Ruling 41)", () => {
    open();
    const typed = `${STARTER}# typed and saved\n`;
    store().setText(typed);
    store().markSaved(typed, { ...DRAFT, yamlContent: typed });
    store().setCollectorVersion("0.161.0");
    expect(store().isYamlEditing).toBe(true);

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({
      text: TEAMMATE_TEXT,
      collectorVersion: "0.161.0",
      isYamlEditing: false,
      preEditText: null,
    });
    expectDirtyByThePinOnly();
  });

  it("a stale tab's unsaved canvas move and pick both stay, dirty; Discard puts back the published text, layout and pin (Ruling 41)", () => {
    open();
    const node = store().graph.nodes.find((n) => n.type !== "pipelineGroup")!;
    store().applyNodeChanges([
      { type: "position", id: node.id, position: { x: node.position.x + 200, y: node.position.y }, dragging: false },
    ]);
    store().finishMove([node.id]);
    expect(store().text).toBe(STARTER);
    expect(selectIsDirty(store())).toBe(true);
    const { graph } = store();
    store().setCollectorVersion("0.161.0");

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({ text: STARTER, savedText: TEAMMATE_TEXT, collectorVersion: "0.161.0", savedCollectorVersion: "0.160.0" });
    expect(store().graph).toBe(graph);
    expect(selectIsDirty(store())).toBe(true);

    store().discardChanges();
    expect(store()).toMatchObject({ text: TEAMMATE_TEXT, collectorVersion: "0.160.0" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a stale tab's typed text with an untouched picker: the picker takes the teammate's published pin, the text stays, dirty; Undo All puts back the published text (Rulings 35 and 37)", () => {
    open();
    const typed = `${STARTER}# typed before the teammate published\n`;
    store().setText(typed);

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({ text: typed, savedText: TEAMMATE_TEXT, collectorVersion: "0.160.0", savedCollectorVersion: "0.160.0" });
    expect(selectIsDirty(store())).toBe(true);

    store().undoAll();

    expect(store()).toMatchObject({ text: TEAMMATE_TEXT, collectorVersion: "0.160.0", isYamlEditing: false });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a stale tab's untouched picker with the very text the teammate published: shown as published, clean", () => {
    open();
    store().setText(TEAMMATE_TEXT);

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({ text: TEAMMATE_TEXT, collectorVersion: "0.160.0", isYamlEditing: false });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("a stale pick that is the published pin anyway: shown as published, clean", () => {
    open();
    store().setCollectorVersion("0.160.0");

    store().replaceVersion(TEAMMATE_PUBLISHED);

    expect(store()).toMatchObject({ text: TEAMMATE_TEXT, collectorVersion: "0.160.0", savedCollectorVersion: "0.160.0" });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("this tab's own publish (replaceVersionSummary) keeps the saved pin it published, clean", () => {
    open();
    store().setCollectorVersion("0.161.0");
    store().markSaved(STARTER, { ...DRAFT, collectorVersion: "0.161.0" });

    store().replaceVersionSummary({ ...DRAFT, ...PUBLISHED_FIELDS, collectorVersion: "0.161.0" });

    expect(store()).toMatchObject({ collectorVersion: "0.161.0", savedCollectorVersion: "0.161.0" });
    expect(selectIsVersionPublished(store())).toBe(true);
    expect(selectIsDirty(store())).toBe(false);
  });
});
