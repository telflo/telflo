// The API image's build stage only (telflo-core/Dockerfile's api-build), run
// from the workspace's root after `tsc -p <package>/tsconfig.build.json` has
// emitted each package's dist/:
//
//   1. copies every file under each package's src/ that tsc doesn't emit (not
//      a .ts file; nothing under testing/) to dist/ at the same path, so the
//      files read relative to import.meta.url (the API reference page's
//      Swagger UI, its index.html and init.js, the OpenAPI fragments) sit
//      beside the code that reads them;
//   2. points the three workspace packages' package.json at dist/: `main`
//      ./dist/index.js, no `types`, and @telflo/db's `exports` its root alone
//      (./testing and ./test-database are test support, never built).
//
// Development never runs it: the checkout's packages keep pointing at src/,
// which tsx and vitest read. It refuses (exit 1) when a package has no
// dist/index.js or when dist/ holds anything tsconfig.build.json excludes (a
// *.test.js, testing/ or testing.js, test-database.js, write-seeded-*.js,
// seeded-*-fixture.js), so a dropped exclude fails the image's build rather
// than shipping test code.
import console from "node:console";
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";

const PACKAGES = ["packages/contracts", "packages/db", "apps/api"];

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

const isTestSupport = (rel) => rel === "testing" || rel.startsWith(`testing${sep}`);
// tsconfig.build.json's excludes, as tsc would emit them (rel is relative to dist/).
const isExcludedOutput = (rel) =>
  /\.test\.js$/.test(rel) ||
  isTestSupport(rel) ||
  /^(testing|test-database|write-seeded-[^/\\]*|seeded-[^/\\]*-fixture)\.js$/.test(rel);

let problems = 0;
for (const pkg of PACKAGES) {
  const src = join(pkg, "src");
  const dist = join(pkg, "dist");
  if (!existsSync(join(dist, "index.js"))) {
    console.error(`point-at-dist: ${pkg} has no dist/index.js: run tsc -p ${pkg}/tsconfig.build.json first`);
    problems += 1;
    continue;
  }
  const tests = filesUnder(dist).filter((file) => isExcludedOutput(relative(dist, file)));
  for (const file of tests) console.error(`point-at-dist: ${file} is test code: tsconfig.build.json must exclude it`);
  problems += tests.length;

  let assets = 0;
  for (const file of filesUnder(src)) {
    const rel = relative(src, file);
    if (rel.endsWith(".ts") || isTestSupport(rel)) continue;
    cpSync(file, join(dist, rel));
    assets += 1;
  }

  const manifestPath = join(pkg, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.main = "./dist/index.js";
  delete manifest.types;
  if (manifest.exports) manifest.exports = { ".": "./dist/index.js" };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`point-at-dist: ${pkg}: ${assets} non-TypeScript files copied to dist/; package.json points at dist/`);
}
process.exitCode = problems === 0 ? 0 : 1;
