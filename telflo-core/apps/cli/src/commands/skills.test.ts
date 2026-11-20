import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../tests/run-cli.js";
import { ExitError, setIo } from "../output.js";
import {
  CANNOT_INSTALL_MESSAGE,
  installSkills,
  PROJECT_AND_GLOBAL_MESSAGE,
  removeEarlierCopy,
  SKILL_MISSING_MESSAGE,
  skillsInstall,
  skillsSourceDir,
  skillTarget,
} from "./skills.js";

/* telflo skills install: the shipped skill copied under the folder named, and only there. */

const SKILL_FILES = ["SKILL.md", "references/commands.md", "references/testing.md"];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "telflo-skills-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the shipped skill", () => {
  it("is the telflo-cli skill: SKILL.md and its two references", () => {
    const source = skillsSourceDir();
    for (const file of SKILL_FILES) expect(existsSync(join(source, file))).toBe(true);
    expect(readFileSync(join(source, "SKILL.md"), "utf8").startsWith("---\nname: telflo-cli\n")).toBe(true);
  });

  it("names this CLI's login and variables, not the older CLI's", () => {
    const text = SKILL_FILES.map((file) => readFileSync(join(skillsSourceDir(), file), "utf8")).join("\n");
    for (const gone of [
      "TELFLO_API_TOKEN",
      "TELFLO_API_URL",
      "TELFLO_APP_URL",
      "TELFLO_CONFIG_DIR",
      "~/.telflo",
      "--token",
      "--api-url",
      "fleet deployments",
      "server-supervisor",
    ]) {
      expect(text.includes(gone), gone).toBe(false);
    }
    for (const present of [
      "TELFLO_TOKEN",
      "TELFLO_SERVER",
      "TELFLO_ORG",
      "TELFLO_CLI_CONFIG_DIR",
      "/cli-auth",
      "~/.config/telflo/credentials.json",
    ]) {
      expect(text.includes(present), present).toBe(true);
    }
  });
});

describe("installSkills", () => {
  it("copies the skill's files into <root>/telflo-cli", () => {
    const result = installSkills(dir);
    expect(result).toEqual({
      installed: join(dir, "telflo-cli"),
      files: SKILL_FILES.length,
    });
    for (const file of SKILL_FILES) {
      expect(readFileSync(join(dir, "telflo-cli", file), "utf8")).toBe(readFileSync(join(skillsSourceDir(), file), "utf8"));
    }
  });

  it("creates the root when it's missing", () => {
    const root = join(dir, "project", ".claude", "skills");
    expect(installSkills(root).installed).toBe(join(root, "telflo-cli"));
    expect(existsSync(join(root, "telflo-cli", "SKILL.md"))).toBe(true);
  });

  it("replaces its own earlier copy: a file the skill no longer ships is gone", () => {
    installSkills(dir);
    writeFileSync(join(dir, "telflo-cli", "stale.md"), "no longer shipped");
    expect(installSkills(dir).files).toBe(SKILL_FILES.length);
    expect(existsSync(join(dir, "telflo-cli", "stale.md"))).toBe(false);
  });

  it("leaves everything else in the root alone (another skill, a file beside it)", () => {
    mkdirSync(join(dir, "another-skill"));
    writeFileSync(join(dir, "another-skill", "SKILL.md"), "kept");
    writeFileSync(join(dir, "notes.md"), "kept");
    installSkills(dir);
    expect(readFileSync(join(dir, "another-skill", "SKILL.md"), "utf8")).toBe("kept");
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("kept");
    expect(readdirSync(dir).sort()).toEqual(["another-skill", "notes.md", "telflo-cli"]);
  });

  it("removes a link at <root>/telflo-cli, never what it points to", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "kept");
    const root = join(dir, "root");
    mkdirSync(root);
    symlinkSync(elsewhere, join(root, "telflo-cli"));
    installSkills(root);
    expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("kept");
    expect(readdirSync(elsewhere)).toEqual(["keep.txt"]);
    expect(existsSync(join(root, "telflo-cli", "SKILL.md"))).toBe(true);
  });

  it("removes a dangling link at <root>/telflo-cli, then installs", () => {
    const root = join(dir, "root");
    mkdirSync(root);
    symlinkSync(join(dir, "gone"), join(root, "telflo-cli"));
    expect(existsSync(join(root, "telflo-cli"))).toBe(false);
    expect(installSkills(root)).toEqual({ installed: join(root, "telflo-cli"), files: SKILL_FILES.length });
    expect(lstatSync(join(root, "telflo-cli")).isDirectory()).toBe(true);
    expect(existsSync(join(dir, "gone"))).toBe(false);
  });

  it("replaces a file at <root>/telflo-cli", () => {
    writeFileSync(join(dir, "telflo-cli"), "a file");
    expect(installSkills(dir).files).toBe(SKILL_FILES.length);
    expect(existsSync(join(dir, "telflo-cli", "SKILL.md"))).toBe(true);
  });

  it("ends in fixed words naming the folder when it can't write there (exit 1)", () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "not a folder");
    expect(() => installSkills(file)).toThrow(new ExitError(CANNOT_INSTALL_MESSAGE(join(file, "telflo-cli")), 1));
  });

  it("refuses a package with no skill, before touching the root", () => {
    installSkills(dir);
    const empty = join(dir, "no-skill");
    mkdirSync(empty);
    expect(() => installSkills(dir, empty)).toThrow(new ExitError(SKILL_MISSING_MESSAGE, 1));
    expect(existsSync(join(dir, "telflo-cli", "SKILL.md"))).toBe(true);
  });
});

describe("skillTarget", () => {
  it("is <root>/telflo-cli, the root resolved", () => {
    expect(skillTarget(join(dir, "a", "..", "b"))).toBe(join(dir, "b", "telflo-cli"));
    expect(skillTarget("/")).toBe("/telflo-cli");
  });

});

describe("removeEarlierCopy", () => {
  it("unlinks a link (never its target) or a file, removes a real folder whole, and leaves nothing missing alone", () => {
    const target = join(dir, "target");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "kept");
    symlinkSync(target, join(dir, "link"));
    removeEarlierCopy(join(dir, "link"));
    expect(existsSync(join(dir, "link")) || readdirSync(dir).includes("link")).toBe(false);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("kept");

    symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
    removeEarlierCopy(join(dir, "dangling"));
    expect(readdirSync(dir).includes("dangling")).toBe(false);

    writeFileSync(join(dir, "file"), "x");
    removeEarlierCopy(join(dir, "file"));
    expect(existsSync(join(dir, "file"))).toBe(false);

    mkdirSync(join(dir, "folder", "inner"), { recursive: true });
    writeFileSync(join(dir, "folder", "inner", "a.md"), "x");
    removeEarlierCopy(join(dir, "folder"));
    expect(existsSync(join(dir, "folder"))).toBe(false);

    expect(() => removeEarlierCopy(join(dir, "missing"))).not.toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });

  it("passes any other failure on (a path through a file)", () => {
    writeFileSync(join(dir, "file"), "x");
    expect(() => removeEarlierCopy(join(dir, "file", "below"))).toThrow();
  });
});

describe("telflo skills install", () => {
  it("installs into ./.claude/skills by default and with --project", () => {
    const printed: string[] = [];
    setIo({ stdout: (text) => void printed.push(text) });
    try {
      skillsInstall({}, { cwd: join(dir, "work"), home: join(dir, "home") });
      expect(existsSync(join(dir, "work", ".claude", "skills", "telflo-cli", "SKILL.md"))).toBe(true);
      rmSync(join(dir, "work"), { recursive: true });
      skillsInstall({ project: true }, { cwd: join(dir, "work"), home: join(dir, "home") });
      expect(existsSync(join(dir, "work", ".claude", "skills", "telflo-cli", "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, "home"))).toBe(false);
    } finally {
      setIo();
    }
    expect(printed).toEqual([
      `Installed the telflo-cli skill (3 files) in ${join(dir, "work", ".claude", "skills", "telflo-cli")}.\n`,
      `Installed the telflo-cli skill (3 files) in ${join(dir, "work", ".claude", "skills", "telflo-cli")}.\n`,
    ]);
  });

  it("installs into ~/.claude/skills with --global (HOME), printing where", async () => {
    const result = await runCli(["skills", "install", "--global"]);
    const home = process.env.HOME ?? "";
    expect(result.code).toBe(0);
    expect(existsSync(join(home, ".claude", "skills", "telflo-cli", "SKILL.md"))).toBe(true);
    expect(result.stdout).toBe(`Installed the telflo-cli skill (3 files) in ${join(home, ".claude", "skills", "telflo-cli")}.\n`);
    rmSync(join(home, ".claude"), { recursive: true, force: true });
  });

  it("prints {installed, files} with --json", async () => {
    const result = await runCli(["--json", "skills", "install", "--global"]);
    const home = process.env.HOME ?? "";
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      installed: join(home, ".claude", "skills", "telflo-cli"),
      files: 3,
    });
    rmSync(join(home, ".claude"), { recursive: true, force: true });
  });

  it("refuses --project and --global together (exit 2), writing nothing", async () => {
    const home = process.env.HOME ?? "";
    const result = await runCli(["skills", "install", "--project", "--global"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`error: ${PROJECT_AND_GLOBAL_MESSAGE}\n`);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});
