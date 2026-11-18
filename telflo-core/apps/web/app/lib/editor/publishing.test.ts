import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rereadVersion } from "./publishing.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { selectIsDirty, selectIsVersionPublished, useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, answerFor, versionFixture } from "~/test/configurations.js";

/*
 * The re-read after a 409 `configuration_version_published` (Ruling 35): the
 * version a teammate published, whole, so its published content becomes the
 * saved baseline, never only its summary over this tab's older text.
 */

const MINE_TEXT = "receivers:\n  otlp: {}\n";
const TEAMMATE_TEXT = "receivers:\n  otlp: {}\nprocessors:\n  batch: {}\n";
const VERSION = versionFixture({ yamlContent: MINE_TEXT });
const TEAMMATE_PUBLISHED = { ...VERSION, ...PUBLISHED_FIELDS, yamlContent: TEAMMATE_TEXT, updatedAt: "2026-10-04T13:00:00.000Z" };

const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  store().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rereadVersion (Ruling 35)", () => {
  it("takes the content the teammate published, not just its summary: the saved text and the screen are what was published", async () => {
    const read = vi
      .spyOn(apiClient, "getConfigurationVersion")
      .mockResolvedValue(answerFor({ ...MINE, published: true }, TEAMMATE_PUBLISHED));

    await rereadVersion(GROUP_ID, MINE.id, VERSION.id, () => true);

    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id);
    expect(selectIsVersionPublished(store())).toBe(true);
    expect(store()).toMatchObject({ savedText: TEAMMATE_TEXT, text: TEAMMATE_TEXT, version: TEAMMATE_PUBLISHED });
    expect(selectIsDirty(store())).toBe(false);
  });

  it("changes nothing when the answer comes for a version no longer open", async () => {
    vi.spyOn(apiClient, "getConfigurationVersion").mockResolvedValue(answerFor(MINE, TEAMMATE_PUBLISHED));
    const before = store();

    await rereadVersion(GROUP_ID, MINE.id, VERSION.id, () => false);

    expect(store()).toBe(before);
  });

  it("changes nothing when the read fails", async () => {
    vi.spyOn(apiClient, "getConfigurationVersion").mockRejectedValue(new ApiError("internal_error", "Something went wrong"));
    const before = store();

    await rereadVersion(GROUP_ID, MINE.id, VERSION.id, () => true);

    expect(store()).toBe(before);
  });
});
