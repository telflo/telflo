// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as contracts from "@telflo/contracts";
import type { DockerMount } from "@telflo/contracts";
import {
  DISPLAY_NAME_RULE,
  MASKED_TOKEN,
  absolutePathProblem,
  containerCommand,
  containerPreview,
  displayNameProblem,
  envValueProblem,
  linuxRunCommands,
  quickDeployCommands,
  quickDeployPreview,
  quickDeployUnit,
  shellQuote,
  type ContainerCommandParts,
} from "./install.js";

// The install commands.
//
// `argvOf` runs a command in a real bash with `docker`, `sudo` and `cd`
// replaced by functions that print their arguments, each ended by U+001E
// and a line break, so the test sees the words bash would hand docker:
// nothing expanded, nothing split. Every probe in a value is harmless
// (`$(echo EXPANDED)`, never a command with an effect), and the shell has
// no profile, a PATH of the system's directories and a HOME that doesn't
// exist.
function argvOf(script: string, prelude: string): string[] {
  const out = execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", `${prelude}\n${script}`], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  });
  return out.split("\u001e\n").slice(0, -1);
}
const DOCKER = `docker() { for a in "$@"; do printf '%s\\036\\n' "$a"; done; }`;

/** A value no shell may expand or split: every probe harmless. */
const PROBE = `it's $(echo EXPANDED) \`echo EXPANDED\` \${HOME} $HOME * ? [a] ~ \\ "q" #x`;

const BEARER = "tfd_canary-bearer-QmVhcmVy+/=";

const FACTS: ContainerCommandParts["facts"] = {
  imageTag: "ghcr.io/telflo/telflo/collector:0.162.0",
  endpoint: "wss://opamp.example.com/v1/opamp",
  allowInsecureConnections: false,
  groupId: "3d4e5f60-7182-4394-aa5b-6c7d8e9fa0b1",
  mounts: [],
};

const MOUNTS: DockerMount[] = [
  { hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true },
  { hostPath: "/data", containerPath: "/var/lib/otelcol", readOnly: false },
];

describe("containerCommand", () => {
  it("is the exact command, one flag a line, every value quoted once, no bash -c", () => {
    const command = containerCommand({
      facts: { ...FACTS, mounts: [MOUNTS[0]!] },
      bearer: BEARER,
      displayName: "prod-collector-east-1",
      env: [{ name: "NGINX_ENV", value: "staging" }],
    });
    expect(command).toBe(
      [
        "docker run -d --restart unless-stopped --name telflo-collector \\",
        "  -v telflo-opamp:/app/opamp \\",
        "  -v '/var/log/nginx:/var/log/nginx:ro' \\",
        "  -e COLLECTOR_GROUP_ID='3d4e5f60-7182-4394-aa5b-6c7d8e9fa0b1' \\",
        "  -e OPAMP_ENDPOINT='wss://opamp.example.com/v1/opamp' \\",
        "  -e OPAMP_ALLOW_INSECURE_CONNECTIONS='false' \\",
        "  -e OPAMP_SERVER_NAME='prod-collector-east-1' \\",
        `  -e OPAMP_TOKEN='${BEARER}' \\`,
        "  -e NGINX_ENV='staging' \\",
        "  'ghcr.io/telflo/telflo/collector:0.162.0'",
      ].join("\n"),
    );
    expect(command).not.toContain("bash");
  });

  // Every combination of the optional parts: each line present exactly when its part is, in a fixed order.
  const COMBINATIONS = [false, true].flatMap((mounts) =>
    [false, true].flatMap((name) =>
      [false, true].flatMap((variables) => [false, true].map((insecure) => ({ mounts, name, variables, insecure }))),
    ),
  );
  it.each(COMBINATIONS)("has the lines for mounts $mounts, a name $name, variables $variables, insecure $insecure", ({ mounts, name, variables, insecure }) => {
    const command = containerCommand({
      facts: { ...FACTS, allowInsecureConnections: insecure, mounts: mounts ? MOUNTS : [] },
      bearer: BEARER,
      displayName: name ? "edge one" : "",
      env: variables ? [{ name: "NGINX_ENV", value: "staging" }, { name: "_API_KEY2", value: "k" }] : [],
    });
    const expected = [
      "docker run -d --restart unless-stopped --name telflo-collector",
      "-v telflo-opamp:/app/opamp",
      ...(mounts ? ["-v '/var/log/nginx:/var/log/nginx:ro'", "-v '/data:/var/lib/otelcol'"] : []),
      `-e COLLECTOR_GROUP_ID='${FACTS.groupId}'`,
      `-e OPAMP_ENDPOINT='${FACTS.endpoint}'`,
      `-e OPAMP_ALLOW_INSECURE_CONNECTIONS='${insecure ? "true" : "false"}'`,
      ...(name ? ["-e OPAMP_SERVER_NAME='edge one'"] : []),
      `-e OPAMP_TOKEN='${BEARER}'`,
      ...(variables ? ["-e NGINX_ENV='staging'", "-e _API_KEY2='k'"] : []),
      `'${FACTS.imageTag}'`,
    ];
    const lines = command.split("\n");
    expect(lines.map((line) => line.replace(/^ {2}/, "").replace(/ \\$/, ""))).toEqual(expected);
    // Every line but the last continues; every line but the first is indented two spaces.
    expect(lines.slice(0, -1).every((line) => line.endsWith(" \\"))).toBe(true);
    expect(lines.at(-1)!.endsWith("\\")).toBe(false);
    expect(lines.slice(1).every((line) => line.startsWith("  -") || line.startsWith("  '"))).toBe(true);
    // The bearer is on its one line only.
    expect(lines.filter((line) => line.includes(BEARER))).toEqual([`  -e OPAMP_TOKEN='${BEARER}' \\`]);
  });

  it("writes a ' as '\\'' in every value: the bearer, the name, a value, the image and the endpoint", () => {
    const command = containerCommand({
      facts: { ...FACTS, imageTag: "a'b", endpoint: "wss://x/'y" },
      bearer: "tok'en",
      displayName: "it's",
      env: [{ name: "V", value: "'quoted'" }],
    });
    expect(command).toContain(`-e OPAMP_TOKEN='tok'\\''en'`);
    expect(command).toContain(`-e OPAMP_SERVER_NAME='it'\\''s'`);
    expect(command).toContain(`-e V=''\\''quoted'\\'''`);
    expect(command).toContain(`-e OPAMP_ENDPOINT='wss://x/'\\''y'`);
    expect(command.endsWith(`'a'\\''b'`)).toBe(true);
  });

  it("hands docker each value whole, as typed: quotes, spaces, $(…), backticks, variables, globs, ~, \\ and # never expand", () => {
    const command = containerCommand({
      facts: { ...FACTS, mounts: [MOUNTS[0]!] },
      bearer: "tok'en",
      displayName: "a b.c_d-e",
      env: [{ name: "SECRET", value: PROBE }],
    });
    const argv = argvOf(command, DOCKER);
    expect(argv).toEqual([
      "run", "-d", "--restart", "unless-stopped", "--name", "telflo-collector",
      "-v", "telflo-opamp:/app/opamp",
      "-v", "/var/log/nginx:/var/log/nginx:ro",
      "-e", `COLLECTOR_GROUP_ID=${FACTS.groupId}`,
      "-e", `OPAMP_ENDPOINT=${FACTS.endpoint}`,
      "-e", "OPAMP_ALLOW_INSECURE_CONNECTIONS=false",
      "-e", "OPAMP_SERVER_NAME=a b.c_d-e",
      "-e", "OPAMP_TOKEN=tok'en",
      "-e", `SECRET=${PROBE}`,
      FACTS.imageTag,
    ]);
  });

  it("refuses a variable name that isn't a shell name (a broken contract), never writing it", () => {
    for (const name of ["A;id", "1A", "A B", "$(echo EXPANDED)", ""]) {
      expect(() => containerCommand({ facts: FACTS, bearer: "b", displayName: "", env: [{ name, value: "x" }] })).toThrow(
        "An environment variable's name isn't a shell name.",
      );
    }
  });
});

describe("containerCommand's backstops", () => {
  it.each(["OPAMP_ENDPOINT", "OPAMP_TOKEN", "OPAMP_SERVER_NAME", "OPAMP_ALLOW_INSECURE_CONNECTIONS", "COLLECTOR_GROUP_ID"])(
    "refuses %s, a name the install sets itself (docker keeps the last -e: it would replace the install's own)",
    (name) => {
      expect(() => containerCommand({ facts: FACTS, bearer: BEARER, displayName: "", env: [{ name, value: "x" }] })).toThrow(
        "An environment variable's name is one the install sets itself.",
      );
    },
  );

  it("refuses a name given twice, never writing either", () => {
    expect(() =>
      containerCommand({
        facts: FACTS,
        bearer: BEARER,
        displayName: "",
        env: [
          { name: "NGINX_ENV", value: "a" },
          { name: "NGINX_ENV", value: "b" },
        ],
      }),
    ).toThrow("An environment variable is given twice.");
  });

  it("takes distinct names that aren't reserved, in the order given", () => {
    const command = containerCommand({
      facts: FACTS,
      bearer: BEARER,
      displayName: "",
      env: [
        { name: "B_VAR", value: "b" },
        { name: "A_VAR", value: "a" },
      ],
    });
    expect(command.indexOf("-e B_VAR='b'")).toBeLessThan(command.indexOf("-e A_VAR='a'"));
  });
});

describe("containerPreview: the masked preview never holds the bearer", () => {
  const parts = {
    facts: { ...FACTS, mounts: MOUNTS },
    displayName: "edge one",
    env: [{ name: "NGINX_ENV", value: "staging" }],
  };

  it("is the command with the token masked, sixteen bullets", () => {
    expect(MASKED_TOKEN).toBe("••••••••••••••••");
    const preview = containerPreview(parts);
    expect(preview).toBe(containerCommand({ ...parts, bearer: MASKED_TOKEN }));
    expect(preview.split("\n").filter((line) => line.includes("OPAMP_TOKEN"))).toEqual([`  -e OPAMP_TOKEN='${MASKED_TOKEN}' \\`]);
  });

  it("takes no bearer: one passed in is a type error, and dropped", () => {
    // @ts-expect-error the preview has no bearer to take
    const preview = containerPreview({ ...parts, bearer: BEARER });
    expect(preview).not.toContain(BEARER);
    expect(preview).not.toContain("tfd_");
    expect(preview).toBe(containerPreview(parts));
  });
});

describe("linuxRunCommands", () => {
  it("is four exact lines, the bearer in the first only", () => {
    const lines = linuxRunCommands({ method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", bearer: BEARER, displayName: "edge one" });
    expect(lines).toBe(
      [
        `export OPAMP_TOKEN='Bearer ${BEARER}'`,
        "sudo mkdir -p '/etc/otelcol'",
        "sudo tar -xzf telflo-collector-all-in-one-amd64.tar.gz -C '/etc/otelcol'",
        "cd '/etc/otelcol' && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh --OPAMP_SERVER_NAME='edge one'",
      ].join("\n"),
    );
    expect(lines.split("\n").filter((line) => line.includes(BEARER))).toHaveLength(1);
  });

  it("drops the flag with no name, names the bundle by its method and arch, and removes the root's trailing /", () => {
    const lines = linuxRunCommands({ method: "own-binary", arch: "arm64", rootPath: "/opt/telflo//", bearer: "B", displayName: "" });
    expect(lines).not.toContain("OPAMP_SERVER_NAME");
    expect(lines).toContain("sudo tar -xzf telflo-collector-own-binary-arm64.tar.gz -C '/opt/telflo'");
    expect(lines.split("\n").at(-1)).toBe("cd '/opt/telflo' && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh");
  });

  it("hands sudo one --OPAMP_SERVER_NAME=… word, and the script the token exported whole", () => {
    const script = linuxRunCommands({ method: "own-binary", arch: "arm64", rootPath: "/opt/x", bearer: `it's ${PROBE}`, displayName: "a b" });
    const prelude = [
      `sudo() { for a in "$@"; do printf '%s\\036\\n' "$a"; done; printf 'TOKEN=%s\\036\\n' "$OPAMP_TOKEN"; }`,
      `cd() { printf 'cd %s\\036\\n' "$1"; }`,
    ].join("\n");
    const token = `TOKEN=Bearer it's ${PROBE}`;
    expect(argvOf(script, prelude)).toEqual([
      "mkdir", "-p", "/opt/x", token,
      "tar", "-xzf", "telflo-collector-own-binary-arm64.tar.gz", "-C", "/opt/x", token,
      "cd /opt/x",
      "--preserve-env=OPAMP_TOKEN", "./start_supervisor.sh", "--OPAMP_SERVER_NAME=a b", token,
    ]);
  });
});

describe("the fields' rules", () => {
  it.each([
    ["", null],
    ["   ", null],
    ["prod-collector-east-1", null],
    ["  a b.c_d-e  ", null],
    ["x".repeat(80), null],
    [` ${"x".repeat(80)} `, null],
    ["x".repeat(81), "At most 80 characters."],
    ["it's", DISPLAY_NAME_RULE],
    ["$(echo EXPANDED)", DISPLAY_NAME_RULE],
    ["a\"b", DISPLAY_NAME_RULE],
    ["é", DISPLAY_NAME_RULE],
    ["a\tb", DISPLAY_NAME_RULE],
  ])("display name %j: %s", (raw, problem) => expect(displayNameProblem(raw)).toBe(problem));

  it("says the display name's rule in its exact words", () => {
    expect(DISPLAY_NAME_RULE).toBe("Use letters, digits, spaces, dots, dashes and underscores.");
  });

  it.each([
    ["", "Type a value or untick it."],
    ["  ", "Type a value or untick it."],
    ["v", null],
    ["  v  ", null],
    ["x".repeat(4096), null],
    [` ${"x".repeat(4096)} `, null],
    ["x".repeat(4097), "At most 4,096 characters."],
    ["a\tb", "Use no control characters (a line break or a tab, say)."],
    ["a\nb", "Use no control characters (a line break or a tab, say)."],
    ["a\u0085b", "Use no control characters (a line break or a tab, say)."],
    [PROBE, null],
  ])("env value %j: %s", (value, problem) => expect(envValueProblem(value)).toBe(problem));

  it.each([
    ["/etc/otelcol", null],
    ["/etc/otelcol/", null],
    ["/usr/bin/otelcol-contrib", null],
    ["", "Type a path."],
    ["etc/otelcol", "Use an absolute path, starting with /."],
    ["/", "Use a directory, not the root."],
    ["/etc/../root", "Use no . or .. segment."],
    ["/etc/./x", "Use no . or .. segment."],
    ["/my dir", "Use letters, digits, dots, dashes, underscores and /."],
    ["/a'b", "Use letters, digits, dots, dashes, underscores and /."],
    ["/$(echo EXPANDED)", "Use letters, digits, dots, dashes, underscores and /."],
    [`/${"x".repeat(200)}`, "At most 200 characters."],
  ])("path %j: %s", (raw, problem) => expect(absolutePathProblem(raw)).toBe(problem));

  it("quotes as POSIX does", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("''")).toBe(`''\\'''\\'''`);
  });
});

describe("the Quick Deploy command", () => {
  it("is the contracts' builder, its preview and its unit, the very ones the stack's smoke prints; the shared pieces the contracts' too", () => {
    // Its lines, through real bash, sh, dash and zsh: packages/contracts/src/quick-deploy-command.test.ts.
    expect(quickDeployCommands).toBe(contracts.quickDeployCommands);
    expect(quickDeployPreview).toBe(contracts.quickDeployPreview);
    expect(quickDeployUnit).toBe(contracts.quickDeployUnit);
    expect(shellQuote).toBe(contracts.shellQuote);
    expect(displayNameProblem).toBe(contracts.installDisplayNameProblem);
    expect(MASKED_TOKEN).toBe(contracts.INSTALL_MASKED_TOKEN);
  });
});
