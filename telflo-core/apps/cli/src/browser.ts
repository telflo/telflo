/*
 * Opening the person's browser on a URL (D27 decision 20): `open` on macOS, `cmd /c start` on Windows, `xdg-open`
 * elsewhere. The URL is one argument, never a shell string. A missing
 * opener is no failure: the login prints the URL too.
 */

import { spawn, type SpawnOptions } from "node:child_process";

export interface BrowserCommand {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/**
 * The platform's command opening `url`. On Windows, cmd.exe splits an
 * unquoted `&` into a second command, so the URL is quoted and passed
 * verbatim, after the empty title `start` takes from its first quoted
 * argument; a double quote in the URL (which would end the quoting) is
 * percent-encoded first.
 */
export function browserCommand(url: string, platform: NodeJS.Platform): BrowserCommand {
  const options: SpawnOptions = { detached: true, stdio: "ignore" };
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", '""', `"${url.replaceAll('"', "%22")}"`], options: { ...options, windowsVerbatimArguments: true } };
  }
  if (platform === "darwin") return { command: "open", args: [url], options };
  return { command: "xdg-open", args: [url], options };
}

/** Opens `url` in the browser, if the platform's opener runs; whether it was started. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const { command, args, options } = browserCommand(url, platform);
  try {
    const child = spawn(command, args, options);
    // No opener (no xdg-open, say): the URL is printed, so this is no failure.
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
