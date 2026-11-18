import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-error.js";
import {
  emit,
  endingOf,
  EXIT,
  ExitError,
  getIo,
  guardOutputStreams,
  isJsonMode,
  printTable,
  READ_ONLY_TOKEN_MESSAGE,
  reportError,
  setIo,
  setJsonMode,
  terminalText,
  UNEXPECTED_FAILURE_MESSAGE,
  withoutTokens,
  WRITE_FAILED_MESSAGE,
  writeErr,
  writeNote,
  writeOut,
} from "./output.js";

/* Exit codes, --json, fixed words (D27 decision 18). */

let out: string;
let err: string;

beforeEach(() => {
  out = "";
  err = "";
  setIo({ stdout: (text) => void (out += text), stderr: (text) => void (err += text) });
});

afterEach(() => {
  setIo();
  setJsonMode(false);
});

describe("exit codes", () => {
  it("are 0 to 4, as the older CLI's", () => {
    expect(EXIT).toEqual({ OK: 0, API: 1, USAGE: 2, AUTH: 3, FAILED: 4 });
  });
});

describe("emit, writeOut and writeErr", () => {
  it("prints the human rendering, or one JSON document with --json", () => {
    emit({ a: 1 }, () => "human");
    expect(out).toBe("human\n");
    setJsonMode(true);
    expect(isJsonMode()).toBe(true);
    emit({ a: 1 }, () => "human");
    expect(out).toBe(`human\n${JSON.stringify({ a: 1 }, null, 2)}\n`);
  });

  it("writes a note as its line, or with --json one JSON object a line, a token in it redacted (Ruling 249)", () => {
    writeNote("Rate limited: retrying in 2 s.");
    expect(err).toBe("Rate limited: retrying in 2 s.\n");
    err = "";
    setJsonMode(true);
    const token = `tf_${randomBytes(32).toString("base64url")}`;
    writeNote("first");
    writeNote(`second \u001b quoting ${token}`);
    expect(err.includes(token)).toBe(false);
    expect(err.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as unknown)).toEqual([
      { note: "first" },
      { note: "second \u001b quoting tf_…" },
    ]);
  });

  it("ends every block with one newline", () => {
    writeOut("a\n");
    writeErr("b");
    expect(out).toBe("a\n");
    expect(err).toBe("b\n");
  });

  it("uses the process's streams by default", () => {
    setIo();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const writeError = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeOut("to stdout");
      writeErr("to stderr");
      expect(write).toHaveBeenCalledWith("to stdout\n");
      expect(writeError).toHaveBeenCalledWith("to stderr\n");
      expect(getIo().stdin).toBe(process.stdin);
    } finally {
      write.mockRestore();
      writeError.mockRestore();
    }
  });
});

describe("printTable", () => {
  it("pads columns to their widest cell, blank for null and undefined", () => {
    const table = printTable(
      [
        { id: "a", name: "first", n: 1 },
        { id: "bbb", name: null, n: undefined },
      ],
      ["id", "name", "n"],
    );
    expect(table).toBe(["id   name   n", "---  -----  -", "a    first  1", "bbb"].join("\n"));
  });

  it("strips control characters from every cell (Ruling 237)", () => {
    const table = printTable([{ name: "evil\u001b]0;title\u0007\u001b[31mred\u009b2J" }], ["name"]);
    expect(table).toBe(["name", "---------------------", "evil]0;title[31mred2J"].join("\n"));
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(table.replaceAll("\n", ""))).toBe(false);
  });

  it("prints the header alone for no rows", () => {
    expect(printTable([], ["id"])).toBe("id\n--");
  });
});

describe("terminalText (Ruling 237)", () => {
  it("removes C0, DEL and C1 controls: ESC, BEL, an OSC, CSI", () => {
    expect(terminalText("a\u001b]8;;https://x\u0007link\u001b]8;;\u0007\u007f\u0085\u009bz\n\tb")).toBe("a]8;;https://xlink]8;;zb");
    expect(terminalText("Ada's workspace")).toBe("Ada's workspace");
  });
});

describe("endingOf (decision 18)", () => {
  it("keeps an ExitError's words and code", () => {
    expect(endingOf(new ExitError("usage words", EXIT.USAGE))).toEqual({ message: "usage words", exitCode: 2, code: "usage_error", status: null });
    expect(endingOf(new ExitError("x", EXIT.FAILED, "invalid"))).toMatchObject({ exitCode: 4, code: "invalid" });
  });

  it("keeps the HTTP status of a refusal an ExitError rewords, for --json (Ruling 239)", () => {
    expect(endingOf(new ExitError("reworded", EXIT.USAGE, "collector_version_unknown", 400))).toEqual({
      message: "reworded",
      exitCode: 2,
      code: "collector_version_unknown",
      status: 400,
    });
  });

  it("ends a 401's words with a full stop only when they have none", () => {
    expect(endingOf(new ApiError(401, "x", "Expired.")).message).toBe("Expired. Run telflo login.");
  });

  it("exits 3 for 401, adding run telflo login", () => {
    expect(endingOf(new ApiError(401, "invalid_api_token", "Missing or invalid API token"))).toEqual({
      message: "Missing or invalid API token. Run telflo login.",
      exitCode: 3,
      code: "invalid_api_token",
      status: 401,
    });
  });

  it("exits 3 for 403, saying a read token is read-only", () => {
    expect(endingOf(new ApiError(403, "insufficient_access", "This token can't make changes."))).toMatchObject({
      message: READ_ONLY_TOKEN_MESSAGE,
      exitCode: 3,
    });
    expect(endingOf(new ApiError(403, "organization_access_denied", "No access."))).toMatchObject({ message: "No access.", exitCode: 3 });
  });

  it("exits 1 for every other API error", () => {
    expect(endingOf(new ApiError(409, "configuration_version_changed", "Changed."))).toEqual({
      message: "Changed.",
      exitCode: 1,
      code: "configuration_version_changed",
      status: 409,
    });
    expect(endingOf(new ApiError(502, null, "The server couldn't be reached (502)."))).toMatchObject({ code: "api_error", exitCode: 1 });
  });

  it("never shows another error's own message", () => {
    const token = `tf_${randomBytes(32).toString("base64url")}`;
    const ending = endingOf(new Error(`boom ${token}`));
    expect(ending).toEqual({ message: UNEXPECTED_FAILURE_MESSAGE, exitCode: 1, code: "api_error", status: null });
    expect(ending.message.includes(token)).toBe(false);
    expect(endingOf("a thrown string").message).toBe(UNEXPECTED_FAILURE_MESSAGE);
  });
});

describe("reportError", () => {
  it("writes error: <words> to stderr and answers the exit code", () => {
    expect(reportError(new ExitError("Not logged in.", EXIT.AUTH))).toBe(3);
    expect(err).toBe("error: Not logged in.\n");
    expect(out).toBe("");
  });

  it("writes { error: { code, message, status } } to stderr with --json", () => {
    setJsonMode(true);
    expect(reportError(new ApiError(404, "configuration_not_found", "Not found."))).toBe(1);
    expect(JSON.parse(err)).toEqual({ error: { code: "configuration_not_found", message: "Not found.", status: 404 } });
    expect(out).toBe("");
  });
});

describe("reportError's redaction (Ruling 237)", () => {
  const token = `tf_${randomBytes(32).toString("base64url")}`;

  it("redacts a token an envelope quotes, and an origin typed from one, in plain output", () => {
    reportError(new ApiError(400, "bad", `Refused Bearer ${token}`));
    reportError(new ExitError(`Couldn't reach https://${token.toLowerCase()}.invalid.`, EXIT.API));
    expect(err.includes(token) || err.toLowerCase().includes(token.toLowerCase())).toBe(false);
    expect(err).toBe("error: Refused Bearer tf_…\nerror: Couldn't reach https://tf_….invalid.\n");
  });

  it("redacts it in --json output too, code and message", () => {
    setJsonMode(true);
    reportError(new ApiError(400, `code_${token}`, `Refused Bearer ${token}`));
    expect(err.includes(token)).toBe(false);
    expect(JSON.parse(err)).toEqual({ error: { code: "code_tf_…", message: "Refused Bearer tf_…", status: 400 } });
  });

  it("strips control characters from the human line but keeps its newlines", () => {
    reportError(new ExitError("one\u001b[2J\ntwo\u0007", EXIT.FAILED));
    expect(err).toBe("error: one[2J\ntwo\n");
  });
});

describe("withoutTokens", () => {
  it("replaces every tf_ token in a text it didn't write", () => {
    const token = `tf_${randomBytes(32).toString("base64url")}`;
    const text = withoutTokens(`error: unknown command '${token}' and ${token}`);
    expect(text.includes(token)).toBe(false);
    expect(text).toBe("error: unknown command 'tf_…' and tf_…");
  });
});

describe("guardOutputStreams (Ruling 247)", () => {
  class FakeStream extends EventEmitter {
    written: string[] = [];
    writable = true;
    write(text: string): boolean {
      this.written.push(text);
      return true;
    }
  }

  function errorOf(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`write ${code} with /some/path`), { code });
  }

  it("ends quietly with exit 0 when stdout's pipe closes (EPIPE), once", () => {
    const stdout = new FakeStream();
    const stderr = new FakeStream();
    const exit = vi.fn();
    guardOutputStreams({ stdout, stderr }, exit);
    stdout.emit("error", errorOf("EPIPE"));
    stdout.emit("error", errorOf("EPIPE"));
    expect(exit.mock.calls).toEqual([[0]]);
    expect(stderr.written).toEqual([]);
  });

  it("prints fixed words and exits 1 for another stdout error, never the error's text", () => {
    const stdout = new FakeStream();
    const stderr = new FakeStream();
    const exit = vi.fn();
    guardOutputStreams({ stdout, stderr }, exit);
    stdout.emit("error", errorOf("EIO"));
    expect(exit.mock.calls).toEqual([[1]]);
    expect(stderr.written).toEqual([`${WRITE_FAILED_MESSAGE}\n`]);
  });

  it("exits without writing when stderr is the stream that failed, or isn't writable", () => {
    const stdout = new FakeStream();
    const stderr = new FakeStream();
    const exit = vi.fn();
    guardOutputStreams({ stdout, stderr }, exit);
    stderr.emit("error", errorOf("EPIPE"));
    expect(exit.mock.calls).toEqual([[0]]);

    const closed = new FakeStream();
    closed.writable = false;
    const other = vi.fn();
    guardOutputStreams({ stdout: new FakeStream(), stderr: closed }, other);
    closed.emit("error", errorOf("EIO"));
    expect(other.mock.calls).toEqual([[1]]);
    expect(closed.written).toEqual([]);

    const throwing = new FakeStream();
    throwing.write = () => {
      throw new Error("gone");
    };
    const third = vi.fn();
    const out = new FakeStream();
    guardOutputStreams({ stdout: out, stderr: throwing }, third);
    out.emit("error", errorOf("EIO"));
    expect(third.mock.calls).toEqual([[1]]);
  });

  it("guards the process's own streams by default, and process.exit ends it", () => {
    const listeners = process.stdout.listenerCount("error");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      guardOutputStreams();
      expect(process.stdout.listenerCount("error")).toBe(listeners + 1);
      process.stdout.listeners("error").at(-1)?.call(process.stdout, errorOf("EPIPE"));
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
      process.stdout.removeListener("error", process.stdout.listeners("error").at(-1) as never);
      process.stderr.removeListener("error", process.stderr.listeners("error").at(-1) as never);
    }
  });

  it("a real child writing into a pipe its reader closed exits 0 with nothing on stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telflo-epipe-"));
    try {
      const script = join(dir, "writer.mts");
      writeFileSync(
        script,
        [
          `import { guardOutputStreams } from ${JSON.stringify(fileURLToPath(new URL("./output.ts", import.meta.url)))};`,
          "guardOutputStreams();",
          'const chunk = "x".repeat(65536);',
          "const pump = () => { process.stdout.write(chunk); setImmediate(pump); };",
          "pump();",
        ].join("\n"),
      );
      const child = spawn(process.execPath, ["--import", "tsx", script], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (data: Buffer) => void (stderr += data.toString()));
      child.stdout.once("data", () => child.stdout.destroy());
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
        child.on("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
      );
      clearTimeout(timer);
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
