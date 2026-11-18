/*
 * The CLI's version, read from its own package.json at run time (one
 * source of truth: what `npm pack` ships). From `dist/version.js` and from
 * `src/version.ts` alike, the manifest is one folder up. It imports only
 * node's built-ins: the browser tests import the listener, which imports
 * this (D27 decision 20, Preflight ruling 17).
 */

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export const VERSION: string = manifest.version;
