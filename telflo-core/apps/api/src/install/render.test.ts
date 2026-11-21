import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { InstallMethod } from "@telflo/contracts";
import {
  bundleValues,
  envExports,
  InstallRenderError,
  METHOD_PLACEHOLDERS,
  PLACEHOLDER_PATTERN,
  renderTemplate,
  supervisorVersionCases,
  templateProblem,
  yamlQuoted,
  type BundleInputs,
} from "./render.js";
import { createInstallTemplateLoader } from "./templates.js";

// The repository's templates rendered from validated values only, each value
// encoded for where it lands; the scripts' shell quoting checked by running
// bash (/bin/bash: 3.2 on a Mac) with harmless probes only
// (`$(echo EXPANDED)`), never a command with an effect.

const REPOSITORY_TEMPLATES = fileURLToPath(new URL("../../../../../install-templates", import.meta.url));
const BASH = "/bin/bash";
/** The archive check: nothing a placeholder could still be. */
const LEFTOVER = /\$\{[A-Z_][A-Z0-9_]*\}/;

const GROUP_ID = "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f";
const RELEASES = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download";
const sha = (digit: string) => digit.repeat(64);
const contrib = (version: string, arch: string) => ({
  downloadUrl: `${RELEASES}/v${version}/otelcol-contrib_${version}_linux_${arch}.tar.gz`,
  sha256: sha("a"),
});
const supervisor = (version: string, arch: string) => ({
  downloadUrl: `${RELEASES}/cmd%2Fopampsupervisor%2Fv${version}/opampsupervisor_${version}_linux_${arch}`,
  sha256: sha("b"),
});

function inputs(method: InstallMethod, overrides: Partial<BundleInputs> = {}): BundleInputs {
  return {
    method,
    arch: "amd64",
    endpoint: "https://opamp.telflo.example/v1/opamp",
    allowInsecureConnections: false,
    groupId: GROUP_ID,
    rootPath: "/etc/otelcol",
    ...(method === "own-binary" ? { executablePath: "/usr/bin/otelcol-contrib" } : {}),
    env: [],
    collectorVersion: "0.162.0",
    otelcolContrib: contrib("0.162.0", "amd64"),
    opampSupervisor: supervisor("0.162.0", "amd64"),
    offeredSupervisors:
      method === "own-binary"
        ? ["0.162.0", "0.161.0", "0.160.0"].map((version) => ({ version, opampSupervisor: supervisor(version, "amd64") }))
        : [],
    ...overrides,
  };
}

/** The repository's templates of `method`, rendered: each file's name and text. */
async function rendered(method: InstallMethod, overrides: Partial<BundleInputs> = {}): Promise<Map<string, string>> {
  const files = await createInstallTemplateLoader(REPOSITORY_TEMPLATES).load(method);
  const values = bundleValues(inputs(method, overrides));
  return new Map(files.map((file) => [file.name, renderTemplate(file.name, file.text, values)]));
}

const fileOf = (files: Map<string, string>, name: string) => {
  const text = files.get(name);
  if (text === undefined) throw new Error(`no ${name}`);
  return text;
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "install-render-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the repository's templates", () => {
  it.each(["all-in-one", "own-binary"] as const)("%s: four files, every placeholder filled, nothing left a placeholder could be", async (method) => {
    const files = await rendered(method);
    expect([...files.keys()]).toEqual(["README.md", "otelcol-config.yaml", "start_supervisor.sh", "supervisor-config.yaml"]);
    for (const [name, text] of files) expect({ name, leftover: LEFTOVER.exec(text)?.[0] ?? null }).toEqual({ name, leftover: null });
    // The scripts' and the YAML's own references pass through.
    expect(fileOf(files, "start_supervisor.sh")).toContain("${OPAMP_TOKEN:-}");
    // The token is the host's to write (start_supervisor.sh): the bundle holds none.
    expect(fileOf(files, "supervisor-config.yaml")).toContain('Authorization: ""');
    expect(fileOf(files, "supervisor-config.yaml")).not.toContain("env:OPAMP_TOKEN");
  });

  it.each(["all-in-one", "own-binary"] as const)("%s: every placeholder a template names is one of its method's", async (method) => {
    const files = await createInstallTemplateLoader(REPOSITORY_TEMPLATES).load(method);
    const named = new Set(files.flatMap((file) => [...file.text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1])));
    for (const name of named) expect(Object.keys(METHOD_PLACEHOLDERS[method])).toContain(name);
  });

  it("no template says deploy or deployment", async () => {
    for (const method of ["all-in-one", "own-binary"] as const) {
      for (const file of await createInstallTemplateLoader(REPOSITORY_TEMPLATES).load(method)) {
        expect({ file: file.name, deploy: /deploy/i.test(file.text) }).toEqual({ file: file.name, deploy: false });
      }
    }
  });

  it("no template keeps reports_remote_config (deprecated at 0.161, refused from 0.163)", async () => {
    for (const method of ["all-in-one", "own-binary"] as const) {
      for (const file of await createInstallTemplateLoader(REPOSITORY_TEMPLATES).load(method)) expect(file.text).not.toContain("reports_remote_config");
    }
  });

  it("All In One's supervisor configuration parses, each value typed as the supervisor reads it", async () => {
    const config = parse(fileOf(await rendered("all-in-one", { allowInsecureConnections: true, rootPath: "/opt/telflo" }), "supervisor-config.yaml"));
    expect(config.server.endpoint).toBe("https://opamp.telflo.example/v1/opamp");
    expect(config.server.headers.Authorization).toBe("");
    expect(config.server.tls).toEqual({ insecure_skip_verify: true, insecure: true });
    expect(config.agent.executable).toBe("/opt/telflo/otelcol-contrib");
    expect(config.agent.config_files).toEqual(["/opt/telflo/otelcol-config.yaml"]);
    expect(config.agent.description.non_identifying_attributes).toEqual({ "telflo.collector_group_id": GROUP_ID, "host.ip": "" });
    expect(config.storage.directory).toBe("/opt/telflo/opamp");
    expect(config.capabilities).not.toHaveProperty("reports_remote_config");
  });

  it("own-binary's supervisor configuration names the host's collector and the root's paths", async () => {
    const config = parse(
      fileOf(await rendered("own-binary", { rootPath: "/srv/otel", executablePath: "/opt/bin/otelcol-contrib" }), "supervisor-config.yaml"),
    );
    expect(config.server.tls).toEqual({ insecure_skip_verify: false, insecure: false });
    expect(config.agent.executable).toBe("/opt/bin/otelcol-contrib");
    expect(config.agent.config_files).toEqual(["/srv/otel/otelcol-config.yaml"]);
    expect(config.storage.directory).toBe("/srv/otel/opamp");
    expect(config.agent.description.non_identifying_attributes["telflo.collector_group_id"]).toBe(GROUP_ID);
  });

  it.each(["all-in-one", "own-binary"] as const)("%s: the script is valid bash, its values single-quoted words", async (method) => {
    const script = fileOf(await rendered(method), "start_supervisor.sh");
    const file = join(directory, "start_supervisor.sh");
    await writeFile(file, script);
    expect(spawnSync(BASH, ["-n", file]).status).toBe(0);
    if (method === "all-in-one") {
      expect(script).toContain("root_path='/etc/otelcol'\n");
      expect(script).toContain(`otelcol_contrib_url='${contrib("0.162.0", "amd64").downloadUrl}'\n`);
      expect(script).toContain(`otelcol_contrib_sha256='${sha("a")}'\n`);
    } else {
      expect(script).toContain("executable_path='/usr/bin/otelcol-contrib'\n");
      expect(script).toContain("default_supervisor_version='0.162.0'\n");
    }
    expect(script).toContain(`supervisor_url='${supervisor("0.162.0", "amd64").downloadUrl}'\n`);
  });

  it("the README names the arch, the version and the root path as they are", async () => {
    const readme = fileOf(await rendered("all-in-one", { arch: "arm64", otelcolContrib: contrib("0.162.0", "arm64"), opampSupervisor: supervisor("0.162.0", "arm64") }), "README.md");
    expect(readme).toContain("(linux arm64)");
    expect(readme).toContain("v0.162.0\n(`linux_arm64`)");
    expect(readme).toContain("`/etc/otelcol`");
  });

  it("the configuration's variables are exported after the downloads, just before the supervisor starts", async () => {
    const script = fileOf(await rendered("all-in-one", { env: [{ name: "NGINX_ENV", value: "prod" }] }), "start_supervisor.sh");
    const exported = script.indexOf("export NGINX_ENV='prod'");
    expect(exported).toBeGreaterThan(script.lastIndexOf("curl -fsSL"));
    expect(exported).toBeLessThan(script.indexOf('exec "$root_path/supervisor"'));
  });

  it.each(["all-in-one", "own-binary"] as const)("%s: both host-address lines end || true (a host without ip doesn't stop the script)", async (method) => {
    const script = fileOf(await rendered(method), "start_supervisor.sh");
    expect(script).toMatch(/print \$\(i\+1\); exit \}\}' \|\| true\)"/);
    expect(script).toMatch(/hostname -I 2>\/dev\/null \| awk '\{print \$1\}' \|\| true\)"/);
  });
});

describe("the configuration's variables (COLLECTOR_ENV_EXPORTS)", () => {
  const probes = [
    "it's",
    "two words",
    "$HOME",
    "$(echo EXPANDED)",
    "`echo EXPANDED`",
    'a"b',
    "back\\slash",
    "${ROOT_PATH}",
    "!history",
    "*",
    "'",
    "trailing\\",
    "café ☕",
  ];

  it("each value reaches bash exactly as typed: one single-quoted word, nothing expanded", async () => {
    const env = probes.map((value, index) => ({ name: `PROBE_${index}`, value }));
    const file = join(directory, "probe.sh");
    await writeFile(file, `${envExports(env)}\n${env.map(({ name }) => `printf '%s\\0' "$${name}"`).join("\n")}\n`);
    const output = execFileSync(BASH, [file], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home" } });
    expect(output.split("\0").slice(0, -1)).toEqual(probes);
  });

  it("is one pass: a value holding ${ROOT_PATH} stays text in the bundle", async () => {
    const script = fileOf(await rendered("all-in-one", { env: [{ name: "LITERAL", value: "${ROOT_PATH}" }] }), "start_supervisor.sh");
    expect(script).toContain("export LITERAL='${ROOT_PATH}'");
  });

  it("is empty with no variables", () => {
    expect(envExports([])).toBe("");
  });

  it.each([
    [{ name: "1BAD", value: "x" }],
    [{ name: "BAD-NAME", value: "x" }],
    [{ name: "OK", value: "" }],
    [{ name: "OK", value: "line\nbreak" }],
  ])("refuses a variable failing the contract's rule (%j)", (variable) => {
    expect(() => envExports([variable])).toThrow(InstallRenderError);
  });
});

describe("own-binary's supervisor table (SUPERVISOR_VERSION_CASES)", () => {
  async function chosen(cases: string, detected: string): Promise<string[]> {
    const file = join(directory, "cases.sh");
    await writeFile(
      file,
      [
        `detected_collector_version='${detected}'`,
        'case "$detected_collector_version" in',
        cases,
        "  *)",
        "    sup_ver=default; sup_url=default-url; sup_sha=default-sha",
        "    ;;",
        "esac",
        `printf '%s\\n' "$sup_ver" "$sup_url" "$sup_sha"`,
      ].join("\n"),
    );
    return execFileSync(BASH, [file], { encoding: "utf8" }).trim().split("\n");
  }

  const offered = ["0.162.0", "0.161.0"].map((version) => ({ version, opampSupervisor: supervisor(version, "arm64") }));

  it("picks the supervisor of the collector's version, else the last arm", async () => {
    const cases = supervisorVersionCases(offered);
    expect(await chosen(cases, "0.161.0")).toEqual(["0.161.0", supervisor("0.161.0", "arm64").downloadUrl, sha("b")]);
    expect(await chosen(cases, "0.150.0")).toEqual(["default", "default-url", "default-sha"]);
    expect(await chosen(cases, "")).toEqual(["default", "default-url", "default-sha"]);
  });

  it("is in the rendered script, one arm per offered version", async () => {
    const script = fileOf(await rendered("own-binary"), "start_supervisor.sh");
    for (const version of ["0.162.0", "0.161.0", "0.160.0"]) expect(script).toContain(`  '${version}')\n    sup_ver='${version}'\n`);
  });

  it("leaves to the last arm a version with no supervisor for the arch, or one failing the allow-lists", () => {
    expect(
      supervisorVersionCases([
        { version: "0.162.0", opampSupervisor: undefined },
        { version: "0.161.0; echo EXPANDED", opampSupervisor: supervisor("0.161.0", "arm64") },
        { version: "0.160.0", opampSupervisor: { downloadUrl: "https://evil.example/x", sha256: sha("c") } },
        { version: "0.159.0", opampSupervisor: { downloadUrl: supervisor("0.159.0", "arm64").downloadUrl, sha256: "deadbeef" } },
      ]),
    ).toBe("");
  });

  it("holds no placeholder of its own", () => {
    expect(supervisorVersionCases(offered)).not.toMatch(LEFTOVER);
  });
});

/** The render's refusal's source (the public download's log level follows it); any other throw fails. */
function refusedSource(render: () => unknown): string {
  try {
    render();
  } catch (error) {
    if (error instanceof InstallRenderError) return error.source;
    throw error;
  }
  throw new Error("the render didn't refuse");
}

describe("the values, checked before a script holds them", () => {
  // Each refusal's source: `choices` for what the install was asked for, `operator` for the rest.
  it.each([
    ["a relative root path", { rootPath: "etc/otelcol" }, "choices"],
    ["a .. segment", { rootPath: "/etc/../tmp" }, "choices"],
    ["a space", { rootPath: "/etc/otel col" }, "choices"],
    ["a quote", { rootPath: "/etc/otel'col" }, "choices"],
    ["a $", { rootPath: "/etc/$(echo EXPANDED)" }, "choices"],
    ["the root", { rootPath: "/" }, "choices"],
    ["a trailing / (the contract removes it)", { rootPath: "/etc/otelcol/" }, "choices"],
    ["an arch that isn't offered", { arch: "s390x" }, "choices"],
    ["a variable's value with a line break", { env: [{ name: "OK", value: "line\nbreak" }] }, "choices"],
    ["an executable path for All In One", { executablePath: "/usr/bin/otelcol-contrib" }, "choices"],
    ["an endpoint with a quote", { endpoint: "https://opamp.example/'x" }, "operator"],
    ["an endpoint with ${", { endpoint: "https://opamp.example/${ROOT_PATH}" }, "operator"],
    ["a group id that isn't a UUID", { groupId: "${env:OPAMP_TOKEN}" }, "operator"],
    ["a collector version that isn't major.minor.patch", { collectorVersion: "0.162.0; echo EXPANDED" }, "operator"],
    ["a binary from elsewhere", { otelcolContrib: { downloadUrl: "https://evil.example/otelcol", sha256: sha("a") } }, "operator"],
    ["a sha256 that isn't one", { opampSupervisor: { downloadUrl: supervisor("0.162.0", "amd64").downloadUrl, sha256: "ABC" } }, "operator"],
    ["no supervisor for the arch", { opampSupervisor: undefined }, "operator"],
    ["no collector for the arch", { otelcolContrib: undefined }, "operator"],
  ] as const)("refuses %s, naming whose the value is", (_case, overrides, source) => {
    expect(refusedSource(() => bundleValues(inputs("all-in-one", overrides as Partial<BundleInputs>)))).toBe(source);
  });

  it.each([
    ["no executable path", { executablePath: undefined }],
    ["a relative executable path", { executablePath: "bin/otelcol-contrib" }],
    ["an executable path with a quote", { executablePath: '/usr/bin/otel"col' }],
  ] as const)("own-binary refuses %s (the choices')", (_case, overrides) => {
    const given = { ...inputs("own-binary"), ...overrides } as BundleInputs;
    if (overrides.executablePath === undefined) delete given.executablePath;
    expect(refusedSource(() => bundleValues(given))).toBe("choices");
  });

  it.each(['a"b', "a\\b", "$HOME", "a\nb", "a\u2028b", "a\u0085b", "tab\there"])("never writes %j into YAML (the operator's)", (value) => {
    expect(refusedSource(() => yamlQuoted(value))).toBe("operator");
  });

  it("refuses a template line that no longer fits, or a known placeholder with no value (the operator's: the templates)", () => {
    const values = bundleValues(inputs("all-in-one"));
    expect(refusedSource(() => renderTemplate("start_supervisor.sh", "echo ${ROOT_PATH}", values))).toBe("operator");
    expect(refusedSource(() => renderTemplate("supervisor.yaml", "a: [${ROOT_PATH}]", values))).toBe("operator");
    expect(refusedSource(() => renderTemplate("README.md", "${EXECUTABLE_PATH}", values))).toBe("operator");
  });

  it("writes a plain value as one double-quoted scalar", () => {
    expect(yamlQuoted("/etc/otelcol")).toBe('"/etc/otelcol"');
    expect(parse(`a: ${yamlQuoted("2024")}\nb: ${yamlQuoted("true")}`)).toEqual({ a: "2024", b: "true" });
  });
});

describe("where a placeholder may stand (templateProblem)", () => {
  it.each([
    ["start_supervisor.sh", "root_path=${ROOT_PATH}\n"],
    ["start_supervisor.sh", "export config=${ROOT_PATH}/otelcol-config.yaml\n"],
    ["start_supervisor.sh", "${COLLECTOR_ENV_EXPORTS}\n"],
    ["start_supervisor.sh", "echo ${OPAMP_TOKEN:-} ${server_name} ${env:X}\n"],
    ["supervisor-config.yaml", "a:\n  b: ${OPAMP_ENDPOINT}\n  c:\n    - ${ROOT_PATH}/x.yaml\n  d: ${OPAMP_ALLOW_INSECURE_CONNECTIONS}\n"],
    ["README.md", "Install into `${ROOT_PATH}` on linux ${ARCH}.\n"],
  ])("takes %s's %j", (name, text) => {
    expect(templateProblem("all-in-one", name, text)).toBeNull();
  });

  it.each([
    ["an unknown placeholder", "start_supervisor.sh", "x=${NOT_KNOWN}\n", "a placeholder Telflo doesn't fill"],
    ["another method's", "start_supervisor.sh", "x=${EXECUTABLE_PATH}\n", "a placeholder Telflo doesn't fill"],
    ["a value inside double quotes", "start_supervisor.sh", 'mkdir -p "${ROOT_PATH}"\n', "a value not on the right of an assignment line"],
    ["a value in a command", "start_supervisor.sh", "echo ${ROOT_PATH}\n", "a value not on the right of an assignment line"],
    ["a value in a comment", "start_supervisor.sh", "# ${ROOT_PATH}\n", "a value not on the right of an assignment line"],
    ["a quoted assignment", "start_supervisor.sh", "x='${ROOT_PATH}'\n", "a value not on the right of an assignment line"],
    ["a block in a command", "start_supervisor.sh", "echo ${COLLECTOR_ENV_EXPORTS}\n", "a block of shell lines not alone on its line"],
    ["a block in YAML", "supervisor-config.yaml", "${COLLECTOR_ENV_EXPORTS}\n", "a block of shell lines outside a script"],
    ["a block in the README", "README.md", "${COLLECTOR_ENV_EXPORTS}\n", "a block of shell lines outside a script"],
    ["a YAML value already quoted", "supervisor-config.yaml", 'a: "${ROOT_PATH}"\n', "a value not the whole value of its line"],
    ["a YAML value in a comment", "supervisor-config.yaml", "# ${ROOT_PATH}\n", "a value not the whole value of its line"],
    ["a YAML value with a space", "supervisor-config.yaml", "a: x ${ROOT_PATH}\n", "a value not the whole value of its line"],
    ["a boolean concatenated", "supervisor-config.yaml", "a: ${OPAMP_ALLOW_INSECURE_CONNECTIONS}x\n", "a boolean not alone"],
  ])("refuses %s", (_case, name, text, reason) => {
    expect(templateProblem("all-in-one", name, `first line\n${text}`)).toEqual({ line: 2, reason });
  });

  // A line a quote, a heredoc or a continuation opened earlier.
  const INSIDE = "a placeholder inside a quote, a heredoc or a continued line";
  it.each([
    ["a heredoc", "cat <<EOT > /tmp/x\nx=${ROOT_PATH}\nEOT\n"],
    ["a quoted heredoc", "cat <<'EOT'\nx=${ROOT_PATH}\nEOT\n"],
    ["a <<- heredoc", "cat <<-EOT\nx=${ROOT_PATH}\n\tEOT\n"],
    ["a double-quoted string over two lines", 'echo "start\nx=${ROOT_PATH}\nend"\n'],
    ["a single-quoted string over two lines", "echo 'start\nx=${ROOT_PATH}\nend'\n"],
    ["a $'…' string over two lines", "echo $'start\\'\nx=${ROOT_PATH}\n'\n"],
    ["a backtick over two lines", "echo `start\nx=${ROOT_PATH}\n`\n"],
    ["a continued line", "echo start \\\nx=${ROOT_PATH}\n"],
    ["a block in a heredoc", "cat <<EOT\n${COLLECTOR_ENV_EXPORTS}\nEOT\n"],
  ])("refuses a placeholder inside %s", (_case, text) => {
    expect(templateProblem("all-in-one", "start_supervisor.sh", text)).toEqual({ line: 2, reason: INSIDE });
  });

  it.each([
    ["after a heredoc's delimiter line", "cat <<EOT\ntext\nEOT\nx=${ROOT_PATH}\n"],
    ["after two heredocs on one line", "cat <<A <<'B'\none\nA\ntwo\nB\nx=${ROOT_PATH}\n"],
    ["after a here-string (not a heredoc)", "cat <<< \"text\"\nx=${ROOT_PATH}\n"],
    ["after quotes closed on their line", "echo \"it's\" 'a \"b\"' $'c\\'d' `echo x`\nx=${ROOT_PATH}\n"],
    ["after a comment holding a quote", "# Telflo's comment, \"unclosed\nx=${ROOT_PATH}\n"],
    ["after an escaped quote", "echo \\\" \\'\nx=${ROOT_PATH}\n"],
    ["after a parameter expansion with #", 'v="${arg#--NAME=}"\nx=${ROOT_PATH}\n'],
  ])("takes a placeholder %s", (_case, text) => {
    expect(templateProblem("all-in-one", "start_supervisor.sh", text)).toBeNull();
  });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  config: string;
  root: string;
}

/**
 * The rendered script run under bash. With no OPAMP_TOKEN and no opamp.env
 * it writes ServerName and host.ip, then stops (exit 1) before anything is
 * downloaded. With `installed`, the binaries are stubs already in place
 * (the collector reports v0.162.0; the supervisor prints its environment
 * and arguments), so nothing is downloaded and the script execs the stub.
 * Stubs on PATH, so a Mac and a Linux host alike: `ip` prints `route` (or
 * fails, as on a host without it), `hostname` prints `hostName` and has no
 * -I.
 */
async function ran(
  method: InstallMethod,
  options: { args?: string[]; route?: string | null; hostName?: string; token?: string; installed?: boolean; env?: BundleInputs["env"]; fresh?: boolean } = {},
): Promise<Run> {
  const root = join(directory, "root");
  if (options.fresh !== false) {
    const files = await rendered(method, {
      rootPath: root,
      ...(method === "own-binary" ? { executablePath: join(root, "otelcol-contrib") } : {}),
      env: options.env ?? [],
    });
    await mkdir(root, { recursive: true });
    for (const [name, text] of files) await writeFile(join(root, name), text);
  }
  const stubs = join(directory, "stubs");
  await mkdir(stubs, { recursive: true });
  const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  const route = options.route === undefined ? null : options.route;
  await writeFile(join(stubs, "ip"), `#!/bin/sh\n${route === null ? "exit 1" : `printf '%s\\n' ${quoted(route)}`}\n`);
  await writeFile(join(stubs, "hostname"), `#!/bin/sh\n[ "$#" -eq 0 ] || exit 1\nprintf '%s\\n' ${quoted(options.hostName ?? "stub-host")}\n`);
  await chmod(join(stubs, "ip"), 0o755);
  await chmod(join(stubs, "hostname"), 0o755);
  if (options.installed === true) {
    // The collector's stub keeps the environment it was run with (otelcol-contrib.env).
    await writeFile(join(root, "otelcol-contrib"), "#!/bin/sh\nenv > \"$0.env\"\necho 'otelcol-contrib version 0.162.0'\n");
    await writeFile(join(root, "supervisor"), "#!/bin/sh\nenv\necho \"supervisor-args: $*\"\n");
    await chmod(join(root, "otelcol-contrib"), 0o755);
    await chmod(join(root, "supervisor"), 0o755);
  }
  const temporary = join(directory, "tmp");
  await mkdir(temporary, { recursive: true });
  const run = spawnSync(BASH, [join(root, "start_supervisor.sh"), ...(options.args ?? [])], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${stubs}:/usr/bin:/bin`,
      HOME: "/nonexistent-home",
      TMPDIR: temporary,
      ...(options.token === undefined ? {} : { OPAMP_TOKEN: options.token }),
    },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, config: await readFile(join(root, "supervisor-config.yaml"), "utf8"), root };
}

async function rewritten(method: InstallMethod, args: string[], route: string | null): Promise<Run> {
  return ran(method, { args, route });
}

describe("start_supervisor.sh's ServerName and host.ip, under bash", () => {
  const names = [
    "prod-collector-east-1",
    "2024",
    "true",
    "null",
    "- prod",
    "#prod",
    "x: y",
    'a"b',
    "a\\b",
    "trailing\\",
    "${env:OPAMP_TOKEN}",
    "$HOME",
    "$(echo EXPANDED)",
    "`echo EXPANDED`",
    "it's & a|b",
    "two  spaces ",
    "tab\there",
    "café ☕",
  ];

  it.each(["all-in-one", "own-binary"] as const)("%s writes each name verbatim: a double-quoted scalar, $ doubled for the supervisor's expansion", async (method) => {
    for (const name of names) {
      const { status, stderr, config } = await rewritten(method, [`--OPAMP_SERVER_NAME=${name}`], "1.1.1.1 via 10.0.0.1 dev eth0 src 10.1.2.3 uid 0");
      expect({ name, status, stopped: stderr.includes("OPAMP_TOKEN is not set") }).toEqual({ name, status: 1, stopped: true });
      const parsed = parse(config);
      // The supervisor's configuration expansion reads `$$` as `$`.
      expect({ name, read: (parsed.server.headers.ServerName as string).replaceAll("$$", "$") }).toEqual({ name, read: name });
      expect(parsed.server.headers.Authorization).toBe("");
      expect(parsed.agent.description.non_identifying_attributes).toEqual({ "telflo.collector_group_id": GROUP_ID, "host.ip": "10.1.2.3" });
      expect(stderr).not.toContain("EXPANDED");
    }
  });

  it.each(["a\nb", "a\rb", "a\u2028b", "a\u2029b", "a\u0085b", "bell\u0007"])("refuses the name %j, leaving the configuration as it was", async (name) => {
    const { status, stderr, config } = await rewritten("all-in-one", [`--OPAMP_SERVER_NAME=${name}`], null);
    expect(status).toBe(1);
    expect(stderr).toContain("--OPAMP_SERVER_NAME must not contain a line break or another control character.");
    expect(parse(config).server.headers.ServerName).toBe("");
  });

  it("without the flag, names the collector after the host", async () => {
    const { config } = await rewritten("all-in-one", [], null);
    expect(parse(config).server.headers.ServerName).toBe("stub-host");
  });

  it.each([
    ["no ip at all", null, ""],
    ["an IPv6 address", "1.1.1.1 dev eth0 src fd00::1:2 uid 0", "fd00::1:2"],
    ["anything but an address's characters", '1.1.1.1 dev eth0 src 10.0.0.1"x uid 0', ""],
    ["a $ reference", "1.1.1.1 dev eth0 src ${env:OPAMP_TOKEN} uid 0", ""],
  ])("host.ip with %s", async (_case, route, expected) => {
    const { status, config } = await rewritten("all-in-one", ["--OPAMP_SERVER_NAME=edge"], route);
    expect(status).toBe(1);
    expect(parse(config).agent.description.non_identifying_attributes["host.ip"]).toBe(expected);
  });
});

describe("start_supervisor.sh and the fleet's token, under bash (the collector never holds the bearer)", () => {
  // A harmless token holding what the YAML and the shell read specially.
  const TOKEN = 'Bearer tok-$(echo EXPANDED)-${env:HOME}-"q"-\\-it\'s';
  const modeOf = async (path: string) => ((await stat(path)).mode & 0o777).toString(8);

  it.each(["all-in-one", "own-binary"] as const)(
    "%s writes the token into the configuration (mode 0600), keeps it in opamp.env (0600), and execs the supervisor without it",
    async (method) => {
      const run = await ran(method, {
        token: TOKEN,
        installed: true,
        args: ["--OPAMP_SERVER_NAME=edge-1"],
        env: [{ name: "BACKEND_API_KEY", value: "harmless-value" }],
      });
      expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
      const config = parse(run.config);
      expect((config.server.headers.Authorization as string).replaceAll("$$", "$")).toBe(TOKEN);
      expect(config.server.headers.ServerName).toBe("edge-1");
      expect(await modeOf(join(run.root, "supervisor-config.yaml"))).toBe("600");
      expect(await modeOf(join(run.root, "opamp.env"))).toBe("600");
      expect(await readFile(join(run.root, "opamp.env"), "utf8")).toContain("OPAMP_TOKEN=");
      // What the supervisor (and so the collector) was started with.
      const environment = run.stdout.split("\n");
      expect(environment.filter((line) => line.startsWith("OPAMP_TOKEN="))).toEqual([]);
      expect(run.stdout).not.toContain("tok-");
      expect(environment).toContain("BACKEND_API_KEY=harmless-value");
      expect(run.stdout).toContain(`supervisor-args: --config ${join(run.root, "supervisor-config.yaml")}`);
      expect(run.stdout).not.toContain("EXPANDED");
    },
  );

  it("a later run with no export reads the token from opamp.env and writes it again", async () => {
    expect((await ran("all-in-one", { token: TOKEN, installed: true })).status).toBe(0);
    const again = await ran("all-in-one", { installed: true, fresh: false });
    expect(again.status).toBe(0);
    expect((parse(again.config).server.headers.Authorization as string).replaceAll("$$", "$")).toBe(TOKEN);
    expect(again.stdout.split("\n").filter((line) => line.startsWith("OPAMP_TOKEN="))).toEqual([]);
  });

  it.each(["bad$host", 'bad"host', "bad\\host"])("refuses a host named %j, never echoing the token", async (hostName) => {
    const run = await ran("all-in-one", { token: TOKEN, installed: true, hostName });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ERROR: the host's name holds");
    expect(`${run.stdout}${run.stderr}`).not.toContain("tok-");
    expect(parse(run.config).server.headers.Authorization).toBe("");
  });

  it("refuses a token with a line break, never echoing or keeping it", async () => {
    const run = await ran("all-in-one", { token: "Bearer tok-a\nb", installed: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("OPAMP_TOKEN holds a line break");
    expect(`${run.stdout}${run.stderr}`).not.toContain("tok-");
    // Never kept, nor written into the configuration.
    await expect(stat(join(run.root, "opamp.env"))).rejects.toThrow();
    expect(parse(run.config).server.headers.Authorization).toBe("");
  });
});

describe("start_supervisor.sh's own safety, under bash", () => {
  const TOKEN = "Bearer tok-harmless-46";

  it.each(["all-in-one", "own-binary"] as const)("%s installs downloads root-owned 0755, only over https, keeping no archive owner (M1)", async (method) => {
    const script = fileOf(await rendered(method), "start_supervisor.sh");
    const curls = script.split("\n").filter((line) => /^\s*curl /.test(line));
    expect(curls.length).toBe(method === "all-in-one" ? 2 : 1);
    for (const line of curls) expect(line).toMatch(/^\s*curl --proto '=https' -fsSL /);
    if (method === "all-in-one") {
      expect(script).toContain('tar --no-same-owner -xzf "$tmpdir/otelcol-contrib.tar.gz" -C "$tmpdir" otelcol-contrib\n');
      expect(script).toContain('install -o 0 -g 0 -m 0755 "$tmpdir/otelcol-contrib" "$root_path/otelcol-contrib"\n');
      expect(script).toContain('install -o 0 -g 0 -m 0755 "$tmpdir/supervisor" "$root_path/supervisor"\n');
    } else {
      expect(script).toContain('install -o 0 -g 0 -m 0755 "$tmpdir/supervisor" "$script_dir/supervisor"\n');
    }
    expect(script).not.toMatch(/^\s*tar -x/m);
    expect(script).not.toMatch(/^\s*(mv "\$tmpdir|chmod \+x)/m);
  });

  it.each(["all-in-one", "own-binary"] as const)("%s runs the collector's --version (and all after the token's write) without the token (m2)", async (method) => {
    const run = await ran(method, { token: TOKEN, installed: true });
    expect(run.status).toBe(0);
    const versionEnvironment = await readFile(join(run.root, "otelcol-contrib.env"), "utf8");
    expect(versionEnvironment.split("\n").some((line) => line.startsWith("OPAMP_TOKEN="))).toBe(false);
    expect(versionEnvironment).not.toContain("tok-harmless");
    expect(run.stdout).not.toContain("tok-harmless");
  });

  it.each([
    ["all-in-one", "supervisor_config"],
    ["all-in-one", "root_path"],
    ["own-binary", "supervisor_config"],
    ["own-binary", "script_dir"],
  ] as const)("%s stops before anything runs when a variable is named %s, naming it, never its value (m3)", async (method, name) => {
    const run = await ran(method, { token: TOKEN, installed: true, env: [{ name, value: "/harmless-elsewhere-value" }] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`${name}: readonly variable`);
    expect(`${run.stdout}${run.stderr}`).not.toContain("harmless-elsewhere-value");
    // Nothing ran: the configuration untouched, no token kept, no supervisor started.
    const config = parse(run.config);
    expect([config.server.headers.ServerName, config.server.headers.Authorization]).toEqual(["", ""]);
    await expect(stat(join(run.root, "opamp.env"))).rejects.toThrow();
    expect(run.stdout).not.toContain("supervisor-args");
  });

  it.each(["\u0080", "\u0085", "\u009f", "\ufffe", "\uffff", "\u2028"])("refuses a name holding %j (m5: the entrypoint's guard)", async (character) => {
    const run = await ran("all-in-one", { args: [`--OPAMP_SERVER_NAME=a${character}b`] });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--OPAMP_SERVER_NAME must not contain a line break or another control character.");
  });

  it.each(["no\u00a0break space", "tab\there", "émoji 🚀"])("takes a name holding %j", async (name) => {
    const run = await ran("all-in-one", { args: [`--OPAMP_SERVER_NAME=${name}`] });
    expect(run.stderr).toContain("OPAMP_TOKEN is not set");
    expect(parse(run.config).server.headers.ServerName).toBe(name);
  });

  it.each(["all-in-one", "own-binary"] as const)("%s refuses a root path writable by others, before reading or running anything there (nit)", async (method) => {
    const first = await ran(method, { token: TOKEN, installed: true });
    expect(first.status).toBe(0);
    await chmod(first.root, 0o777);
    try {
      const again = await ran(method, { installed: true, fresh: false });
      expect(again.status).toBe(1);
      expect(again.stderr).toMatch(/must be owned by .* and writable by no other user or group\./);
      // The hint for a bundle unpacked under umask 0002.
      expect(again.stderr).toContain(`which lets the group write, run: sudo chmod go-w ${first.root}\n`);
      expect(again.stdout).not.toContain("supervisor-args");
    } finally {
      await chmod(first.root, 0o755);
    }
  });

  // The chmod hint only when the refusal is about another user's or group's
  // write; a root path owned by another user says that alone. Only All In
  // One can be shown without root (own-binary checks its own script's
  // directory, which the test's user owns; its check is the same).
  it("all-in-one refuses a root path owned by another user with that alone, no chmod hint", async () => {
    const uid = process.getuid?.();
    const candidates = await Promise.all(
      ["/usr/share", "/usr/bin", "/usr", "/bin", "/etc"].map(async (path) => ({ path, stats: await stat(path).catch(() => undefined) })),
    );
    const others = candidates.find(({ stats }) => stats !== undefined && stats.isDirectory() && stats.uid !== uid && (stats.mode & 0o022) === 0);
    if (others === undefined) throw new Error("no directory owned by another user and writable by no one else (is the test running as root?)");
    const root = join(directory, "root");
    await mkdir(root);
    for (const [name, text] of await rendered("all-in-one", { rootPath: others.path, env: [] })) await writeFile(join(root, name), text);
    const run = spawnSync(BASH, [join(root, "start_supervisor.sh")], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home", OPAMP_TOKEN: TOKEN },
    });
    const user = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 1, stderr: `ERROR: ${others.path} must be owned by ${user}.\n` });
  });

  // find -H, so a symlinked root path is judged by its target (a link's own
  // mode says nothing: 0777 on Linux, refused before), and the link's own
  // directory must be the user's and private too, or another user could
  // point the link elsewhere.
  it.each(["all-in-one", "own-binary"] as const)("%s judges a symlinked root path by its target and the link's own directory", async (method) => {
    const target = join(directory, "target");
    const link = join(directory, "root");
    await mkdir(target, { mode: 0o755 });
    await symlink(target, link);
    const first = await ran(method, { token: TOKEN, installed: true });
    expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: "" });
    expect(first.stdout).toContain(`supervisor-args: --config ${join(link, "supervisor-config.yaml")}`);

    await chmod(target, 0o777);
    try {
      const again = await ran(method, { installed: true, fresh: false });
      expect(again.status).toBe(1);
      expect(again.stderr).toContain(`ERROR: ${link} must be owned by`);
      expect(again.stdout).not.toContain("supervisor-args");
    } finally {
      await chmod(target, 0o755);
    }

    const linkDirectoryMode = (await stat(directory)).mode & 0o777;
    await chmod(directory, linkDirectoryMode | 0o020);
    try {
      const again = await ran(method, { installed: true, fresh: false });
      expect(again.status).toBe(1);
      expect(again.stderr).toContain(`ERROR: ${directory} must be owned by`);
      expect(again.stderr).toContain(`run: sudo chmod go-w ${directory}\n`);
      expect(again.stdout).not.toContain("supervisor-args");
    } finally {
      await chmod(directory, linkDirectoryMode);
    }
    expect((await ran(method, { installed: true, fresh: false })).status).toBe(0);
  });

  it.each(["all-in-one", "own-binary"] as const)("%s, with no token, says to pass it through sudo", async (method) => {
    const run = await ran(method, { installed: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ERROR: OPAMP_TOKEN is not set");
    expect(run.stderr).toContain("\n  export OPAMP_TOKEN='Bearer <token>'\n  sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh\n");
    expect(run.stdout).not.toContain("supervisor-args");
  });

  it("refuses an opamp.env writable by others, before reading it (nit)", async () => {
    const first = await ran("all-in-one", { token: TOKEN, installed: true });
    await chmod(join(first.root, "opamp.env"), 0o666);
    const again = await ran("all-in-one", { installed: true, fresh: false });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("opamp.env must be owned by");
    expect(`${again.stdout}${again.stderr}`).not.toContain("tok-harmless");
  });
});
