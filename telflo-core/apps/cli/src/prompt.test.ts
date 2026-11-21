import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeStdin, type FakeStdin } from "../tests/run-cli.js";
import { ExitError, setIo } from "./output.js";
import {
  ask,
  CANCELLED_MESSAGE,
  LINE_TOO_LONG_MESSAGE,
  MAXIMUM_LINE_BYTES,
  NOTHING_ENTERED_MESSAGE,
  readHidden,
  readLine,
  stdinIsTerminal,
} from "./prompt.js";

/*
 * The hidden prompt through a pty-less stream: it echoes nothing and always
 * puts the terminal back.
 */

let stderr: string;
let stdin: FakeStdin;

function use(stream: FakeStdin): void {
  stdin = stream;
  setIo({ stdin, stderr: (text) => void (stderr += text), stdout: () => undefined });
}

async function refusalOf(promise: Promise<unknown>): Promise<ExitError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExitError) return error;
    throw error;
  }
  throw new Error("nothing was refused");
}

beforeEach(() => {
  stderr = "";
});

afterEach(() => setIo());

describe("readHidden", () => {
  beforeEach(() => use(fakeStdin({ tty: true })));

  it("asks on stderr, echoes nothing, and puts the terminal back", async () => {
    const answer = readHidden("Token: ");
    stdin.write("secret-");
    stdin.write("value\r");
    expect(await answer).toBe("secret-value");
    expect(stderr).toBe("Token: \n");
    expect(stderr.includes("secret")).toBe(false);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdinIsTerminal()).toBe(true);
  });

  it("removes a character for Backspace and ends on a newline", async () => {
    const answer = readHidden("? ");
    stdin.write("abx\u007fc\bd\n");
    expect(await answer).toBe("abd");
  });

  it("an empty Enter ends it (exit 2), but with ignoreEmpty it keeps waiting; Ctrl-D still ends it", async () => {
    const plain = readHidden("? ");
    stdin.write("\r");
    expect((await refusalOf(plain)).message).toBe(NOTHING_ENTERED_MESSAGE);

    use(fakeStdin({ tty: true }));
    const waiting = readHidden("? ", { ignoreEmpty: true });
    stdin.write("\r");
    stdin.write("  \n");
    stdin.write("tok\u007f\u007f\u007f\r");
    stdin.write("token\r");
    expect(await waiting).toBe("token");
    expect(stdin.rawModes).toEqual([true, false]);

    use(fakeStdin({ tty: true }));
    const ended = readHidden("? ", { ignoreEmpty: true });
    stdin.write("\r\u0004");
    expect((await refusalOf(ended)).message).toBe(NOTHING_ENTERED_MESSAGE);
  });

  it("stops at Ctrl-C (exit 3) with the terminal restored", async () => {
    const answer = readHidden("? ");
    stdin.write("half\u0003more");
    const error = await refusalOf(answer);
    expect(error.message).toBe(CANCELLED_MESSAGE);
    expect(error.exitCode).toBe(3);
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("refuses Ctrl-D or the end with nothing typed (exit 2), and answers what was typed before it", async () => {
    const empty = readHidden("? ");
    stdin.write("\u0004");
    expect((await refusalOf(empty)).message).toBe(NOTHING_ENTERED_MESSAGE);

    use(fakeStdin({ tty: true }));
    const ended = readHidden("? ");
    stdin.write("typed");
    stdin.end();
    expect(await ended).toBe("typed");
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("keeps at most 4 KiB", async () => {
    const answer = readHidden("? ");
    stdin.write(`${"a".repeat(MAXIMUM_LINE_BYTES + 100)}\r`);
    expect((await answer).length).toBe(MAXIMUM_LINE_BYTES);
  });

  it("closes when its signal aborts (the browser answered first), the terminal restored", async () => {
    const closing = new AbortController();
    const answer = readHidden("? ", { signal: closing.signal });
    stdin.write("half");
    closing.abort();
    const error = await refusalOf(answer);
    expect([error.message, error.exitCode]).toEqual([CANCELLED_MESSAGE, 3]);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("end")).toBe(0);
  });

  it("closes at once on a signal already aborted, and a later abort after an answer changes nothing", async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect((await refusalOf(readHidden("? ", { signal: aborted.signal }))).message).toBe(CANCELLED_MESSAGE);
    expect(stdin.rawModes).toEqual([true, false]);

    use(fakeStdin({ tty: true }));
    const later = new AbortController();
    const answer = readHidden("? ", { signal: later.signal });
    stdin.write("typed\r");
    expect(await answer).toBe("typed");
    later.abort();
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("works on a stream with no raw mode", async () => {
    const plain = fakeStdin();
    plain.isTTY = true;
    use(plain);
    const answer = readHidden("? ");
    stdin.write("x\n");
    expect(await answer).toBe("x");
  });
});

describe("readLine", () => {
  beforeEach(() => use(fakeStdin()));

  it("answers the first line, its CR dropped", async () => {
    const line = readLine();
    stdin.write("first\r\nsecond\n");
    expect(await line).toBe("first");
    expect(stdinIsTerminal()).toBe(false);
  });

  it("answers a last line with no newline at the end", async () => {
    const line = readLine();
    stdin.end("only");
    expect(await line).toBe("only");
  });

  it("refuses nothing, or a line over 4 KiB, without echoing it", async () => {
    const empty = readLine();
    stdin.end("  \n");
    expect((await refusalOf(empty)).message).toBe(NOTHING_ENTERED_MESSAGE);

    use(fakeStdin());
    const long = readLine();
    stdin.write("b".repeat(MAXIMUM_LINE_BYTES + 1));
    const error = await refusalOf(long);
    expect(error.message).toBe(LINE_TOO_LONG_MESSAGE);
    expect(error.exitCode).toBe(2);
    expect(error.message.includes("bbbb")).toBe(false);
  });

  it("reads string chunks, and refuses a stream that fails", async () => {
    stdin.setEncoding("utf8");
    const line = readLine();
    stdin.write("text\n");
    expect(await line).toBe("text");

    use(fakeStdin());
    const failing = readLine();
    stdin.destroy(new Error("broken pipe"));
    expect((await refusalOf(failing)).message).toBe(NOTHING_ENTERED_MESSAGE);
  });
});

describe("ask", () => {
  it("asks on stderr and answers the line", async () => {
    use(fakeStdin());
    const answer = ask("Organization number:");
    stdin.write("2\n");
    expect(await answer).toBe("2");
    expect(stderr).toBe("Organization number:\n");
  });
});
