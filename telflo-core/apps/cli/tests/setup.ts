/*
 * Every cli test file starts away from any real login (D27 Preflight
 * ruling 4; brief rules: the owner's `~/.telflo/` and `~/.config/telflo/`
 * are never opened): no `TELFLO_TOKEN`, `TELFLO_SERVER` or `TELFLO_ORG` from
 * the shell, no `TELFLO_CONFIG_DIR` (the older CLI's, never read: Ruling
 * 232), and `TELFLO_CLI_CONFIG_DIR`, `XDG_CONFIG_HOME` and `HOME` in a
 * temporary folder of the file's own, removed afterwards.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const root = mkdtempSync(join(tmpdir(), "telflo-cli-test-"));
for (const name of ["config", "xdg", "home"]) mkdirSync(join(root, name), { mode: 0o700 });

delete process.env.TELFLO_TOKEN;
delete process.env.TELFLO_SERVER;
delete process.env.TELFLO_ORG;
delete process.env.TELFLO_CONFIG_DIR;
process.env.TELFLO_CLI_CONFIG_DIR = join(root, "config");
process.env.XDG_CONFIG_HOME = join(root, "xdg");
process.env.HOME = join(root, "home");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
