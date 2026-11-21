import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";

// A file the page saves (a download), read back in the browser tests: the
// editor's Testing tab's run files (test-runs.e2e.ts) and the install
// dialog's Linux bundle (install.e2e.ts).

/** The file a click downloads: its suggested name and its bytes. */
export async function downloaded(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const download = page.waitForEvent("download");
  await click();
  const file = await download;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}
