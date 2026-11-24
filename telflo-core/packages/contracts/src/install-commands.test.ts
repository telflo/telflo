import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { containerCommand, containerPreview, OPAMP_VOLUME, type ContainerCommandParts } from "./install-commands.js";
import { INSTALL_MASKED_TOKEN } from "./install.js";

/*
 * The container command, shared so the public install route and the
 * install dialog build the same bytes. The web's own tests (apps/web
 * `lib/install.test.ts`, run unchanged through its re-export) pin every
 * line, quoting and refusal with a real bash; these pin the shared module
 * itself. The bearer here is a fixture, not a secret.
 */

const BEARER = "Zml4dHVyZS1iZWFyZXI+/=";

const FACTS: ContainerCommandParts["facts"] = {
  imageTag: "ghcr.io/telflo/telflo/collector:0.162.0",
  endpoint: "wss://opamp.example.com/v1/opamp",
  allowInsecureConnections: true,
  groupId: "3d4e5f60-7182-4394-aa5b-6c7d8e9fa0b1",
  mounts: [{ hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true }],
};

describe("containerCommand", () => {
  it("is the dialog's command: the secrets as assignments before it, then one flag a line, every value quoted once", () => {
    expect(OPAMP_VOLUME).toBe("telflo-opamp:/app/opamp");
    expect(containerCommand({ facts: FACTS, bearer: BEARER, displayName: "edge 1", env: [{ name: "NGINX_ENV", value: "it's" }] })).toBe(
      [
        `OPAMP_TOKEN='${BEARER}' \\`,
        "NGINX_ENV='it'\\''s' \\",
        "docker run -d --restart unless-stopped --name telflo-collector \\",
        "  -v telflo-opamp:/app/opamp \\",
        "  -v '/var/log/nginx:/var/log/nginx:ro' \\",
        "  -e COLLECTOR_GROUP_ID='3d4e5f60-7182-4394-aa5b-6c7d8e9fa0b1' \\",
        "  -e OPAMP_ENDPOINT='wss://opamp.example.com/v1/opamp' \\",
        "  -e OPAMP_ALLOW_INSECURE_CONNECTIONS='true' \\",
        "  -e OPAMP_SERVER_NAME='edge 1' \\",
        "  -e OPAMP_TOKEN \\",
        "  -e NGINX_ENV \\",
        "  'ghcr.io/telflo/telflo/collector:0.162.0'",
      ].join("\n"),
    );
  });

  it("leaves the display name's line out when there is none", () => {
    expect(containerCommand({ facts: FACTS, bearer: BEARER, displayName: "", env: [] })).not.toContain("OPAMP_SERVER_NAME");
  });

  it("refuses a variable that isn't a shell name, one the install sets itself, and one given twice", () => {
    const base = { facts: FACTS, bearer: BEARER, displayName: "" };
    expect(() => containerCommand({ ...base, env: [{ name: "A-B", value: "x" }] })).toThrow("isn't a shell name");
    expect(() => containerCommand({ ...base, env: [{ name: "OPAMP_TOKEN", value: "x" }] })).toThrow("sets itself");
    expect(() => containerCommand({ ...base, env: [{ name: "A", value: "x" }, { name: "A", value: "y" }] })).toThrow("given twice");
  });
});

describe("containerPreview", () => {
  it("is the command with the token masked, and holds no bearer", () => {
    const parts = { facts: FACTS, displayName: "edge 1", env: [] };
    const preview = containerPreview(parts);
    expect(preview).toBe(containerCommand({ ...parts, bearer: INSTALL_MASKED_TOKEN }));
    expect(preview.includes(BEARER)).toBe(false);
  });
});

/*
 * The command pasted into a REAL shell (bash, sh, dash and zsh, those this
 * machine has), with a fake `docker` first on PATH that records its
 * arguments (what `ps` shows every local user) and the environment it was
 * given (what only its owner and root can read): the bearer and the
 * variables' values reach docker's environment, never its arguments, and
 * the shell keeps none of them after the command.
 */
describe("containerCommand in a real shell", () => {
  const SHELLS = ["bash", "sh", "dash", "zsh"]
    .map((name) => [`/bin/${name}`, `/usr/bin/${name}`].find((path) => existsSync(path)))
    .filter((path): path is string => path !== undefined);
  const directory = mkdtempSync(join(tmpdir(), "telflo-container-command-"));
  const log = join(directory, "log");
  writeFileSync(
    join(directory, "docker"),
    [
      "#!/bin/sh",
      'for a in "$@"; do printf \'arg:%s\\036\\n\' "$a"; done >> "$PROBE_LOG"',
      'for n in OPAMP_TOKEN API_KEY OTHER; do printf \'env:%s=%s\\036\\n\' "$n" "$(printenv "$n")"; done >> "$PROBE_LOG"',
      "",
    ].join("\n"),
  );
  chmodSync(join(directory, "docker"), 0o755);
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  // Values a shell must hand over whole: a quote, spaces, $(…), backticks, a variable, globs, ~, \ and #.
  const SECRET = `it's $(echo EXPANDED) \`echo EXPANDED\` \${HOME} * ? [a] ~ \\ "q" #x`;
  const command = containerCommand({
    facts: FACTS,
    bearer: BEARER,
    displayName: "edge 1",
    env: [
      { name: "API_KEY", value: SECRET },
      { name: "OTHER", value: "plain" },
    ],
  });

  it.each(SHELLS)("%s: the secrets are in docker's environment, not its arguments, and not left in the shell", (shell) => {
    writeFileSync(log, "");
    const flags = shell.endsWith("zsh") ? ["-f", "-c"] : shell.endsWith("bash") ? ["--noprofile", "--norc", "-c"] : ["-c"];
    const after = `printf 'after:%s\\036\\n' "\${OPAMP_TOKEN-unset}\${API_KEY-unset}" >> "$PROBE_LOG"`;
    execFileSync(shell, [...flags, `${command}\n${after}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${directory}:/usr/bin:/bin`, HOME: "/nonexistent", PROBE_LOG: log },
    });
    const records = execFileSync("/bin/cat", [log], { encoding: "utf8" }).split("\u001e\n").slice(0, -1);
    const args = records.filter((each) => each.startsWith("arg:")).map((each) => each.slice(4));
    expect(args).toEqual([
      "run", "-d", "--restart", "unless-stopped", "--name", "telflo-collector",
      "-v", OPAMP_VOLUME,
      "-v", "/var/log/nginx:/var/log/nginx:ro",
      "-e", `COLLECTOR_GROUP_ID=${FACTS.groupId}`,
      "-e", `OPAMP_ENDPOINT=${FACTS.endpoint}`,
      "-e", "OPAMP_ALLOW_INSECURE_CONNECTIONS=true",
      "-e", "OPAMP_SERVER_NAME=edge 1",
      "-e", "OPAMP_TOKEN",
      "-e", "API_KEY",
      "-e", "OTHER",
      FACTS.imageTag,
    ]);
    expect(args.some((each) => each.includes(BEARER) || each.includes("EXPANDED") || each.includes("plain"))).toBe(false);
    expect(records.filter((each) => each.startsWith("env:"))).toEqual([`env:OPAMP_TOKEN=${BEARER}`, `env:API_KEY=${SECRET}`, "env:OTHER=plain"]);
    expect(records.at(-1)).toBe("after:unsetunset");
  });
});

