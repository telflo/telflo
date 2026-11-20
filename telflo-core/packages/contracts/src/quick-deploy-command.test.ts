import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTALL_MASKED_TOKEN, shellQuote } from "./install.js";
import { QUICK_DEPLOY_MASKED_SECRET } from "./quick-deploy.js";
import {
  QUICK_DEPLOY_UNIT_NAME,
  QUICK_DEPLOY_UNIT_PATH,
  quickDeployCommands,
  quickDeployPreview,
  quickDeployUnit,
  type QuickDeployCommandParts,
} from "./quick-deploy-command.js";

// The Quick Deploy command.
//
// `run` runs a command in a REAL shell (bash, sh, dash and zsh, those
// present) whose PATH is a directory of fakes alone: `sudo`, `curl`,
// `mkdir`, `tar`, `install`, `tee`, `systemctl`, `printf` and `probe`. Each
// fake only records, into a log: its argv (each word ended by U+001E, each
// record by U+001F) and what it read on its standard input (a `stdin:`
// record). None touches any other file. The fake `sudo` drops its own
// options and runs the fake of the program it was given, else records the
// OPAMP_TOKEN it was handed (a `token:` record) and stops, so the start
// script never runs. The fake `curl` writes "ARCHIVE" for the tar (nothing,
// and exit 22, when CURL_FAILS is set: a refused download); the fake `tar`
// fails on an empty stream, as tar does. A fake `printf` records too: the
// shells' own builtin is the one the command must use. A prelude refuses to
// run unless the fake `sudo` comes first; the shell reads no profile; `cd`
// is a function that records. After the command, the PARENT shell (the one
// the command is pasted into) records whether OPAMP_TOKEN is set in it (an
// `after:` record). Every probe is
// harmless (`$(echo EXPANDED)`, never a command with an effect).

const SECRET = `tqd_${"Ab9_-".repeat(8)}xyz`;
const HTTPS_URL = `https://telflo.example.com/api/v1/quick-deploy/${SECRET}`;
const HTTP_URL = `http://host.docker.internal:50080/telflo/api/v1/quick-deploy/${SECRET}`;
/** Standard base64, as the opamp-server seals a bearer: `+`, `/` and padding. */
const BEARER = "QmVhcmVyIGNhbmFyeQ+/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==";

const SHELLS = ["bash", "sh", "dash", "zsh"]
  .map((name) => [`/bin/${name}`, `/usr/bin/${name}`].find((path) => existsSync(path)))
  .filter((path): path is string => path !== undefined);

// One write a record, so records never interleave.
const RECORD = `rec() { line=""; for a in "$@"; do line="$line$a"$'\\036'; done; printf '%s\\037\\n' "$line" >> "$PROBE_LOG"; }`;
const READ_STDIN = `input=$(/bin/cat; printf .); input=\${input%.}`;
const FAKES: Record<string, string> = {
  sudo: `#!/bin/bash
${RECORD}
# A pipe in (curl's, printf's): read it whole first, so this record follows the writer's.
piped=0
if [ -p /dev/stdin ]; then piped=1; ${READ_STDIN}; fi
rec sudo "$@"
while [ "$#" -gt 0 ] && [ "\${1#-}" != "$1" ]; do shift; done
if [ ! -x "$FAKES/$1" ]; then rec "token:$OPAMP_TOKEN"; exit 0; fi
if [ "$piped" = 1 ]; then printf '%s' "$input" | PATH="$FAKES" "$FAKES/$1" "\${@:2}"; exit; fi
PATH="$FAKES" exec "$FAKES/$1" "\${@:2}"
`,
  curl: `#!/bin/bash
${RECORD}
rec curl "$@"
${READ_STDIN}
[ -z "$input" ] || rec "stdin:$input"
if [ -n "$CURL_FAILS" ]; then exit 22; fi
printf 'ARCHIVE'
`,
  tar: `#!/bin/bash
${RECORD}
rec tar "$@"
${READ_STDIN}
if [ -z "$input" ]; then exit 2; fi
rec "stdin:$input"
`,
  printf: `#!/bin/bash
${RECORD}
rec printf "$@"
exec /usr/bin/printf "$@"
`,
};
for (const program of ["mkdir", "install", "tee", "systemctl", "probe"]) {
  FAKES[program] = `#!/bin/bash
${RECORD}
rec ${program} "$@"
${READ_STDIN}
[ -z "$input" ] || rec "stdin:$input"
`;
}

let fakes: string;
let log: string;
beforeAll(() => {
  fakes = mkdtempSync(join(tmpdir(), "quick-deploy-fakes-"));
  for (const [name, text] of Object.entries(FAKES)) {
    writeFileSync(join(fakes, name), text);
    chmodSync(join(fakes, name), 0o755);
  }
  log = join(fakes, "log");
});
afterAll(() => rmSync(fakes, { recursive: true, force: true }));

/** Each recorded call: its words, the program first; a `stdin:` record after a call that read something; the `after:` record last. */
function run(command: string, shell: string, environment: Record<string, string> = {}): { calls: string[][]; status: number } {
  writeFileSync(log, "");
  const prelude = [
    // Never a real sudo: stop unless the fakes come first.
    `[ "$(command -v sudo)" = "${fakes}/sudo" ] || exit 99`,
    `cd() { printf 'cd\\036%s\\036\\037\\n' "$1" >> "$PROBE_LOG"; }`,
  ].join("\n");
  const flags = shell.endsWith("zsh") ? ["-f", "-c"] : shell.endsWith("bash") ? ["--noprofile", "--norc", "-c"] : ["-c"];
  // Whether the bearer reached the shell the command was pasted into; the shell then exits with the command's status (`pasted`: zsh's `status` is read-only).
  const after = `pasted=$?; printf 'after:%s\\036\\037\\n' "\${OPAMP_TOKEN-unset}" >> "$PROBE_LOG"; exit "$pasted"`;
  let status = 0;
  try {
    execFileSync(shell, [...flags, `${prelude}\n${command}\n${after}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: fakes, HOME: "/nonexistent", PROBE_LOG: log, FAKES: fakes, ...environment },
    });
  } catch (error) {
    status = (error as { status: number }).status;
  }
  const calls = readFileSync(log, "utf8")
    .split("\u001f\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\u001e").slice(0, -1));
  return { calls, status };
}

/** The records that are a process's argv: neither secret may be in one. */
function argvsOf(calls: string[][]): string[][] {
  return calls.filter((call) => !/^(stdin|token|after):/.test(call[0]!));
}

const BASE: QuickDeployCommandParts = { url: HTTPS_URL, rootPath: "/etc/otelcol", bearer: BEARER, displayName: "", systemd: true };

/** The unit, written out. */
const UNIT = (root: string, name: string) =>
  [
    "[Unit]",
    "Description=Telflo OpAMP Supervisor",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${root}`,
    `ExecStart=${root}/start_supervisor.sh${name === "" ? "" : ` "--OPAMP_SERVER_NAME=${name}"`}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");

/** The command's lines, written out for every combination; the goldens below are literal. */
function expectedLines(url: string, root: string, name: string, systemd: boolean, bearer = BEARER): string {
  const proto = url.startsWith("https://") ? " --proto '=https'" : "";
  const head = [
    "(",
    `export OPAMP_TOKEN='Bearer ${bearer}' &&`,
    `sudo mkdir -p '${root}' &&`,
    `printf 'url = "%s"\\n' '${url}' | curl -q -g -fsS --retry 3${proto} -K - | sudo tar -xzf - -C '${root}' &&`,
  ];
  if (!systemd) {
    return [
      ...head,
      `cd '${root}' && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh${name === "" ? "" : ` --OPAMP_SERVER_NAME='${name}'`} )`,
    ].join("\n");
  }
  return [
    ...head,
    `printf "OPAMP_TOKEN='%s'\\n" "$OPAMP_TOKEN" | sudo install -m 600 /dev/stdin '${root}/opamp.env' &&`,
    "sudo install -m 644 /dev/stdin /etc/systemd/system/telflo-supervisor.service <<'UNIT' &&",
    UNIT(root, name),
    "UNIT",
    "sudo systemctl daemon-reload && sudo systemctl enable telflo-supervisor.service && sudo systemctl restart telflo-supervisor.service )",
  ].join("\n");
}

/**
 * Two combinations written out by hand, character for character: no template
 * shared with the builder (the bearer and the link's secret spelled out too).
 */
const GOLDEN_FOREGROUND = String.raw`(
export OPAMP_TOKEN='Bearer QmVhcmVyIGNhbmFyeQ+/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==' &&
sudo mkdir -p '/etc/otelcol' &&
printf 'url = "%s"\n' 'https://telflo.example.com/api/v1/quick-deploy/tqd_Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-xyz' | curl -q -g -fsS --retry 3 --proto '=https' -K - | sudo tar -xzf - -C '/etc/otelcol' &&
cd '/etc/otelcol' && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh --OPAMP_SERVER_NAME='edge one.2_b-c' )`;

const GOLDEN_SYSTEMD = String.raw`(
export OPAMP_TOKEN='Bearer QmVhcmVyIGNhbmFyeQ+/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==' &&
sudo mkdir -p '/opt/telflo' &&
printf 'url = "%s"\n' 'http://host.docker.internal:50080/telflo/api/v1/quick-deploy/tqd_Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-xyz' | curl -q -g -fsS --retry 3 -K - | sudo tar -xzf - -C '/opt/telflo' &&
printf "OPAMP_TOKEN='%s'\n" "$OPAMP_TOKEN" | sudo install -m 600 /dev/stdin '/opt/telflo/opamp.env' &&
sudo install -m 644 /dev/stdin /etc/systemd/system/telflo-supervisor.service <<'UNIT' &&
[Unit]
Description=Telflo OpAMP Supervisor
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/telflo
ExecStart=/opt/telflo/start_supervisor.sh "--OPAMP_SERVER_NAME=prod east-1"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable telflo-supervisor.service && sudo systemctl restart telflo-supervisor.service )`;

/** Every combination: systemd or the foreground, a display name or none, an https link or development's http one. */
const COMBINATIONS = [false, true].flatMap((systemd) =>
  ["", "edge one.2_b-c"].flatMap((name) => [HTTPS_URL, HTTP_URL].map((url) => ({ systemd, name, url }))),
);

describe("quickDeployCommands: the lines", () => {
  it("finds bash and sh to run them in", () => {
    expect(SHELLS.some((shell) => shell.endsWith("/bash"))).toBe(true);
    expect(SHELLS.some((shell) => shell.endsWith("/sh"))).toBe(true);
  });

  it.each(COMBINATIONS)("are the ruling's, exactly (systemd $systemd, name $name, $url)", ({ systemd, name, url }) => {
    const command = quickDeployCommands({ ...BASE, url, displayName: name, systemd });
    expect(command).toBe(expectedLines(url, "/etc/otelcol", name, systemd));
    // The bearer on its one line; no -L (a redirect would carry the secret elsewhere), no bash -c, no set -e.
    expect(command.split("\n").filter((line) => line.includes(BEARER))).toEqual([`export OPAMP_TOKEN='Bearer ${BEARER}' &&`]);
    expect(command.split("\n").filter((line) => line.includes(SECRET))).toHaveLength(1);
    expect(command).not.toMatch(/ -L\b|--location|bash -c|set -e|--now|\btee\b/);
    // A subshell: `(` alone first, `)` closing the last command's line, never alone; no unset.
    const lines = command.split("\n");
    expect(lines[0]).toBe("(");
    expect(lines[1]).toBe(`export OPAMP_TOKEN='Bearer ${BEARER}' &&`);
    expect(lines.at(-1)).toBe(
      systemd
        ? `sudo systemctl daemon-reload && sudo systemctl enable ${QUICK_DEPLOY_UNIT_NAME} && sudo systemctl restart ${QUICK_DEPLOY_UNIT_NAME} )`
        : `cd '/etc/otelcol' && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh${name === "" ? "" : ` --OPAMP_SERVER_NAME='${name}'`} )`,
    );
    expect(lines).not.toContain(")");
    expect(command).not.toContain("unset");
    // One `(` and one `)` in the whole command: the subshell's.
    expect(command.match(/\(/g)).toHaveLength(1);
    expect(command.match(/\)/g)).toHaveLength(1);
    // csh and tcsh read a paste line by line and run each line that parses: no line of the command may. Every
    // line, the unit's text (the heredoc's body and `UNIT`) aside, is the `(`, ends in a dangling ` &&`, or is
    // the last, its ` )` unbalanced there; so none is a command csh runs.
    const body = systemd ? [lines.indexOf(`sudo install -m 644 /dev/stdin ${QUICK_DEPLOY_UNIT_PATH} <<'UNIT' &&`) + 1, lines.indexOf("UNIT")] : [0, -1];
    expect(systemd ? body[0]! > 0 && body[1]! > body[0]! : true).toBe(true);
    lines.forEach((line, index) => {
      if (index >= body[0]! && index <= body[1]!) return;
      const opens = index === 0 && line === "(";
      const closes = index === lines.length - 1 && line.endsWith(" )");
      expect(opens || closes || line.endsWith(" &&"), `line ${index}`).toBe(true);
    });
    // curl's -q is honoured only as its first argument; --retry 3 retries only transient failures (never a 410 or 404).
    expect(command).toContain("| curl -q -g -fsS --retry 3");
  });

  it("is, foreground, this text exactly (a literal golden: https, a display name)", () => {
    expect(quickDeployCommands({ ...BASE, displayName: "edge one.2_b-c", systemd: false })).toBe(GOLDEN_FOREGROUND);
  });

  it("is, as a systemd service, this text exactly (a literal golden: development's http link, a display name, the root's trailing /)", () => {
    expect(quickDeployCommands({ ...BASE, url: HTTP_URL, rootPath: "/opt/telflo/", displayName: "prod east-1", systemd: true })).toBe(GOLDEN_SYSTEMD);
  });

  it("removes the root path's trailing / (every run of them)", () => {
    expect(quickDeployCommands({ ...BASE, rootPath: "/opt/telflo//", systemd: false })).toBe(expectedLines(HTTPS_URL, "/opt/telflo", "", false));
    expect(quickDeployCommands({ ...BASE, rootPath: "/opt/telflo/" })).toBe(expectedLines(HTTPS_URL, "/opt/telflo", "", true));
  });

  it("is the unit's text exactly (the name on ExecStart so a restart keeps it)", () => {
    expect(QUICK_DEPLOY_UNIT_NAME).toBe("telflo-supervisor.service");
    expect(QUICK_DEPLOY_UNIT_PATH).toBe("/etc/systemd/system/telflo-supervisor.service");
    expect(quickDeployUnit("/etc/otelcol/", "")).toBe(
      "[Unit]\nDescription=Telflo OpAMP Supervisor\nWants=network-online.target\nAfter=network-online.target\n\n" +
        "[Service]\nType=simple\nWorkingDirectory=/etc/otelcol\nExecStart=/etc/otelcol/start_supervisor.sh\nRestart=always\nRestartSec=5\n\n" +
        "[Install]\nWantedBy=multi-user.target",
    );
    expect(quickDeployUnit("/opt/telflo-edge_1.x", "prod east-1")).toBe(UNIT("/opt/telflo-edge_1.x", "prod east-1"));
    expect(quickDeployUnit("/opt/telflo-edge_1.x", "prod east-1")).toContain(
      'ExecStart=/opt/telflo-edge_1.x/start_supervisor.sh "--OPAMP_SERVER_NAME=prod east-1"',
    );
  });
});

describe("quickDeployCommands through real shells (harmless fakes on PATH)", () => {
  it.each(COMBINATIONS)("hands each program its words whole, the secrets on no argv (systemd $systemd, name $name, $url)", ({ systemd, name, url }) => {
    const root = "/opt/telflo-edge_1.x/a-b";
    const command = quickDeployCommands({ ...BASE, url, rootPath: `${root}/`, displayName: name, systemd });
    const proto = url.startsWith("https://") ? ["--proto", "=https"] : [];
    const download = [
      ["sudo", "mkdir", "-p", root],
      ["mkdir", "-p", root],
      ["curl", "-q", "-g", "-fsS", "--retry", "3", ...proto, "-K", "-"],
      [`stdin:url = "${url}"\n`],
      ["sudo", "tar", "-xzf", "-", "-C", root],
      ["tar", "-xzf", "-", "-C", root],
      ["stdin:ARCHIVE"],
    ];
    const rest = systemd
      ? [
          ["sudo", "install", "-m", "600", "/dev/stdin", `${root}/opamp.env`],
          ["install", "-m", "600", "/dev/stdin", `${root}/opamp.env`],
          // The start script's own format, from the shell's environment: one line.
          [`stdin:OPAMP_TOKEN='Bearer ${BEARER}'\n`],
          ["sudo", "install", "-m", "644", "/dev/stdin", QUICK_DEPLOY_UNIT_PATH],
          ["install", "-m", "644", "/dev/stdin", QUICK_DEPLOY_UNIT_PATH],
          [`stdin:${UNIT(root, name)}\n`],
          ["sudo", "systemctl", "daemon-reload"],
          ["systemctl", "daemon-reload"],
          ["sudo", "systemctl", "enable", QUICK_DEPLOY_UNIT_NAME],
          ["systemctl", "enable", QUICK_DEPLOY_UNIT_NAME],
          ["sudo", "systemctl", "restart", QUICK_DEPLOY_UNIT_NAME],
          ["systemctl", "restart", QUICK_DEPLOY_UNIT_NAME],
        ]
      : [
          ["cd", root],
          ["sudo", "--preserve-env=OPAMP_TOKEN", "./start_supervisor.sh", ...(name === "" ? [] : [`--OPAMP_SERVER_NAME=${name}`])],
          // The start script is handed the token through the environment.
          [`token:Bearer ${BEARER}`],
        ];
    // The token never in the parent shell (in the foreground, after the start script returned too).
    const after = [["after:unset"]];
    for (const shell of SHELLS) {
      const { calls, status } = run(command, shell);
      expect(status, shell).toBe(0);
      expect(calls, shell).toEqual([...download, ...rest, ...after]);
      // printf is each shell's builtin (the fake never ran), so neither secret was ever a process's argument.
      for (const argv of argvsOf(calls)) {
        expect(argv.join(" "), shell).not.toContain(BEARER);
        expect(argv.join(" "), shell).not.toContain(SECRET);
      }
    }
  });

  it.each([false, true])("stops at a refused download, exiting with tar's 2: nothing after the unpack runs, the token not in the parent shell (systemd %s)", (systemd) => {
    const command = quickDeployCommands({ ...BASE, systemd });
    for (const shell of SHELLS) {
      const { calls, status } = run(command, shell, { CURL_FAILS: "1" });
      // The paste's status is the chain's (the subshell's): an Ansible `shell:` task sees the failure.
      expect(status, shell).toBe(2);
      // No opamp.env written, no unit, no restart of an earlier install, no start script; the bearer gone from the shell.
      expect(calls.map((call) => call[0]), shell).toEqual(["sudo", "mkdir", "curl", `stdin:url = "${HTTPS_URL}"\n`, "sudo", "tar", "after:unset"]);
    }
  });

  it.each([false, true])("hands curl a bracketed IPv6 base's url line whole, with -g (systemd %s)", (systemd) => {
    const url = `http://[::1]:18080/api/v1/quick-deploy/${SECRET}`;
    const command = quickDeployCommands({ ...BASE, url, systemd });
    expect(command).toContain(`printf 'url = "%s"\\n' '${url}' | curl -q -g -fsS --retry 3 -K - |`);
    for (const shell of SHELLS) {
      const { calls, status } = run(command, shell);
      expect(status, shell).toBe(0);
      expect(calls.slice(2, 4), shell).toEqual([["curl", "-q", "-g", "-fsS", "--retry", "3", "-K", "-"], [`stdin:url = "${url}"\n`]]);
      expect(calls.at(-1), shell).toEqual(["after:unset"]);
    }
  });

  it("single-quotes once: a quote, $(…), backticks, variables, globs, ~ and a backslash reach the program whole", () => {
    // The command's own values never hold these (the backstops below); this is the quoting every value goes through.
    const probe = `it's $(echo EXPANDED) \`echo EXPANDED\` \${HOME} $HOME * ? ~ "q" \\n ''`;
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    for (const shell of SHELLS) {
      const { calls, status } = run(`probe ${shellQuote(probe)} ${shellQuote("")}`, shell);
      expect(status, shell).toBe(0);
      expect(calls, shell).toEqual([["probe", probe, ""], ["after:unset"]]);
    }
  });
});

describe("quickDeployCommands' backstops (throw: a broken contract, never written into a root's command)", () => {
  it.each([
    ["a bearer with a quote", { bearer: "QQ'==" }, "The bearer isn't one the opamp-server seals."],
    ["a bearer with $(…)", { bearer: "$(echo EXPANDED)" }, "The bearer isn't one the opamp-server seals."],
    ["a bearer with a space", { bearer: "QQ QQ" }, "The bearer isn't one the opamp-server seals."],
    ["a base64url bearer", { bearer: "QQ_-QQ" }, "The bearer isn't one the opamp-server seals."],
    ["an empty bearer", { bearer: "" }, "The bearer isn't one the opamp-server seals."],
    ["a bearer with Bearer in it", { bearer: `Bearer ${BEARER}` }, "The bearer isn't one the opamp-server seals."],
    ["a link that isn't one", { url: "https://h/api/v1/quick-deploy/abc" }, "The install link isn't one the API makes."],
    ["a link with a quote", { url: `https://h/it's/api/v1/quick-deploy/${SECRET}` }, "The install link isn't one the API makes."],
    ["a link with $(…)", { url: `https://h/$(echo EXPANDED)/api/v1/quick-deploy/${SECRET}` }, "The install link isn't one the API makes."],
    ["a link with a query", { url: `${HTTPS_URL}?x=1` }, "The install link isn't one the API makes."],
    ["a link with a user", { url: `https://a@h/api/v1/quick-deploy/${SECRET}` }, "The install link isn't one the API makes."],
    ["a link on a line of its own", { url: `${HTTPS_URL}\n` }, "The install link isn't one the API makes."],
    ["a root path with a space", { rootPath: "/opt/my dir" }, "The root path isn't one an install takes."],
    ["a root path with a quote", { rootPath: "/opt/it's" }, "The root path isn't one an install takes."],
    ["a root path with $(…)", { rootPath: "/opt/$(echo EXPANDED)" }, "The root path isn't one an install takes."],
    ["a root path with a %", { rootPath: "/opt/%h" }, "The root path isn't one an install takes."],
    ["a relative root path", { rootPath: "opt" }, "The root path isn't one an install takes."],
    ["the root", { rootPath: "/" }, "The root path isn't one an install takes."],
    ["a .. segment", { rootPath: "/opt/../etc" }, "The root path isn't one an install takes."],
    ["a display name with a quote", { displayName: "it's" }, "The display name isn't one an install takes."],
    ["a display name with a double quote", { displayName: 'a"b' }, "The display name isn't one an install takes."],
    ["a display name with $(…)", { displayName: "$(echo EXPANDED)" }, "The display name isn't one an install takes."],
    ["a display name with a %", { displayName: "a%Hb" }, "The display name isn't one an install takes."],
    ["an untrimmed display name", { displayName: " edge" }, "The display name isn't one an install takes."],
    ["a display name of 81 characters", { displayName: "a".repeat(81) }, "The display name isn't one an install takes."],
  ])("refuses %s", (_what, change, message) => {
    for (const systemd of [false, true]) {
      expect(() => quickDeployCommands({ ...BASE, systemd, ...change })).toThrow(message);
      if (!("bearer" in change)) {
        const { bearer: _bearer, ...parts } = { ...BASE, systemd, ...change };
        expect(() => quickDeployPreview(parts)).toThrow(message);
      }
    }
  });

  it("refuses a bad root path or display name in the unit too", () => {
    expect(() => quickDeployUnit("/opt/my dir", "")).toThrow("The root path isn't one an install takes.");
    expect(() => quickDeployUnit("/etc/otelcol", "a%b")).toThrow("The display name isn't one an install takes.");
  });
});

describe("quickDeployPreview: neither the bearer nor the link's secret", () => {
  it.each(COMBINATIONS)("is the command with both masked (systemd $systemd, name $name, $url)", ({ systemd, name, url }) => {
    const preview = quickDeployPreview({ url, rootPath: "/etc/otelcol", displayName: name, systemd });
    const maskedUrl = `${url.slice(0, url.length - SECRET.length)}${QUICK_DEPLOY_MASKED_SECRET}`;
    expect(INSTALL_MASKED_TOKEN).toBe("••••••••••••••••");
    expect(QUICK_DEPLOY_MASKED_SECRET).toBe("tqd_••••••••");
    expect(preview).toBe(expectedLines(maskedUrl, "/etc/otelcol", name, systemd, INSTALL_MASKED_TOKEN));
    expect(preview).not.toContain(SECRET);
    expect(preview).not.toMatch(/tqd_[A-Za-z0-9_-]/);
    expect(preview).toContain(`'${maskedUrl}'`);
    // The base is kept: the proto flag follows the real link's scheme.
    expect(preview.includes("--proto '=https'")).toBe(url.startsWith("https://"));
  });

  it("takes no bearer: one passed in is a type error, and holds none", () => {
    // @ts-expect-error the preview has no bearer to take
    const preview = quickDeployPreview({ url: HTTPS_URL, rootPath: "/etc/otelcol", displayName: "", systemd: true, bearer: BEARER });
    expect(preview).not.toContain(BEARER);
    expect(preview).toContain(`'Bearer ${INSTALL_MASKED_TOKEN}'`);
  });
});
