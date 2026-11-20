import { afterEach, describe, expect, it, vi } from "vitest";
import { createStaticHandler } from "react-router";
import routes from "../routes.js";
import { loader as docsLoader } from "./docs.js";
import { loader as robotsLoader } from "./robots[.]txt.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A route's path as routes.ts configures it, so the tests request what the app serves. */
function pathOf(file: string): string {
  const path = routes.find((route) => route.file === file)?.path;
  if (path === undefined) throw new Error(`routes.ts has no route for ${file}`);
  return path;
}

/** Answers `url` as the app's route config would, with just this one route. */
async function request(file: string, loader: () => Response, url: string): Promise<Response> {
  const handler = createStaticHandler([{ path: pathOf(file), loader }]);
  const response = await handler.queryRoute(new Request(url));
  if (!(response instanceof Response)) throw new Error("the loader didn't answer with a Response");
  return response;
}

describe("/robots.txt", () => {
  it("disallows every path and names no sitemap, whatever the public URL", async () => {
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", "https://telflo.example/");
    const response = await request("routes/robots[.]txt.tsx", robotsLoader, "http://web.example/robots.txt");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("is the same without the public URL", async () => {
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", "");
    const response = await request("routes/robots[.]txt.tsx", robotsLoader, "http://web.example/robots.txt");

    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("is plain text", async () => {
    const response = await request("routes/robots[.]txt.tsx", robotsLoader, "http://web.example/robots.txt");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});

describe("/docs", () => {
  it.each(["/docs", "/docs/anything", "/docs/deeply/nested/page"])(
    "%s answers 301 to the docs home, docs.telflo.com by default (the tests' setup)",
    async (path) => {
      const response = await request("routes/docs.tsx", docsLoader, `http://web.example${path}`);

      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("https://docs.telflo.com/");
    },
  );

  it("follows TELFLO_DOCS_URL", async () => {
    vi.stubEnv("TELFLO_DOCS_URL", "https://docs.example.org/telflo/");
    const response = await request("routes/docs.tsx", docsLoader, "http://web.example/docs/anything");

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://docs.example.org/telflo/");
  });

  it("is a 404 with TELFLO_DOCS_URL empty (no docs links)", () => {
    vi.stubEnv("TELFLO_DOCS_URL", "");
    const thrown = (() => {
      try {
        docsLoader();
      } catch (caught) {
        return caught;
      }
      throw new Error("the loader returned instead of throwing");
    })();

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });
});
