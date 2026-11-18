import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { browserCommand, openBrowser } from "./browser.js";

/*
 * Opening the browser (D27 decision 20): the URL one
 * argument on macOS and Linux, quoted and verbatim for cmd.exe on Windows.
 * Nothing is ever started: `spawn` is a stand-in.
 */

const URL = "https://telflo.example/cli-auth#state=abc&port=54321&host=ada-laptop";

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("browserCommand", () => {
  it("passes the URL as one unchanged argument on macOS and Linux", () => {
    expect(browserCommand(URL, "darwin")).toEqual({ command: "open", args: [URL], options: { detached: true, stdio: "ignore" } });
    expect(browserCommand(URL, "linux")).toEqual({ command: "xdg-open", args: [URL], options: { detached: true, stdio: "ignore" } });
  });

  it("quotes the URL for cmd.exe so & doesn't split the command, after start's empty title", () => {
    const built = browserCommand(URL, "win32");
    expect(built.command).toBe("cmd");
    expect(built.args).toEqual(["/c", "start", '""', `"${URL}"`]);
    expect(built.options.windowsVerbatimArguments).toBe(true);
  });

  it("percent-encodes a double quote before quoting for cmd.exe", () => {
    expect(browserCommand('https://x.example/#a="&b=c', "win32").args[3]).toBe('"https://x.example/#a=%22&b=c"');
  });
});

describe("openBrowser", () => {
  it("starts the opener detached, ignores its failure to run, and doesn't wait for it", () => {
    const child = { on: vi.fn().mockReturnThis(), unref: vi.fn().mockReturnThis() };
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    expect(openBrowser(URL, "linux")).toBe(true);
    expect(spawn).toHaveBeenCalledWith("xdg-open", [URL], { detached: true, stdio: "ignore" });
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    const onError = child.on.mock.calls[0]?.[1] as () => void;
    expect(() => onError()).not.toThrow();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("answers false when the opener can't be started", () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    expect(openBrowser(URL, "darwin")).toBe(false);
  });

  it("uses this machine's platform by default", () => {
    const child = { on: vi.fn().mockReturnThis(), unref: vi.fn().mockReturnThis() };
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    openBrowser(URL);
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe(browserCommand(URL, process.platform).command);
  });
});
