#!/usr/bin/env node
// Checks that no development-only npm package is installed under a
// workspace root (published images must not contain dev dependencies):
//
//   node scripts/check-no-dev-dependencies.mjs <package-lock.json> <root>
//
// It reads the lockfile and looks, for every entry under a node_modules
// folder that the lock marks "dev": true (needed only to develop: tsx,
// TypeScript, Vite, the test runners, ...), whether <root>/<its path> exists.
// "devOptional" entries (dev in one place, an optional peer in another) are
// allowed and listed. A workspace link whose target isn't there holds nothing
// and counts as absent. Nothing is written.
//
// A built image is checked from inside, with the lock and this script
// mounted read-only (node is the image's own):
//
//   docker run --rm --read-only --network none --user 1000:1000 \
//     -v "$PWD/telflo-core/package-lock.json:/check/package-lock.json:ro" \
//     -v "$PWD/scripts/check-no-dev-dependencies.mjs:/check/check.mjs:ro" \
//     --entrypoint node <image> /check/check.mjs /check/package-lock.json /app
//
// Exit status: 0 none present; 1 at least one present (the first 20 named);
// 2 a usage error, a lock that can't be read, or a root with no
// node_modules (nothing to check is a failure, never a pass).
// Its self-test is scripts/check-no-dev-dependencies.test.sh.
import console from "node:console";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const PROGRAM = "check-no-dev-dependencies";
const SHOWN = 20;

// The check; its exit status is returned (process.exitCode, so the output
// reaches a pipe in full before the process ends).
function main(args) {
  const refuse = (message) => {
    console.error(`${PROGRAM}: ${message}`);
    return 2;
  };
  const [lockPath, root, ...extra] = args;
  if (!lockPath || !root || extra.length > 0) return refuse("usage: check-no-dev-dependencies.mjs <package-lock.json> <root>");

  let packages;
  try {
    packages = JSON.parse(readFileSync(lockPath, "utf8")).packages;
  } catch {
    return refuse(`can't read ${lockPath} as a package-lock.json`);
  }
  if (!packages || typeof packages !== "object") return refuse(`${lockPath} has no "packages" (lockfileVersion 2 or 3)`);
  let hasNodeModules = false;
  try {
    hasNodeModules = statSync(join(root, "node_modules")).isDirectory();
  } catch {
    hasNodeModules = false;
  }
  if (!hasNodeModules) return refuse(`${root} has no node_modules folder: nothing to check`);

  const installable = (path) => path.startsWith("node_modules/") || path.includes("/node_modules/");
  const present = [];
  const devOptional = [];
  let checked = 0;
  for (const [path, entry] of Object.entries(packages)) {
    if (!installable(path) || !entry || typeof entry !== "object") continue;
    checked += 1;
    if (!existsSync(join(root, path))) continue;
    if (entry.dev === true) present.push(path);
    else if (entry.devOptional === true) devOptional.push(path);
  }

  console.log(`${PROGRAM}: ${checked} installable lock entries checked under ${root}`);
  console.log(`${PROGRAM}: devOptional present (allowed): ${devOptional.length ? devOptional.join(" ") : "none"}`);
  if (present.length === 0) {
    console.log(`${PROGRAM}: OK, no development-only package present`);
    return 0;
  }
  console.log(`${PROGRAM}: FAIL, ${present.length} development-only packages present:`);
  for (const path of present.slice(0, SHOWN)) console.log(`  ${path}`);
  if (present.length > SHOWN) console.log(`  … and ${present.length - SHOWN} more`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
