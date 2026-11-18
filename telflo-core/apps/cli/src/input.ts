/*
 * A command's input text (a configuration's YAML, a spec, a sample): a
 * file, or stdin for `-`. Shared by the command
 * areas (Preflight ruling 22); the text is configuration text and is never
 * printed or logged here.
 */

import { readFileSync } from "node:fs";
import { EXIT, ExitError, getIo } from "./output.js";

export const CANNOT_READ_MESSAGE = (path: string): string => `Can't read the file ${path}.`;

/** The text of `fileOrDash`: the file's, or all of stdin's for `-`. A file that can't be read is exit 2. */
export async function readInput(fileOrDash: string): Promise<string> {
  if (fileOrDash === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of getIo().stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
    return Buffer.concat(chunks).toString("utf8");
  }
  try {
    return readFileSync(fileOrDash, "utf8");
  } catch {
    throw new ExitError(CANNOT_READ_MESSAGE(fileOrDash), EXIT.USAGE);
  }
}
