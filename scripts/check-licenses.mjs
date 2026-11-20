#!/usr/bin/env node
// Fails if any production npm dependency carries a license that does not
// allow redistribution. telflo is installed by customers, including as an
// air-gapped bundle, so everything it ships must be redistributable.
//
// Usage: check-licenses.mjs <package-lock.json> [license-policy.json]
//
// Reads the lockfile rather than node_modules, so it needs no install and
// gives the same answer on every machine. Dev-only packages (build tools,
// test runners) are skipped: they never ship. Everything else, including
// devOptional and optional packages, is checked, erring on the side of
// counting a package as shipped.
//
// It also checks the files vendored into the source instead of installed (the
// policy's "vendored": Swagger UI for the API reference page): each folder's
// licenses must be allowed, and the folder must hold exactly the files listed
// (no sub-folder), each with its recorded sha256, so a vendored file can't
// change, or another be added, without its licenses being looked at again
// (docs/third-party-assets.md records the same).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [lockfilePath, policyPath = join(dirname(fileURLToPath(import.meta.url)), "license-policy.json")] =
  process.argv.slice(2);

if (!lockfilePath) {
  console.error("usage: check-licenses.mjs <package-lock.json> [license-policy.json]");
  process.exit(2);
}

const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const allowed = new Set(policy.allowed);
const exceptions = Object.fromEntries(
  Object.entries(policy.exceptions ?? {}).filter(([name]) => !name.startsWith("$")),
);

if (lockfile.lockfileVersion < 2 || !lockfile.packages) {
  console.error(`ERROR: ${lockfilePath} is not an npm v7+ lockfile (lockfileVersion 2 or 3).`);
  process.exit(2);
}

/**
 * Whether an SPDX expression is satisfied by the allowed list. "A OR B" needs
 * one allowed side (we may choose it); "A AND B" needs both. Parentheses are
 * supported. Anything unparseable — "SEE LICENSE IN ...", "UNLICENSED", a
 * missing field — is not allowed.
 */
function isAllowed(expression) {
  if (typeof expression !== "string" || expression.trim() === "") return false;
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;

  function parseOr() {
    let result = parseAnd();
    while (tokens[position]?.toUpperCase() === "OR") {
      position++;
      const right = parseAnd();
      result = result || right;
    }
    return result;
  }
  function parseAnd() {
    let result = parseTerm();
    while (tokens[position]?.toUpperCase() === "AND") {
      position++;
      const right = parseTerm();
      result = result && right;
    }
    return result;
  }
  function parseTerm() {
    const token = tokens[position++];
    if (token === "(") {
      const result = parseOr();
      if (tokens[position++] !== ")") throw new Error("unbalanced parentheses");
      return result;
    }
    if (token === undefined || token === ")") throw new Error("unexpected end");
    // "Apache-2.0 WITH LLVM-exception": exceptions only ever grant permissions.
    if (tokens[position]?.toUpperCase() === "WITH") position += 2;
    return allowed.has(token.replace(/\+$/, ""));
  }

  try {
    const result = parseOr();
    return position === tokens.length && result;
  } catch {
    return false;
  }
}

const violations = [];
let checked = 0;

for (const [path, entry] of Object.entries(lockfile.packages)) {
  // "" is the root project; paths outside node_modules are this repository's
  // own workspace packages, which are telflo itself, not third-party code.
  if (!path.includes("node_modules/")) continue;
  if (entry.link) continue; // a symlink to one of those workspace packages
  if (entry.dev) continue;

  const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  checked++;
  if (isAllowed(entry.license)) continue;
  // An exception names a package ("name"), or one version of it
  // ("name@version"), whose license was checked by hand at that version.
  if (exceptions[name] || exceptions[`${name}@${entry.version}`]) continue;
  violations.push(`${name}@${entry.version ?? "?"}: ${entry.license ?? "(no license field)"}`);
}

// The vendored folders, each path relative to the policy file.
const vendored = Object.entries(policy.vendored ?? {}).filter(([path]) => !path.startsWith("$"));
let vendoredFiles = 0;
for (const [path, entry] of vendored) {
  const folder = resolve(dirname(policyPath), path);
  const licenses = entry.licenses ?? [];
  if (licenses.length === 0) violations.push(`vendored ${path}: no licenses recorded`);
  for (const license of licenses) {
    if (!isAllowed(license)) violations.push(`vendored ${path}: ${license}`);
  }
  const recorded = entry.files ?? {};
  let present;
  try {
    present = readdirSync(folder).filter((name) => statSync(join(folder, name)).isFile());
  } catch {
    violations.push(`vendored ${path}: the folder can't be read`);
    continue;
  }
  for (const name of readdirSync(folder)) {
    if (!statSync(join(folder, name)).isFile()) violations.push(`vendored ${path}/${name}: not a file (a vendored folder holds files only)`);
  }
  for (const name of present) {
    if (!(name in recorded)) violations.push(`vendored ${path}/${name}: not recorded in the policy`);
  }
  for (const [name, sha256] of Object.entries(recorded)) {
    if (!present.includes(name)) {
      violations.push(`vendored ${path}/${name}: missing`);
      continue;
    }
    vendoredFiles++;
    const actual = createHash("sha256").update(readFileSync(join(folder, name))).digest("hex");
    if (actual !== sha256) violations.push(`vendored ${path}/${name}: its sha256 isn't the recorded one (changed without a license review)`);
  }
}

if (violations.length > 0) {
  console.error("ERROR: production dependencies with licenses that are not approved for redistribution:");
  for (const violation of [...new Set(violations)].sort()) console.error(`  ${violation}`);
  console.error("");
  console.error("telflo ships to customers, so every shipped dependency must allow redistribution.");
  console.error("Replace the dependency: only a license that allows redistribution may be added to license-policy.json (ADR 0019).");
  console.error("A vendored file's change: check its licenses, then update license-policy.json and docs/third-party-assets.md.");
  process.exit(1);
}

console.log(
  `License check passed: ${checked} production packages, all redistributable` +
    (vendored.length > 0 ? `; ${vendoredFiles} vendored files in ${vendored.length} folder(s), as recorded.` : "."),
);
