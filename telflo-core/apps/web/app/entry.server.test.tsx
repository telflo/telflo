// @vitest-environment node
// The web server never writes a request's URL or path. React Router hands
// every server error to the entry's handleError. Captured output is
// searched for a unique marker in the request's URL (boolean canaries).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNSAFE_ErrorResponseImpl } from "react-router";
import type { EntryContext } from "react-router";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import type { Writable } from "node:stream";
import handleRequest, { handleError } from "./entry.server";

// React's renderer is replaced so a test can call the entry's callbacks as a
// render would: the shell ready, then an error while streaming.
const render = vi.hoisted(() => ({
  options: undefined as RenderToPipeableStreamOptions | undefined,
  destination: undefined as Writable | undefined,
}));
vi.mock("react-dom/server", () => ({
  renderToPipeableStream: (_element: unknown, options: RenderToPipeableStreamOptions) => {
    render.options = options;
    return {
      pipe: (destination: Writable) => {
        render.destination = destination;
        return destination;
      },
      abort: () => {},
    };
  },
}));

const marker = `url-canary-${crypto.randomUUID()}`;
const url = `http://localhost/${marker}/page?${marker}=1`;

let written: string[];

beforeEach(() => {
  written = [];
  const record = (...args: unknown[]) => {
    written.push(args.map((arg) => (arg instanceof Error ? `${arg.stack}` : String(arg))).join(" "));
  };
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(record);
  }
  const writeSpy = (chunk: unknown) => {
    record(chunk);
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(writeSpy);
  vi.spyOn(process.stderr, "write").mockImplementation(writeSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function args(request: Request) {
  return { request, params: {}, context: {} };
}

describe("handleError", () => {
  it("writes nothing for a 404 route error", () => {
    const error = new UNSAFE_ErrorResponseImpl(404, "Not Found", new Error(`No route matches URL "/${marker}/page"`), true);
    handleError(error, args(new Request(url)));
    expect(written).toHaveLength(0);
  });

  it("writes nothing for an aborted request", () => {
    const controller = new AbortController();
    const request = new Request(url, { signal: controller.signal });
    controller.abort();
    handleError(new Error("the render stopped"), args(request));
    expect(written).toHaveLength(0);
  });

  it("writes another route error's status, never its path", () => {
    const error = new UNSAFE_ErrorResponseImpl(
      405,
      "Method Not Allowed",
      new Error(`You made a POST request to "/${marker}/page" but did not provide an \`action\``),
      true,
    );
    handleError(error, args(new Request(url, { method: "POST" })));
    expect(written).toHaveLength(1);
    expect(written.join("\n").includes("405")).toBe(true);
    expect(written.join("\n").includes(marker)).toBe(false);
  });

  it("writes another error's message and stack without the request's URL or path", () => {
    const request = new Request(url);
    handleError(new Error(`the loader failed for ${url}`), args(request));
    handleError(new Error(`the loader failed for ${new URL(url).pathname}`), args(request));
    // A path's decoded form (a file name, a param) is taken out too.
    const encoded = new Request(`http://localhost/${marker}/caf%C3%A9`);
    handleError(new Error(`the loader failed for /${marker}/café`), args(encoded));
    const output = written.join("\n");
    expect(written).toHaveLength(3);
    expect(output.includes("the loader failed for")).toBe(true);
    expect(output.includes("entry.server.test.tsx")).toBe(true); // the stack
    expect(output.includes(marker)).toBe(false);
  });

  it("writes a thrown non-Error without the request's URL", () => {
    handleError(`a string naming ${url}`, args(new Request(url)));
    expect(written).toHaveLength(1);
    expect(written.join("\n").includes(marker)).toBe(false);
  });
});

describe("handleRequest", () => {
  it("answers a HEAD request with no body, as React Router's default does", async () => {
    const headers = new Headers({ "x-kept": "yes" });
    const response = (await handleRequest(
      new Request(url, { method: "HEAD" }),
      204,
      headers,
      {} as EntryContext,
      {},
    )) as Response;
    expect(response.status).toBe(204);
    expect(response.headers.get("x-kept")).toBe("yes");
    expect(await response.text()).toBe("");
  });
});

describe("a streaming render error", () => {
  it("goes through handleError, so it is written without the request's URL or path", async () => {
    const pending = handleRequest(new Request(url), 200, new Headers(), { isSpaMode: false } as EntryContext, {});
    render.options?.onShellReady?.();
    const response = (await pending) as Response;
    expect(response.status).toBe(200);
    render.options?.onError?.(new Error(`a deferred part failed for ${url}`), { componentStack: "" });
    render.destination?.end(); // the stream's end clears the entry's abort timer
    const output = written.join("\n");
    expect(written).toHaveLength(1);
    expect(output.includes("a deferred part failed for")).toBe(true);
    expect(output.includes(marker)).toBe(false);
  });
});
