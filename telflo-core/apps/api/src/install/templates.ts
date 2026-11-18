import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { INSTALL_METHODS, type InstallMethod } from "@telflo/contracts";
import { templateProblem } from "./render.js";

/*
 * The install templates, read from a directory at run time (D17c-1
 * decisions 6, 17 and 36; Preflight ruling 12): TELFLO_INSTALL_TEMPLATES_DIR
 * holds `linux/all-in-one/` and `linux/own-binary/`, the default set in the
 * repository's install-templates/ and in the API's image, replaced by an
 * operator's directory: a Kubernetes ConfigMap or volume in SaaS, a
 * customer's directory air-gapped, a minikube `hostPath`.
 *
 * Read again on every render, never cached, so a ConfigMap's swap or an
 * edit applies at the next one. The root's realpath is resolved once; on
 * every read the method directory's realpath, which must stay under the
 * root's. A ConfigMap mounted flat at the method directory (its `..data`
 * link there) is read through `..data` resolved FIRST, once per read: the
 * directory it names (`..<timestamp>`, inside the method directory) is the
 * one listed and read, so a kubelet swap during a read never mixes two
 * versions, drops a key just added or refuses one just removed (Ruling 62;
 * the flat links beside it aren't read). An entry whose name starts with
 * `.` is skipped (kubelet's `..data` and `..<timestamp>`, `.DS_Store`). A
 * symbolic link is followed only when its realpath stays inside the
 * method directory.
 * Each entry, and a link's target, must be a regular file by lstat before
 * it is opened (a directory, a FIFO or a device is never opened), then is
 * opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` on its resolved path and
 * fstat'ed as one again, at most 32
 * of them, each at most 256 KiB of UTF-8, named `^[A-Za-z0-9._-]{1,100}$`,
 * and every placeholder its method's and placed where its quoting holds
 * (render.ts). A refusal names the relative path (and a line), never the
 * template's text. Each file's mode in the bundle is from a fixed list
 * (a ConfigMap loses modes): start_supervisor.sh 0700 (it holds the values
 * typed for the configuration's variables, and runs as root), any other
 * 0644. The templates are the operator's own code, run as root on a host:
 * these checks keep Telflo's values where their quoting holds, not a
 * template's own commands safe.
 */

export const TEMPLATES_SETTING = "TELFLO_INSTALL_TEMPLATES_DIR";
export const TEMPLATE_FILES_MAXIMUM = 32;
export const TEMPLATE_FILE_MAXIMUM_BYTES = 256 * 1024;
const TEMPLATE_FILE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const EXECUTABLE_FILES: ReadonlySet<string> = new Set(["start_supervisor.sh"]);

export interface TemplateFile {
  name: string;
  text: string;
  mode: 0o700 | 0o644;
}

/** A template set that can't be used: its relative path (and a line), and the platform's words for why. */
export class InstallTemplatesError extends Error {
  readonly method: InstallMethod | null;
  /** The file's path under the root (`linux/all-in-one/README.md`), or the method's directory, or null for the root. */
  readonly file: string | null;
  readonly reason: string;

  constructor(method: InstallMethod | null, file: string | null, reason: string) {
    super(`The install templates (${TEMPLATES_SETTING}) can't be used: ${file ?? "the directory"}: ${reason}`);
    this.name = "InstallTemplatesError";
    this.method = method;
    this.file = file;
    this.reason = reason;
  }
}

export interface InstallTemplateLoader {
  /** The method's files, read now, sorted by name. Throws InstallTemplatesError. */
  load(method: InstallMethod): Promise<TemplateFile[]>;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Up to `limit + 1` bytes of the open file, so a file grown since its fstat is still refused. */
async function readBounded(handle: FileHandle, limit: number): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return length > limit ? undefined : buffer.subarray(0, length);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function createInstallTemplateLoader(root: string): InstallTemplateLoader {
  let resolvedRoot: string | undefined;

  async function rootPath(): Promise<string> {
    if (resolvedRoot !== undefined) return resolvedRoot;
    if (!isAbsolute(root)) throw new InstallTemplatesError(null, null, `not an absolute path (${root})`);
    let resolved: string;
    try {
      resolved = await realpath(root);
    } catch (error) {
      throw new InstallTemplatesError(null, null, errorCode(error) === "ENOENT" ? `doesn't exist (${root})` : `can't be read (${root})`);
    }
    resolvedRoot = resolved;
    return resolved;
  }

  /** `name` as listed in `listed` (the method directory, or the `..data` it holds), kept inside `directory`. */
  async function readFile(method: InstallMethod, directory: string, listed: string, name: string): Promise<TemplateFile> {
    const relative = `linux/${method}/${name}`;
    const refuse = (reason: string) => new InstallTemplatesError(method, relative, reason);
    if (!TEMPLATE_FILE_NAME.test(name)) throw refuse("a name of more than letters, digits, dots, dashes and underscores");
    let target = join(listed, name);
    const entry = await lstat(target).catch(() => {
      throw refuse("can't be read");
    });
    if (entry.isSymbolicLink()) {
      const resolved = await realpath(target).catch(() => {
        throw refuse("a link that can't be followed");
      });
      if (!resolved.startsWith(directory + sep)) throw refuse("a link leaving its directory");
      target = resolved;
      const linked = await lstat(target).catch(() => {
        throw refuse("can't be read");
      });
      if (!linked.isFile()) throw refuse("not a regular file");
    } else if (!entry.isFile()) {
      throw refuse("not a regular file");
    }
    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ELOOP" || code === "EMLINK") throw refuse("a link");
      throw refuse("can't be read");
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw refuse("not a regular file");
      if (stats.size > TEMPLATE_FILE_MAXIMUM_BYTES) throw refuse("over 256 KiB");
      const bytes = await readBounded(handle, TEMPLATE_FILE_MAXIMUM_BYTES).catch(() => {
        throw refuse("can't be read");
      });
      if (bytes === undefined) throw refuse("over 256 KiB");
      let text: string;
      try {
        text = UTF8.decode(bytes);
      } catch {
        throw refuse("not UTF-8 text");
      }
      const problem = templateProblem(method, name, text);
      if (problem !== null) throw refuse(`line ${problem.line}: ${problem.reason}`);
      return { name, text, mode: EXECUTABLE_FILES.has(name) ? 0o700 : 0o644 };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    async load(method) {
      const realRoot = await rootPath();
      const relative = `linux/${method}`;
      let directory: string;
      try {
        directory = await realpath(join(realRoot, "linux", method));
      } catch (error) {
        throw new InstallTemplatesError(method, relative, errorCode(error) === "ENOENT" ? "missing" : "can't be read");
      }
      if (!directory.startsWith(realRoot + sep)) throw new InstallTemplatesError(method, relative, "outside the directory");
      // A ConfigMap mounted flat here: its `..data` resolved first, once, and the directory it names listed and
      // read (Ruling 62): a swap after this line leaves this read on one version, its keys and their text alike.
      const data = await realpath(join(directory, "..data")).catch(() => undefined);
      if (data !== undefined && !data.startsWith(directory + sep)) throw new InstallTemplatesError(method, relative, "outside the directory");
      const listed = data ?? directory;
      let names: string[];
      try {
        names = await readdir(listed);
      } catch (error) {
        throw new InstallTemplatesError(method, relative, errorCode(error) === "ENOTDIR" ? "not a directory" : "can't be read");
      }
      const shown = names.filter((name) => !name.startsWith(".")).sort();
      if (shown.length === 0) throw new InstallTemplatesError(method, relative, "no files");
      if (shown.length > TEMPLATE_FILES_MAXIMUM) throw new InstallTemplatesError(method, relative, `more than ${TEMPLATE_FILES_MAXIMUM} files`);
      const files: TemplateFile[] = [];
      for (const name of shown) files.push(await readFile(method, directory, listed, name));
      return files;
    },
  };
}

/**
 * The start-up check (decision 36): both methods' sets present, readable,
 * within bounds and with no unknown or misplaced placeholder. Throws
 * InstallTemplatesError naming the setting and the file, never its text.
 */
export async function checkInstallTemplates(loader: InstallTemplateLoader): Promise<void> {
  for (const method of INSTALL_METHODS) await loader.load(method);
}
