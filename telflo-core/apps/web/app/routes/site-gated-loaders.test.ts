import { afterEach, describe, expect, it, vi } from "vitest";
import { loader as playgroundLoader } from "./playground.js";
import { loader as playgroundEditorLoader } from "./playground.editor.js";
import { loader as publicEditorLoader } from "./public-editor.js";

/*
 * The pages a site switch turns off answer 404 from their server loader
 * (D36-1 decision 31, Preflight ruling 6): the playground's layout (for every
 * page under it), its full-screen editor and the public editor, each behind
 * TELFLO_PLAYGROUND, read at request time. The tests' setup pins the SaaS's
 * values (the playground on); each case here sets its own. Root's boundary
 * shows the 404 (SSR and client navigation: site-switches.e2e.ts).
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/** What `loader` threw, or "returned" when it didn't. */
function thrownBy(loader: () => unknown): unknown {
  try {
    loader();
  } catch (caught) {
    return caught;
  }
  return "returned";
}

const GATED = [
  ["/playground and every page under it", playgroundLoader],
  ["/playground/editor", playgroundEditorLoader],
  ["/public-editor", publicEditorLoader],
] as const;

describe.each(GATED)("%s", (_page, loader) => {
  it("is a 404 with the playground off, the open source's default", () => {
    vi.stubEnv("TELFLO_PLAYGROUND", "");
    const thrown = thrownBy(loader);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it('is a 404 with TELFLO_PLAYGROUND "false" too', () => {
    vi.stubEnv("TELFLO_PLAYGROUND", "false");
    expect((thrownBy(loader) as Response).status).toBe(404);
  });

  it("renders with the playground on (and the anonymous reads it needs)", () => {
    vi.stubEnv("TELFLO_PLAYGROUND", "true");
    vi.stubEnv("TELFLO_ANONYMOUS_VALIDATE", "true");
    vi.stubEnv("TELFLO_PUBLIC_FLOWS", "true");
    expect(thrownBy(loader)).toBe("returned");
    expect(loader()).toBeNull();
  });
});
