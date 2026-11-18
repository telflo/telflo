import { describe, expect, it } from "vitest";
import { decidePushAction, latestVersion } from "./push.js";

/* config push's choice (D27 decision 26). */

describe("decidePushAction", () => {
  it("patches a draft latest in place", () => {
    expect(
      decidePushAction([
        { versionNumber: 3, status: "draft" },
        { versionNumber: 2, status: "published" },
      ]),
    ).toEqual({ kind: "patch-draft", versionNumber: 3 });
  });

  it("appends after a published latest, and when there are no versions", () => {
    expect(decidePushAction([{ versionNumber: 2, status: "published" }])).toEqual({ kind: "append" });
    expect(decidePushAction([])).toEqual({ kind: "append" });
  });

  it("goes by the highest number, whatever the order", () => {
    expect(
      decidePushAction([
        { versionNumber: 2, status: "draft" },
        { versionNumber: 3, status: "published" },
      ]),
    ).toEqual({ kind: "append" });
    expect(latestVersion([{ versionNumber: 1, status: "published" }, { versionNumber: 4, status: "draft" }])?.versionNumber).toBe(4);
    expect(latestVersion([])).toBeUndefined();
  });
});
