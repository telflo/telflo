import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateLibraryFileFieldsSchema,
  LIBRARY_ERROR_CODES,
  LIBRARY_FILE_MAXIMUM_BYTES,
  LIBRARY_FILE_PART_NAMES,
  LIBRARY_LINK_PATH_PATTERN,
  LIBRARY_LINK_PATTERN,
  LibraryFileFileNameSchema,
  LibraryFileLinkResponseSchema,
  LibraryFileSchema,
  libraryFileCurlCommand,
  libraryFileFileNameProblem,
  UpdateLibraryFileRequestSchema,
} from "./library-files.js";

/*
 * The library's contracts. The links here are hand-written and visibly fake
 * (`tll_FAKE…`): no key ever signed them, so they may be compared directly.
 */

/** A visibly fake link: `tll_FAKE` and 67 more characters of the alphabet, 71 after the prefix. */
const FAKE_LINK = `tll_FAKE${"Ab9_-".repeat(13)}xy`;
const FAKE_PATH = `/api/v1/library-links/${FAKE_LINK}`;
const FAKE_URL = `http://localhost:50080${FAKE_PATH}`;

describe("the library's limits and names", () => {
  it("are 10 MiB and the parts' order", () => {
    expect(LIBRARY_FILE_MAXIMUM_BYTES).toBe(10_485_760);
    expect(LIBRARY_FILE_PART_NAMES).toEqual(["name", "description", "file"]);
    expect(LIBRARY_ERROR_CODES).toEqual(["library_file_not_found", "library_file_too_large"]);
  });

  it("takes a fake link of 71 characters after tll_, and its path, and nothing else", () => {
    expect(FAKE_LINK.length).toBe(75);
    expect(LIBRARY_LINK_PATTERN.test(FAKE_LINK)).toBe(true);
    expect(LIBRARY_LINK_PATH_PATTERN.test(FAKE_PATH)).toBe(true);
    for (const link of [FAKE_LINK.slice(0, -1), `${FAKE_LINK}x`, FAKE_LINK.replace("tll_", "tqd_"), `${FAKE_LINK.slice(0, -1)}=`, `${FAKE_LINK.slice(0, -1)}+`]) {
      expect(LIBRARY_LINK_PATTERN.test(link), link).toBe(false);
    }
    expect(LIBRARY_LINK_PATH_PATTERN.test(`${FAKE_PATH}/`)).toBe(false);
    expect(LIBRARY_LINK_PATH_PATTERN.test(`https://telflo.example${FAKE_PATH}`)).toBe(false);
    expect(LibraryFileLinkResponseSchema.safeParse({ path: FAKE_PATH }).success).toBe(true);
    expect(LibraryFileLinkResponseSchema.safeParse({ path: FAKE_PATH, url: FAKE_URL }).success).toBe(false);
  });
});

describe("the upload's fields", () => {
  it("trims the name and description; a 200-character name and a 2,000-character description pass", () => {
    expect(CreateLibraryFileFieldsSchema.parse({ name: "  Guide  ", description: " d " })).toEqual({ name: "Guide", description: "d" });
    expect(CreateLibraryFileFieldsSchema.safeParse({ name: "n".repeat(200), description: "d".repeat(2000) }).success).toBe(true);
  });

  it.each([
    ["an empty name", { name: "   ", description: "" }],
    ["a 201-character name", { name: "n".repeat(201), description: "" }],
    ["a 2,001-character description", { name: "n", description: "d".repeat(2001) }],
    ["a name holding U+0000", { name: "a\u0000b", description: "" }],
    ["an unknown field", { name: "n", description: "", extra: "x" }],
  ])("refuses %s", (_label, fields) => {
    expect(CreateLibraryFileFieldsSchema.safeParse(fields).success).toBe(false);
  });
});

describe("the uploaded file's own name", () => {
  it.each([
    "guide.pdf",
    "a",
    "f".repeat(255),
    "Getting started (v2).tar.gz",
    ".hidden",
    "a..b",
    "x-",
    "naïve résumé.txt",
    "$(echo EXPANDED)",
    "it's \"quoted\" `x`.txt",
    // Format characters in names people use: ZWNJ in Persian, ZWJ in an emoji sequence, a soft hyphen.
    "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.txt",
    "\u{1F469}\u200D\u{1F4BB} notes.txt",
    "re\u00ADsume.pdf",
  ])(
    "takes %j",
    (name) => {
      expect(libraryFileFileNameProblem(name)).toBeUndefined();
      expect(LibraryFileFileNameSchema.safeParse(name).success).toBe(true);
    },
  );

  it.each([
    ["an empty name", "", "length"],
    ["256 characters", "f".repeat(256), "length"],
    ["a newline", "a\nb", "control or formatting character"],
    ["a tab", "a\tb", "control or formatting character"],
    ["a carriage return", "a\r", "control or formatting character"],
    ["DEL", "a\u007f", "control or formatting character"],
    ["a C1 control", "a\u0085", "control or formatting character"],
    ["U+0000", "a\u0000", "control or formatting character"],
    ["U+061C (Arabic letter mark)", "a\u061Cb.txt", "control or formatting character"],
    ["U+200E (left-to-right mark)", "a\u200Eb.txt", "control or formatting character"],
    ["U+200F (right-to-left mark)", "a\u200Fb.txt", "control or formatting character"],
    ["U+202A (left-to-right embedding)", "a\u202Ab.txt", "control or formatting character"],
    ["U+202B (right-to-left embedding)", "a\u202Bb.txt", "control or formatting character"],
    ["U+202C (pop directional formatting)", "a\u202Cb.txt", "control or formatting character"],
    ["U+202D (left-to-right override)", "a\u202Db.txt", "control or formatting character"],
    ["U+202E (right-to-left override)", "\u202Etxt.exe", "control or formatting character"],
    ["U+2066 (left-to-right isolate)", "a\u2066b.txt", "control or formatting character"],
    ["U+2067 (right-to-left isolate)", "a\u2067b.txt", "control or formatting character"],
    ["U+2068 (first strong isolate)", "a\u2068b.txt", "control or formatting character"],
    ["U+2069 (pop directional isolate)", "a\u2069b.txt", "control or formatting character"],
    ["U+200B (zero width space)", "a\u200Bb.txt", "control or formatting character"],
    ["U+2060 (word joiner)", "a\u2060b.txt", "control or formatting character"],
    ["U+FEFF (byte order mark)", "\uFEFFa.txt", "control or formatting character"],
    ["a slash", "dir/file.txt", "slash"],
    ["a leading slash", "/etc/passwd", "slash"],
    ["a backslash", "dir\\file.txt", "slash"],
    [".", ".", "dot"],
    ["..", "..", "dot"],
    ["a dash", "-", "leading dash"],
    ["a leading dash", "-o.txt", "leading dash"],
    ["a lone surrogate", "a\ud800", "unstorable"],
  ])("refuses %s", (_label, name, problem) => {
    expect(libraryFileFileNameProblem(name)).toBe(problem);
    expect(LibraryFileFileNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("a change", () => {
  it("takes the name, the description or both, trimmed", () => {
    expect(UpdateLibraryFileRequestSchema.parse({ name: " N " })).toEqual({ name: "N" });
    expect(UpdateLibraryFileRequestSchema.parse({ description: "" })).toEqual({ description: "" });
    expect(UpdateLibraryFileRequestSchema.parse({ name: "N", description: "D" })).toEqual({ name: "N", description: "D" });
  });

  it.each([
    ["nothing", {}],
    ["a file name", { fileName: "x.txt" }],
    ["an empty name", { name: "" }],
    ["a 201-character name", { name: "n".repeat(201) }],
    ["a 2,001-character description", { description: "d".repeat(2001) }],
  ])("refuses %s", (_label, body) => {
    expect(UpdateLibraryFileRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("a library file", () => {
  it("is strict, ids and times well formed", () => {
    const file = {
      id: "0199e000-0000-7000-8000-00000000f001",
      name: "Guide",
      description: "",
      fileName: "guide.pdf",
      sizeBytes: 10_485_760,
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    };
    expect(LibraryFileSchema.parse(file)).toEqual(file);
    expect(LibraryFileSchema.safeParse({ ...file, sha256: "00" }).success).toBe(false);
    expect(LibraryFileSchema.safeParse({ ...file, sizeBytes: 10_485_761 }).success).toBe(false);
  });
});

/*
 * The Copy curl command: both values single-quoted. `run` runs it in a REAL
 * shell (sh, bash and zsh, those present; dash too) whose PATH is a
 * directory holding one fake `curl`, which only records its argv (each word
 * ended by U+001E) into a log, and touches no other file. Every probe is
 * harmless (`$(echo EXPANDED)`, never a command with an effect).
 */
const SHELLS = ["sh", "bash", "zsh", "dash"]
  .map((name) => [`/bin/${name}`, `/usr/bin/${name}`].find((path) => existsSync(path)))
  .filter((path): path is string => path !== undefined);

const FAKE_CURL = `#!/bin/sh
line=""
for a in "$@"; do line="$line$a$(printf '\\036')"; done
printf '%s\\n' "$line" >> "$PROBE_LOG"
`;

describe("libraryFileCurlCommand", () => {
  let fakes: string;
  let log: string;
  beforeAll(() => {
    fakes = mkdtempSync(join(tmpdir(), "library-curl-fakes-"));
    writeFileSync(join(fakes, "curl"), FAKE_CURL);
    chmodSync(join(fakes, "curl"), 0o755);
    log = join(fakes, "log");
  });
  afterAll(() => rmSync(fakes, { recursive: true, force: true }));

  /** The argv the fake curl recorded, each call one list of words. */
  function run(command: string, shell: string): string[][] {
    writeFileSync(log, "");
    const prelude = `[ "$(command -v curl)" = "${fakes}/curl" ] || exit 99`;
    const flags = shell.endsWith("zsh") ? ["-f", "-c"] : shell.endsWith("bash") ? ["--noprofile", "--norc", "-c"] : ["-c"];
    execFileSync(shell, [...flags, `${prelude}\n${command}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: fakes, HOME: "/nonexistent", PROBE_LOG: log },
    });
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split("\u001e").slice(0, -1));
  }

  it("is curl -fL '<url>' -o '<name>', both single-quoted", () => {
    expect(libraryFileCurlCommand(FAKE_URL, "guide.pdf")).toBe(`curl -fL '${FAKE_URL}' -o 'guide.pdf'`);
    expect(libraryFileCurlCommand(FAKE_URL, "it's.txt")).toBe(`curl -fL '${FAKE_URL}' -o 'it'\\''s.txt'`);
  });

  it("has sh, bash and zsh to run in", () => {
    for (const name of ["sh", "bash", "zsh"]) expect(SHELLS.some((shell) => shell.endsWith(`/${name}`)), name).toBe(true);
  });

  it.each([
    ["an ordinary name", "guide.pdf"],
    // A leading dash (the API refuses one): still one quoted word, after -o.
    ["a leading dash", "-x"],
    ["$(echo EXPANDED)", "$(echo EXPANDED).txt"],
    ["a single quote", "it's.txt"],
    ["backticks", "`echo EXPANDED`.txt"],
    ["double quotes", '"quoted" $HOME.txt'],
    ["everything at once", `a'b"c\`echo EXPANDED\`$(echo EXPANDED) \${HOME};|&<>*?.txt`],
  ])("hands curl %s literally, in every shell, with the url as one word", (_label, name) => {
    const command = libraryFileCurlCommand(FAKE_URL, name);
    for (const shell of SHELLS) {
      expect({ shell, calls: run(command, shell) }).toEqual({ shell, calls: [["-fL", FAKE_URL, "-o", name]] });
    }
  });
});
