import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The API refuses to start on a broken template set, naming the setting and
// the file, never its text. index.ts is run for real (it exits before it
// opens a connection: the check comes first); e2e/start-api.ts, which never
// runs index.ts, makes the same check.

const API = fileURLToPath(new URL("../..", import.meta.url));
const WORKSPACE = fileURLToPath(new URL("../../../..", import.meta.url));
const CANARY = "template-text-canary-91c2";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "install-startup-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("the API's start", () => {
  it("refuses a broken install template set, naming the setting and the file, never its text", async () => {
    for (const method of ["all-in-one", "own-binary"]) {
      await mkdir(join(base, "linux", method), { recursive: true });
      await writeFile(join(base, "linux", method, "README.md"), `${CANARY}\n`);
    }
    await writeFile(join(base, "linux", "own-binary", "README.md"), `${CANARY} \${NOT_KNOWN}\n`);
    const run = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: API,
      encoding: "utf8",
      env: { ...process.env, TELFLO_INSTALL_TEMPLATES_DIR: base, LOG_LEVEL: "silent" },
      // A hang guard only: the check fails before anything is opened.
      timeout: 60_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("failed to start");
    expect(run.stderr).toContain(
      "The install templates (TELFLO_INSTALL_TEMPLATES_DIR) can't be used: linux/own-binary/README.md: line 1: a placeholder Telflo doesn't fill",
    );
    expect(`${run.stdout}${run.stderr}`).not.toContain(CANARY);
  });

  it.each(["apps/api/src/index.ts", "e2e/start-api.ts"])("%s checks the templates before it builds the server, and hands it the checked loader", async (path) => {
    const text = await readFile(join(WORKSPACE, path), "utf8");
    const checked = text.indexOf("await checkInstallTemplates(installTemplates)");
    expect(checked).toBeGreaterThan(-1);
    expect(text.indexOf("buildServer({")).toBeGreaterThan(checked);
    expect(text).toMatch(/buildServer\(\{[^}]*installTemplates[,\s]/s);
  });
});
