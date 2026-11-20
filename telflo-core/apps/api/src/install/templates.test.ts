import { execFileSync } from "node:child_process";
import { symlinkSync, unlinkSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallMethod } from "@telflo/contracts";
import { checkInstallTemplates, createInstallTemplateLoader, InstallTemplatesError } from "./templates.js";

// The templates read from a directory on every render: a plain directory
// (compose's bind mount, a minikube hostPath), a Kubernetes ConfigMap
// (kubelet's `..data` layout, its swap), one mounted flat at a method's
// directory; each bad entry refused naming its relative path, never its text.

const REPOSITORY_TEMPLATES = fileURLToPath(new URL("../../../../../install-templates", import.meta.url));
/** Text no refusal may quote. */
const CANARY = "template-text-canary-7f3a";

/**
 * Every path the loader opens (fs/promises' open, wrapped), and a hook run
 * just before an open: what a test does between one file's read and the
 * next (lstat before open; ..data once per render). And a hook run just
 * after a directory is listed or a `..data` resolved, whichever the loader
 * does first: what a test does between the two.
 */
const opened = vi.hoisted(() => ({
  paths: [] as string[],
  beforeOpen: undefined as ((path: string) => void) | undefined,
  afterListOrData: undefined as (() => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const open: typeof actual.open = async (...args) => {
    const path = String(args[0]);
    opened.paths.push(path);
    opened.beforeOpen?.(path);
    return actual.open(...args);
  };
  const readdir = (async (...args: Parameters<typeof actual.readdir>) => {
    const names = await actual.readdir(...args);
    opened.afterListOrData?.();
    return names;
  }) as typeof actual.readdir;
  const realpath = (async (...args: Parameters<typeof actual.realpath>) => {
    const resolved = await actual.realpath(...args);
    if (String(args[0]).endsWith("..data")) opened.afterListOrData?.();
    return resolved;
  }) as typeof actual.realpath;
  return { ...actual, open, readdir, realpath, default: { ...actual, open, readdir, realpath } };
});

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "install-templates-"));
  opened.paths = [];
  opened.beforeOpen = undefined;
  opened.afterListOrData = undefined;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A root with `linux/<method>/` holding `files`. */
async function aSet(files: Record<string, string>, method: InstallMethod = "all-in-one", root = join(base, "root")): Promise<string> {
  const directory = join(root, "linux", method);
  await mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
  return root;
}

const GOOD = {
  "start_supervisor.sh": `#!/bin/bash\n# ${CANARY}\nroot_path=\${ROOT_PATH}\necho "\${OPAMP_TOKEN:-}" "\${server_name}"\n\${COLLECTOR_ENV_EXPORTS}\n`,
  "supervisor-config.yaml": `# ${CANARY}\nserver:\n  endpoint: \${OPAMP_ENDPOINT}\n  headers:\n    Authorization: \${env:OPAMP_TOKEN}\n`,
  "README.md": `${CANARY} \${ROOT_PATH}\n`,
};

async function refusal(root: string, method: InstallMethod = "all-in-one"): Promise<InstallTemplatesError> {
  try {
    await createInstallTemplateLoader(root).load(method);
  } catch (error) {
    expect(error).toBeInstanceOf(InstallTemplatesError);
    const refused = error as InstallTemplatesError;
    expect(refused.message).not.toContain(CANARY);
    expect(refused.message).toMatch(/^The install templates \(TELFLO_INSTALL_TEMPLATES_DIR\) can't be used: /);
    return refused;
  }
  throw new Error("the set loaded");
}

describe("the install template loader", () => {
  it("loads the repository's two sets, sorted by name, start_supervisor.sh 0700 and every other file 0644", async () => {
    const loader = createInstallTemplateLoader(REPOSITORY_TEMPLATES);
    for (const method of ["all-in-one", "own-binary"] as const) {
      const files = await loader.load(method);
      expect(files.map((file) => [file.name, file.mode.toString(8)])).toEqual([
        ["README.md", "644"],
        ["otelcol-config.yaml", "644"],
        ["start_supervisor.sh", "700"],
        ["supervisor-config.yaml", "644"],
      ]);
    }
    await expect(checkInstallTemplates(loader)).resolves.toBeUndefined();
  });

  it("loads a plain directory, skipping names that start with a dot", async () => {
    const root = await aSet({ ...GOOD, ".DS_Store": "${NOT_KNOWN} \u0000", "..2026_10_16": "" });
    const files = await createInstallTemplateLoader(root).load("all-in-one");
    expect(files.map((file) => file.name)).toEqual(["README.md", "start_supervisor.sh", "supervisor-config.yaml"]);
    expect(files.find((file) => file.name === "README.md")?.text).toBe(GOOD["README.md"]);
  });

  it("reads again on every render: an edit is seen at the next one (no cache)", async () => {
    const root = await aSet(GOOD);
    const loader = createInstallTemplateLoader(root);
    expect((await loader.load("all-in-one")).find((file) => file.name === "README.md")?.text).not.toContain("edited");
    await writeFile(join(root, "linux", "all-in-one", "README.md"), "edited\n");
    expect((await loader.load("all-in-one")).find((file) => file.name === "README.md")?.text).toBe("edited\n");
  });

  it("loads a ConfigMap mounted at the root (kubelet's ..data layout), and sees its swap at the next render", async () => {
    const root = join(base, "configmap");
    const first = join(root, "..2026_10_16_09_00_00.000000001");
    await aSet(GOOD, "all-in-one", first);
    await symlink("..2026_10_16_09_00_00.000000001", join(root, "..data"));
    await symlink(join("..data", "linux"), join(root, "linux"));
    const loader = createInstallTemplateLoader(root);
    expect((await loader.load("all-in-one")).map((file) => file.name)).toEqual(["README.md", "start_supervisor.sh", "supervisor-config.yaml"]);

    const second = join(root, "..2026_10_16_09_01_00.000000002");
    await aSet({ ...GOOD, "README.md": "swapped\n" }, "all-in-one", second);
    await rm(join(root, "..data"));
    await symlink("..2026_10_16_09_01_00.000000002", join(root, "..data"));
    expect((await loader.load("all-in-one")).find((file) => file.name === "README.md")?.text).toBe("swapped\n");
  });

  it("loads a ConfigMap mounted flat at a method's directory, its keys links into ..data", async () => {
    const root = join(base, "flat");
    const directory = join(root, "linux", "all-in-one");
    const data = join(directory, "..2026_10_16");
    await mkdir(data, { recursive: true });
    for (const [name, text] of Object.entries(GOOD)) {
      await writeFile(join(data, name), text);
      await symlink(join("..data", name), join(directory, name));
    }
    await symlink("..2026_10_16", join(directory, "..data"));
    expect((await createInstallTemplateLoader(root).load("all-in-one")).map((file) => file.name)).toEqual([
      "README.md",
      "start_supervisor.sh",
      "supervisor-config.yaml",
    ]);
  });

  it("refuses a link leaving the method's directory, outside the root", async () => {
    const root = await aSet(GOOD);
    await writeFile(join(base, "secret.txt"), `${CANARY}\n`);
    await symlink(join(base, "secret.txt"), join(root, "linux", "all-in-one", "escape.md"));
    const refused = await refusal(root);
    expect([refused.file, refused.reason]).toEqual(["linux/all-in-one/escape.md", "a link leaving its directory"]);
  });

  it("refuses a link to another method's file, inside the root but outside its directory", async () => {
    const root = await aSet(GOOD);
    await aSet({ "other.md": `${CANARY}\n` }, "own-binary", root);
    await symlink(join(root, "linux", "own-binary", "other.md"), join(root, "linux", "all-in-one", "other.md"));
    expect((await refusal(root)).reason).toBe("a link leaving its directory");
  });

  it("refuses a method's directory that resolves outside the root", async () => {
    const root = join(base, "root");
    await mkdir(join(root, "linux"), { recursive: true });
    await aSet(GOOD, "all-in-one", join(base, "elsewhere"));
    await symlink(join(base, "elsewhere", "linux", "all-in-one"), join(root, "linux", "all-in-one"));
    const refused = await refusal(root);
    expect([refused.file, refused.reason]).toEqual(["linux/all-in-one", "outside the directory"]);
  });

  it("refuses a directory", async () => {
    const root = await aSet(GOOD);
    await mkdir(join(root, "linux", "all-in-one", "nested"));
    expect([(await refusal(root)).file, (await refusal(root)).reason]).toEqual(["linux/all-in-one/nested", "not a regular file"]);
  });

  it("refuses a link to a FIFO before opening it (lstat first)", async () => {
    const root = await aSet(GOOD);
    execFileSync("mkfifo", [join(root, "linux", "all-in-one", ".pipe")]);
    await symlink(".pipe", join(root, "linux", "all-in-one", "linked.md"));
    const refused = await refusal(root);
    expect([refused.file, refused.reason]).toEqual(["linux/all-in-one/linked.md", "not a regular file"]);
    // Refused by lstat: neither the link nor the FIFO it names was opened
    // (the fstat after an O_NONBLOCK open would refuse it too, so only the
    // opens show the order). README.md, before it by name, was.
    const fifo = await realpath(join(root, "linux", "all-in-one", ".pipe"));
    expect(opened.paths.some((path) => path.endsWith("README.md"))).toBe(true);
    expect(opened.paths.filter((path) => path === fifo || path.endsWith("linked.md") || path.endsWith(".pipe"))).toEqual([]);
  });

  it("reads a flat ConfigMap's keys through one resolution of ..data per render", async () => {
    const root = join(base, "flat-once");
    const directory = join(root, "linux", "all-in-one");
    await mkdir(join(directory, "..v1"), { recursive: true });
    await mkdir(join(directory, "..v2"), { recursive: true });
    for (const [name, text] of Object.entries(GOOD)) {
      await writeFile(join(directory, "..v1", name), text);
      await writeFile(join(directory, "..v2", name), `${text}# v2\n`);
      await symlink(join("..data", name), join(directory, name));
    }
    await symlink("..v1", join(directory, "..data"));
    const loader = createInstallTemplateLoader(root);
    expect((await loader.load("all-in-one")).every((file) => !file.text.includes("# v2"))).toBe(true);
    await rm(join(directory, "..data"));
    await symlink("..v2", join(directory, "..data"));
    expect((await loader.load("all-in-one")).every((file) => file.text.endsWith("# v2\n"))).toBe(true);
  });

  it("reads every file of a render from the ..data it resolved first, though it is swapped mid-render", async () => {
    const root = join(base, "flat-swap");
    const directory = join(root, "linux", "all-in-one");
    await mkdir(join(directory, "..v1"), { recursive: true });
    await mkdir(join(directory, "..v2"), { recursive: true });
    for (const [name, text] of Object.entries(GOOD)) {
      await writeFile(join(directory, "..v1", name), text);
      await writeFile(join(directory, "..v2", name), `${text}# v2\n`);
      await symlink(join("..data", name), join(directory, name));
    }
    await symlink("..v1", join(directory, "..data"));
    // kubelet's swap, just before the first file's open: after the loader has resolved ..data (and listed it).
    let swaps = 0;
    opened.beforeOpen = () => {
      if (swaps++ > 0) return;
      unlinkSync(join(directory, "..data"));
      symlinkSync("..v2", join(directory, "..data"));
    };
    const files = await createInstallTemplateLoader(root).load("all-in-one");
    expect(swaps).toBe(3);
    expect(files.map((file) => [file.name, file.text.includes("# v2")])).toEqual([
      ["README.md", false],
      ["start_supervisor.sh", false],
      ["supervisor-config.yaml", false],
    ]);
    // The next render reads the new version throughout.
    opened.beforeOpen = undefined;
    expect((await createInstallTemplateLoader(root).load("all-in-one")).every((file) => file.text.endsWith("# v2\n"))).toBe(true);
  });

  it("lists the ..data it resolved first, though kubelet swaps it between the two: no key dropped, no key refused", async () => {
    const root = join(base, "flat-list");
    const directory = join(root, "linux", "all-in-one");
    // v1 holds old.md, which v2 removes; v2 adds extra.md.
    const v1 = { ...GOOD, "old.md": "old\n" };
    const v2 = { ...GOOD, "extra.md": "extra\n" };
    await mkdir(join(directory, "..v1"), { recursive: true });
    await mkdir(join(directory, "..v2"), { recursive: true });
    for (const [name, text] of Object.entries(v1)) await writeFile(join(directory, "..v1", name), text);
    for (const [name, text] of Object.entries(v2)) await writeFile(join(directory, "..v2", name), `${text}# v2\n`);
    for (const name of Object.keys(v1)) await symlink(join("..data", name), join(directory, name));
    await symlink("..v1", join(directory, "..data"));
    // kubelet's swap, as its atomic writer does it (the new key's link, then ..data, then the removed key's link
    // gone; the old ..v1 kept, removed later), right after the loader's first of listing and resolving ..data.
    let swaps = 0;
    opened.afterListOrData = () => {
      if (swaps++ > 0) return;
      symlinkSync(join("..data", "extra.md"), join(directory, "extra.md"));
      unlinkSync(join(directory, "..data"));
      symlinkSync("..v2", join(directory, "..data"));
      unlinkSync(join(directory, "old.md"));
    };
    const files = await createInstallTemplateLoader(root).load("all-in-one");
    expect(swaps).toBeGreaterThan(0);
    // One version throughout: v1's keys, v1's text.
    expect(files.map((file) => [file.name, file.text.includes("# v2")])).toEqual([
      ["README.md", false],
      ["old.md", false],
      ["start_supervisor.sh", false],
      ["supervisor-config.yaml", false],
    ]);
    // The next render reads v2: its new key, not the removed one.
    opened.afterListOrData = undefined;
    expect((await createInstallTemplateLoader(root).load("all-in-one")).map((file) => [file.name, file.text.endsWith("# v2\n")])).toEqual([
      ["README.md", true],
      ["extra.md", true],
      ["start_supervisor.sh", true],
      ["supervisor-config.yaml", true],
    ]);
  });

  it("refuses a FIFO without hanging (O_NONBLOCK), never opening it (lstat first)", async () => {
    const root = await aSet(GOOD);
    execFileSync("mkfifo", [join(root, "linux", "all-in-one", "pipe")]);
    expect((await refusal(root)).reason).toBe("not a regular file");
    expect(opened.paths.filter((path) => path.endsWith("pipe"))).toEqual([]);
  });

  it.each(["a b.md", "ünïcode.md", "con:", `${"n".repeat(101)}`])("refuses the name %j", async (name) => {
    const root = await aSet({ ...GOOD, [name]: "x\n" });
    const refused = await refusal(root);
    expect(refused.reason).toBe("a name of more than letters, digits, dots, dashes and underscores");
  });

  it("takes a name of 100 characters", async () => {
    const root = await aSet({ ...GOOD, [`${"n".repeat(97)}.md`]: "x\n" });
    expect(await createInstallTemplateLoader(root).load("all-in-one")).toHaveLength(4);
  });

  it("refuses more than 32 files, and takes 32", async () => {
    const extra = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`extra-${index}.md`, "x\n"]));
    expect(await createInstallTemplateLoader(await aSet({ ...GOOD, ...extra(29) })).load("all-in-one")).toHaveLength(32);
    const refused = await refusal(await aSet({ ...GOOD, ...extra(30) }, "all-in-one", join(base, "many")));
    expect([refused.file, refused.reason]).toEqual(["linux/all-in-one", "more than 32 files"]);
  });

  it("refuses a file over 256 KiB, and takes one of 256 KiB", async () => {
    const atBound = `${CANARY}${"x".repeat(256 * 1024 - CANARY.length)}`;
    expect(await createInstallTemplateLoader(await aSet({ ...GOOD, "big.md": atBound })).load("all-in-one")).toHaveLength(4);
    const refused = await refusal(await aSet({ ...GOOD, "big.md": `${atBound}x` }, "all-in-one", join(base, "over")));
    expect([refused.file, refused.reason]).toEqual(["linux/all-in-one/big.md", "over 256 KiB"]);
  });

  it("refuses a file that isn't UTF-8", async () => {
    const root = await aSet(GOOD);
    await writeFile(join(root, "linux", "all-in-one", "latin1.md"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect((await refusal(root)).reason).toBe("not UTF-8 text");
  });

  it("refuses an unknown placeholder, naming the file and the line, never the text or the placeholder", async () => {
    const root = await aSet({ ...GOOD, "README.md": `${CANARY}\nsee \${SECRET_CANARY_NAME}\n` });
    const refused = await refusal(root);
    expect([refused.file, refused.reason]).toEqual(["linux/all-in-one/README.md", "line 2: a placeholder Telflo doesn't fill"]);
    expect(refused.message).not.toContain("SECRET_CANARY_NAME");
  });

  it("refuses another method's placeholder: each set is checked against its own", async () => {
    const root = await aSet({ ...GOOD, "README.md": "${EXECUTABLE_PATH}\n" });
    expect((await refusal(root)).reason).toBe("line 1: a placeholder Telflo doesn't fill");
    const own = await aSet({ "README.md": "${EXECUTABLE_PATH}\n" }, "own-binary", join(base, "own"));
    expect(await createInstallTemplateLoader(own).load("own-binary")).toHaveLength(1);
  });

  it("refuses a value where its quoting can't hold", async () => {
    const root = await aSet({ ...GOOD, "start_supervisor.sh": `#!/bin/bash\nmkdir -p "\${ROOT_PATH}"\n` });
    expect((await refusal(root)).reason).toBe("line 2: a value not on the right of an assignment line");
  });

  it.each([
    ["a missing method", async () => aSet(GOOD, "own-binary"), "linux/all-in-one", "missing"],
    ["an empty method", async () => aSet({}), "linux/all-in-one", "no files"],
    ["a method that is a file", async () => {
      const root = join(base, "root");
      await mkdir(join(root, "linux"), { recursive: true });
      await writeFile(join(root, "linux", "all-in-one"), "x");
      return root;
    }, "linux/all-in-one", "not a directory"],
  ] as const)("refuses %s", async (_case, make, file, reason) => {
    const refused = await refusal(await make());
    expect([refused.file, refused.reason]).toEqual([file, reason]);
  });

  it("refuses a root that doesn't exist, or isn't absolute, naming the setting", async () => {
    const missing = join(base, "nowhere");
    expect((await refusal(missing)).message).toBe(
      `The install templates (TELFLO_INSTALL_TEMPLATES_DIR) can't be used: the directory: doesn't exist (${missing})`,
    );
    expect((await refusal("install-templates")).reason).toBe("not an absolute path (install-templates)");
  });

  it("the start-up check loads both methods: one broken set refuses", async () => {
    const root = await aSet(GOOD);
    await aSet({ "README.md": `${CANARY} \${NOT_KNOWN}\n` }, "own-binary", root);
    await expect(checkInstallTemplates(createInstallTemplateLoader(root))).rejects.toThrow(
      "The install templates (TELFLO_INSTALL_TEMPLATES_DIR) can't be used: linux/own-binary/README.md: line 1: a placeholder Telflo doesn't fill",
    );
  });
});
