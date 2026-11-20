import { describe, expect, it } from "vitest";
import {
  FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE,
  FLEET_TYPE_NOT_INSTALLABLE_MESSAGE,
  INSTALL_UNAVAILABLE_MESSAGE,
  installBundleFileName,
  InstallBundleRequestSchema,
  installEnvValueProblem,
  InstallFactsSchema,
  installPathProblem,
  RESERVED_INSTALL_ENV_NAMES,
} from "./install.js";

// The install's facts, the bundle's request and its file name.

const GROUP_ID = "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f";

const issuesOf = (body: unknown) => {
  const parsed = InstallBundleRequestSchema.safeParse(body);
  return parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
};

describe("installBundleFileName", () => {
  it("names the method and the arch, never a label", () => {
    expect(installBundleFileName("all-in-one", "amd64")).toBe("telflo-collector-all-in-one-amd64.tar.gz");
    expect(installBundleFileName("own-binary", "arm64")).toBe("telflo-collector-own-binary-arm64.tar.gz");
  });
});

describe("the words", () => {
  it("are the install's words, and the five reserved names", () => {
    expect(INSTALL_UNAVAILABLE_MESSAGE).toBe(
      "Installing isn't available right now: the install templates can't be read. Ask your administrator.",
    );
    expect(RESERVED_INSTALL_ENV_NAMES).toEqual([
      "OPAMP_ENDPOINT",
      "OPAMP_TOKEN",
      "OPAMP_SERVER_NAME",
      "OPAMP_ALLOW_INSECURE_CONNECTIONS",
      "COLLECTOR_GROUP_ID",
    ]);
  });
});

// fleet_type_not_installable's words per direction.
describe("fleet_type_not_installable's words", () => {
  it("send a Kubernetes-supervisor fleet to Install with Helm, and a server fleet's group to Install collector", () => {
    expect(FLEET_TYPE_NOT_INSTALLABLE_MESSAGE).toBe("A Kubernetes-supervisor fleet's collectors are installed with Helm: use Install with Helm.");
    expect(FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE).toBe("A server fleet's groups have no Helm install: use Install collector.");
  });
});

describe("installPathProblem", () => {
  it.each(["/etc/otelcol", "/etc/otelcol/", "/opt/telflo-1.2/x_y", "/a", `/${"a".repeat(199)}`])("takes %s", (path) => {
    expect(installPathProblem(path)).toBeNull();
  });

  it.each([
    ["", "Type a path."],
    ["etc/otelcol", "Use an absolute path, starting with /."],
    ["/etc/otel col", "Use letters, digits, dots, dashes, underscores and /."],
    ["/etc/otel'col", "Use letters, digits, dots, dashes, underscores and /."],
    ['/etc/otel"col', "Use letters, digits, dots, dashes, underscores and /."],
    ["/etc/$(echo EXPANDED)", "Use letters, digits, dots, dashes, underscores and /."],
    ["/etc/${ROOT_PATH}", "Use letters, digits, dots, dashes, underscores and /."],
    ["/etc/otel\ncol", "Use letters, digits, dots, dashes, underscores and /."],
    ["/", "Use a directory, not the root."],
    ["//", "Use a directory, not the root."],
    ["/etc/../tmp", "Use no . or .. segment."],
    ["/etc/./otelcol", "Use no . or .. segment."],
    [`/${"a".repeat(200)}`, "At most 200 characters."],
  ])("refuses %j: %s", (path, message) => {
    expect(installPathProblem(path)).toBe(message);
  });
});

describe("installEnvValueProblem", () => {
  it.each(["x", "it's", "$(echo EXPANDED)", "a b", "café", "x".repeat(4096)])("takes %j", (value) => {
    expect(installEnvValueProblem(value)).toBeNull();
  });

  it.each(["", "a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "x".repeat(4097)])("refuses %j", (value) => {
    expect(installEnvValueProblem(value)).not.toBeNull();
  });

  // A value no UTF-8 file, YAML parser or shell carries is refused at the request (400 at env.N.value), for every
  // install, never stored for a download to fail on.
  const CANARY = "CANARY-7f3a";
  it.each([
    ["a lone high surrogate", `${CANARY}\ud83d end`],
    ["a lone low surrogate", `${CANARY}\ude00 end`],
    ["a lone high surrogate last", `${CANARY}\ud83d`],
    ["two high surrogates", `${CANARY}\ud83d\ud83d\ude00`],
    ["a low surrogate before a high", `${CANARY}\ude00\ud83d`],
  ])("refuses %s, in fixed words without the value", (_label, value) => {
    const problem = installEnvValueProblem(value);
    expect(problem).toBe("Use only whole characters (not half of an emoji, say).");
    expect(problem).not.toContain(CANARY);
  });

  it("takes a valid astral pair, alone and among other text", () => {
    expect(installEnvValueProblem("\ud83d\ude00")).toBeNull();
    expect(installEnvValueProblem(`smile \u{1f600} and \u{10ffff} end`)).toBeNull();
  });

  it("refuses a lone surrogate in a bundle's request, at env.N.value", () => {
    expect(issuesOf({ method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", env: [{ name: "A", value: "ok" }, { name: "B", value: "x\udc00" }] })).toEqual([
      { path: "env.1.value", message: "Use only whole characters (not half of an emoji, say)." },
    ]);
  });
});

describe("InstallBundleRequestSchema", () => {
  const allInOne = { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol/", env: [{ name: "NGINX_ENV", value: "prod" }] };

  it("takes All In One, its root path's trailing / removed", () => {
    expect(InstallBundleRequestSchema.parse(allInOne)).toEqual({ ...allInOne, rootPath: "/etc/otelcol" });
  });

  it("takes own-binary with its executable path", () => {
    const request = { method: "own-binary", arch: "arm64", rootPath: "/etc/otelcol", executablePath: "/usr/bin/otelcol-contrib", env: [] };
    expect(InstallBundleRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ["an unknown method", { ...allInOne, method: "container" }, "method"],
    ["an unknown arch", { ...allInOne, arch: "386" }, "arch"],
    ["a relative root path", { ...allInOne, rootPath: "etc" }, "rootPath"],
    ["the root", { ...allInOne, rootPath: "/" }, "rootPath"],
    ["an executable path for All In One", { ...allInOne, executablePath: "/usr/bin/otelcol-contrib" }, "executablePath"],
    ["no executable path for own-binary", { ...allInOne, method: "own-binary" }, "executablePath"],
    ["a bad executable path", { ...allInOne, method: "own-binary", executablePath: "/usr/bin/a b" }, "executablePath"],
    ["a variable's name that isn't one", { ...allInOne, env: [{ name: "BAD-NAME", value: "x" }] }, "env.0.name"],
    ["an empty value", { ...allInOne, env: [{ name: "A", value: "" }] }, "env.0.value"],
    ["a value with a line break", { ...allInOne, env: [{ name: "A", value: "a\nb" }] }, "env.0.value"],
    ["a variable twice", { ...allInOne, env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }, "env.1.name"],
    ["an unknown key", { ...allInOne, displayName: "x" }, ""],
    ["a variable's unknown key", { ...allInOne, env: [{ name: "A", value: "1", secret: true }] }, "env.0"],
    ["no env", { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol" }, "env"],
  ])("refuses %s, at its path", (_case, body, path) => {
    expect(issuesOf(body).map((issue) => issue.path)).toContain(path);
  });

  it("refuses more than 50 variables, and takes 50", () => {
    const env = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `V${index}`, value: "x" }));
    expect(issuesOf({ ...allInOne, env: env(50) })).toEqual([]);
    expect(issuesOf({ ...allInOne, env: env(51) })).toEqual([{ path: "env", message: "At most 50 variables." }]);
  });
});

describe("InstallFactsSchema", () => {
  const facts = {
    imageTag: "ghcr.io/telflo/telflo/collector:0.162.0",
    endpoint: "https://opamp.telflo.example/v1/opamp",
    allowInsecureConnections: false,
    collector: { distribution: "otelcol-contrib", version: "0.162.0" },
    envVarNames: ["NGINX_ENV"],
    mounts: [{ hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true }],
    mountsReadable: true,
    groupId: GROUP_ID,
  };

  it("takes the facts, and refuses a bearer or any other key", () => {
    expect(InstallFactsSchema.parse(facts)).toEqual(facts);
    expect(InstallFactsSchema.safeParse({ ...facts, bearer: "x" }).success).toBe(false);
  });

  it("says whether the group's mounts could be read: required, a boolean", () => {
    expect(InstallFactsSchema.parse({ ...facts, mounts: [], mountsReadable: false })).toEqual({ ...facts, mounts: [], mountsReadable: false });
    const { mountsReadable: _left, ...without } = facts;
    expect(InstallFactsSchema.safeParse(without).success).toBe(false);
    expect(InstallFactsSchema.safeParse({ ...facts, mountsReadable: "false" }).success).toBe(false);
  });

  it("refuses a variable name that isn't a shell name, or one over 256 characters (a malformed reply, never rendered)", () => {
    for (const name of ["A;id", "1A", "A B", "$(echo EXPANDED)", "", "A".repeat(257)]) {
      expect(InstallFactsSchema.safeParse({ ...facts, envVarNames: [name] }).success, name).toBe(false);
    }
    expect(InstallFactsSchema.safeParse({ ...facts, envVarNames: ["_A1", "A".repeat(256)] }).success).toBe(true);
  });

  it("refuses a reserved name, or a name twice: the install sets the five itself, and docker keeps the last -e", () => {
    for (const name of ["OPAMP_TOKEN", "OPAMP_ENDPOINT", "OPAMP_SERVER_NAME", "OPAMP_ALLOW_INSECURE_CONNECTIONS", "COLLECTOR_GROUP_ID"]) {
      expect(InstallFactsSchema.safeParse({ ...facts, envVarNames: [name] }).success, name).toBe(false);
    }
    expect(InstallFactsSchema.safeParse({ ...facts, envVarNames: ["NGINX_ENV", "NGINX_ENV"] }).success).toBe(false);
  });
});
