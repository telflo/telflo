// @vitest-environment node

/**
 * A server render of the YAML tab never imports Monaco. Here monaco-editor
 * and monaco-yaml can't be imported at all: a static import of either,
 * anywhere below YamlEditor, fails this file as it loads.
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("monaco-editor", () => {
  throw new Error("monaco-editor imported on the server");
});
vi.mock("monaco-yaml", () => {
  throw new Error("monaco-yaml imported on the server");
});

import { YamlEditor } from "./YamlEditor.js";
import { initMonaco, setMonacoSchema } from "~/lib/editor/monaco-setup.js";

describe("YamlEditor on the server", () => {
  it("renders Loading editor…, and no editor", () => {
    expect(typeof window).toBe("undefined");

    const html = renderToString(<YamlEditor onSave={() => {}} />);

    expect(html).toContain("Loading editor…");
    expect(html).toContain("Copy YAML to clipboard");
    expect(html).not.toContain("monaco");
  });

  it("initMonaco returns at once, importing nothing", async () => {
    await expect(initMonaco()).resolves.toBeUndefined();
  });

  it("setMonacoSchema does nothing: no schema is fetched, then or when initMonaco is called", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetched on the server"));

    setMonacoSchema("/schemas/otelcol-contrib/v0.162.0.json");
    await expect(initMonaco()).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
