/*
 * The credentials file (D27 decisions 9 and 14, Preflight ruling 12):
 * `$TELFLO_CLI_CONFIG_DIR/credentials.json`, else
 * `$XDG_CONFIG_HOME/telflo/credentials.json`, else
 * `~/.config/telflo/credentials.json`. The older Telflo CLI's `~/.telflo` is
 * never read, nor `TELFLO_CONFIG_DIR`: the older CLI reads that variable and
 * names its file `credentials.json` too, so the two CLIs would share one
 * file (Ruling 232).
 *
 * - JSON `{ version: 1, server, token, kind, tokenName, organizationId }`;
 *   no expiry (`/whoami` carries none).
 * - Written atomically: a temporary file in the same folder, created with
 *   mode 0600 (`wx`), renamed over the old. The folder is created 0700.
 * - On POSIX, a file readable (or writable) by group or others, or a folder
 *   writable by them, is refused with the `chmod` to run; nothing is read
 *   from such a file.
 * - An unknown `version` or shape is refused ("run telflo login"), never
 *   guessed.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalIdOf } from "./ids.js";
import { EXIT, ExitError } from "./output.js";
import { serverOrigin } from "./server.js";

/** A `tf_` token: the prefix and 43 base64url characters (32 random bytes). */
export const TOKEN_PATTERN = /^tf_[A-Za-z0-9_-]{43}$/;

export const CREDENTIALS_VERSION = 1;

export type TokenKind = "person" | "service_account";

export interface Credentials {
  version: typeof CREDENTIALS_VERSION;
  /** The origin the token was entered for: the only one it is sent to. */
  server: string;
  token: string;
  kind: TokenKind;
  tokenName: string;
  /** A person's chosen organization, or a service account's own. */
  organizationId: string;
}

const CREDENTIALS_KEYS = ["version", "server", "token", "kind", "tokenName", "organizationId"] as const;

/** Group and others' bits: none may be set on the file. */
const FILE_SHARED_BITS = 0o077;
/** Group and others' write bits: none may be set on the folder. */
const FOLDER_WRITABLE_BITS = 0o022;

/** POSIX file modes are checked; Windows' ACLs on the user's profile cover it there. */
function checksModes(): boolean {
  return process.platform !== "win32";
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** The folder the file lives in (decision 9). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = nonEmpty(env.TELFLO_CLI_CONFIG_DIR);
  if (explicit !== undefined) return explicit;
  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  if (xdg !== undefined) return join(xdg, "telflo");
  return join(homedir(), ".config", "telflo");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.json");
}

/** logout's refusal of a folder, a link or a FIFO in the file's place: left as it is. */
export const NOT_A_FILE_MESSAGE = (path: string): string =>
  `The credentials file ${path} isn't a file this CLI wrote: remove it yourself.`;

const NOT_OURS_MESSAGE = (path: string): string =>
  `The credentials file ${path} isn't one this CLI can read: run telflo login.`;

/** What other users can do with the file, from its group and others' bits. */
function sharedWords(mode: number): string {
  const read = (mode & 0o044) !== 0;
  const write = (mode & 0o022) !== 0;
  if (read && write) return "can be read and written by other users";
  if (write) return "can be written by other users";
  if (read) return "can be read by other users";
  return "can be used by other users";
}

export const FILE_SHARED_MESSAGE = (path: string, mode: number): string =>
  `The credentials file ${path} ${sharedWords(mode)}: run chmod 600 ${path}, or telflo login.`;

export const FOLDER_SHARED_MESSAGE = (dir: string): string =>
  `The folder ${dir} can be written by other users: run chmod 700 ${dir}.`;

/** The folder may not be writable by group or others (another user could swap the file). */
function assertFolderPrivate(dir: string): void {
  if (!checksModes()) return;
  let mode: number;
  try {
    mode = statSync(dir).mode;
  } catch {
    return;
  }
  if ((mode & FOLDER_WRITABLE_BITS) !== 0) throw new ExitError(FOLDER_SHARED_MESSAGE(dir), EXIT.AUTH);
}

function isCredentials(value: unknown): value is Credentials {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CREDENTIALS_KEYS.length || !CREDENTIALS_KEYS.every((key) => keys.includes(key))) return false;
  const { version, server, token, kind, tokenName, organizationId } = record;
  if (version !== CREDENTIALS_VERSION) return false;
  if (typeof server !== "string" || typeof token !== "string" || typeof tokenName !== "string") return false;
  if (typeof organizationId !== "string" || canonicalIdOf(organizationId) !== organizationId) return false;
  if (kind !== "person" && kind !== "service_account") return false;
  if (!TOKEN_PATTERN.test(token)) return false;
  try {
    return serverOrigin(server) === server;
  } catch {
    return false;
  }
}

/**
 * The stored login, or null when there is no file. Throws an ExitError
 * (exit 3) for a file or folder others can reach, before reading anything,
 * and for a file of another version or shape.
 */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env): Credentials | null {
  const dir = configDir(env);
  const path = credentialsPath(env);
  let descriptor: number;
  try {
    // O_NOFOLLOW: a symbolic link in the file's place is refused, not followed.
    // O_NONBLOCK: a FIFO in its place is opened without waiting, then refused (not a file).
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ExitError(NOT_OURS_MESSAGE(path), EXIT.AUTH);
  }
  try {
    assertFolderPrivate(dir);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new ExitError(NOT_OURS_MESSAGE(path), EXIT.AUTH);
    if (checksModes() && (stats.mode & FILE_SHARED_BITS) !== 0) throw new ExitError(FILE_SHARED_MESSAGE(path, stats.mode), EXIT.AUTH);
    const text = readFileSync(descriptor, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ExitError(NOT_OURS_MESSAGE(path), EXIT.AUTH);
    }
    if (!isCredentials(parsed)) throw new ExitError(NOT_OURS_MESSAGE(path), EXIT.AUTH);
    return parsed;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The stored server only, for `login`'s default (decision 12): undefined
 * when there is no file or it is refused (nothing is read from a file
 * others can reach; login then writes a new one).
 */
export function storedServer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return loadCredentials(env)?.server;
  } catch {
    return undefined;
  }
}

/** Writes the file atomically, mode 0600 in a 0700 folder (decision 14). */
export function saveCredentials(credentials: Credentials, env: NodeJS.ProcessEnv = process.env): void {
  if (!isCredentials(credentials)) throw new ExitError("The CLI refused to store an incomplete login.", EXIT.API);
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertFolderPrivate(dir);
  const path = credentialsPath(env);
  const temporary = join(dir, `.credentials-${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeSync(descriptor, `${JSON.stringify(credentials, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Already renamed, or never written.
    }
    throw error;
  }
}

/**
 * Removes the file; whether there was one. Anything else in its place (a
 * folder, a symbolic link, dangling or not, a FIFO) is left as it is and
 * refused in fixed words (exit 3).
 */
export function deleteCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = credentialsPath(env);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  if (!stats.isFile()) throw new ExitError(NOT_A_FILE_MESSAGE(path), EXIT.AUTH);
  unlinkSync(path);
  return true;
}
