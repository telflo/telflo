import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** telflo-core: the Node workspace, whose apps and packages hold every source file. */
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** Build output, dependencies and generated files: not source anyone writes. */
const skippedDirectories = new Set(["node_modules", "dist", "build", "coverage", ".react-router", "test-results"]);

/**
 * Vite's bundled config while it loads one (`vite.config.ts.timestamp-<ms>-<hex>.mjs`,
 * written beside the config and deleted once loaded): generated, and gone
 * before it can be read when a browser run starts during a scan. The config
 * it bundles is scanned itself.
 */
const isViteBundledConfig = (name: string) => /\.timestamp-\d+-[0-9a-f]+\.mjs$/.test(name);

const isSource = (name: string) => /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(name) && !isViteBundledConfig(name);
const isTest = (path: string) => /\.test\.[jt]sx?$/.test(path);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : sourceFiles(path);
    return isSource(entry.name) ? [path] : [];
  });
}

/** Every non-test source file under apps/ and packages/, relative to the workspace, with `/` separators. */
const productionSources = () =>
  ["apps", "packages"]
    .flatMap((directory) => sourceFiles(join(workspaceRoot, directory)))
    .map((path) => relative(workspaceRoot, path).split(sep).join("/"))
    .filter((path) => !isTest(path));

const read = (path: string) => readFileSync(join(workspaceRoot, path), "utf8");

describe("the database context's boundaries", () => {
  it("scans real source: the list includes context.ts and authenticate.ts", () => {
    const sources = productionSources();
    expect(sources).toContain("apps/api/src/database/context.ts");
    expect(sources).toContain("apps/api/src/modules/sessions/authenticate.ts");
  });

  it("names telflo.user_id and telflo.organization_id only in context.ts, migrations and tests", () => {
    const offenders = productionSources().filter(
      (path) =>
        path !== "apps/api/src/database/context.ts" &&
        !path.startsWith("packages/db/migrations/") &&
        /telflo\.(?:user_id|organization_id)/.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("names telflo.dispatcher only in context.ts and migrations", () => {
    const offenders = productionSources().filter(
      (path) =>
        path !== "apps/api/src/database/context.ts" &&
        !path.startsWith("packages/db/migrations/") &&
        /telflo\.dispatcher/.test(read(path)),
    );
    expect(offenders).toEqual([]);
    expect(read("apps/api/src/database/context.ts")).toMatch(/telflo\.dispatcher/);
  });

  it("calls withDispatcherContext only from the dispatcher's files and the tester's and the evaluator's health monitors", () => {
    const callers = productionSources().filter(
      (path) =>
        path !== "apps/api/src/database/context.ts" &&
        !path.startsWith("packages/db/migrations/") &&
        /\bwithDispatcherContext\b/.test(read(path)),
    );
    // Named at all, called or imported (an alias would hide a call). The
    // migration's comments name it; nothing there runs it. The dispatcher
    // claims, finishes and releases; the reaper reaps and fails waiting runs;
    // the monitors write otelcol_testing_mark and ottl_evaluator_mark. Nothing
    // else in modules/test-runs/, which answers members' requests, may reach
    // them.
    expect(callers.sort()).toEqual([
      "apps/api/src/modules/test-runs/dispatcher.ts",
      "apps/api/src/modules/test-runs/reaper.ts",
      "apps/api/src/otelcol-testing/health-monitor.ts",
      "apps/api/src/ottl-evaluator/health-monitor.ts",
    ]);
  });

  it("names telflo.product_admin only in context.ts and migrations", () => {
    const offenders = productionSources().filter(
      (path) =>
        path !== "apps/api/src/database/context.ts" &&
        !path.startsWith("packages/db/migrations/") &&
        /telflo\.product_admin/.test(read(path)),
    );
    expect(offenders).toEqual([]);
    expect(read("apps/api/src/database/context.ts")).toMatch(/telflo\.product_admin/);
  });

  it("calls withProductAdminContext only from modules/product-admin/repositories/system-repository.ts", () => {
    const callers = productionSources().filter(
      (path) =>
        path !== "apps/api/src/database/context.ts" &&
        !path.startsWith("packages/db/migrations/") &&
        /\bwithProductAdminContext\b/.test(read(path)),
    );
    // Named at all, called or imported (an alias would hide a call). The
    // SystemRepository is the only code that opens the cross-organization
    // context, and it audits every call in the same transaction.
    expect(callers).toEqual(["apps/api/src/modules/product-admin/repositories/system-repository.ts"]);
  });

  it("names assert_product_admin and the product-admin functions only in system-repository.ts and the migrations", () => {
    const repository = "apps/api/src/modules/product-admin/repositories/system-repository.ts";
    const offenders = productionSources().filter(
      (path) =>
        path !== repository &&
        !path.startsWith("packages/db/migrations/") &&
        /assert_product_admin|product_admin_(?:list|grant|revoke|count|handle|delete|set)_?/.test(read(path)),
    );
    // So no other code can call a definer through raw SQL, past the pin above.
    expect(offenders).toEqual([]);
    expect(read(repository)).toMatch(/product_admin_list_users/);
  });

  it("names is_product_admin only in the files that read the flag for a request, the SystemRepository and feedback's recipients, and migrations", () => {
    const namers = productionSources().filter(
      (path) => !path.startsWith("packages/db/migrations/") && /is_product_admin/.test(read(path)),
    );
    // The exact list. The session check reads the flag on each request
    // (authenticate.ts, session-repository.ts; the contract and the schema
    // type it); the SystemRepository reads it in its functions' rows; and
    // feedback's recipients, a plain query on users outside the product-admin
    // context, are read in feedback-repository.ts alone. Any other code reading who is a
    // product admin across organizations would be a path past the audited
    // one.
    expect(namers.sort()).toEqual([
      "apps/api/src/modules/feedback/repositories/feedback-repository.ts",
      "apps/api/src/modules/product-admin/repositories/system-repository.ts",
      "apps/api/src/modules/sessions/authenticate.ts",
      "apps/api/src/modules/sessions/repositories/session-repository.ts",
      "packages/contracts/src/sessions.ts",
      "packages/db/src/schema.ts",
    ]);
  });

  it("calls withOrganizationContext only from the public download's files, modules/quick-deploy/, and the public logo read", () => {
    const callers = productionSources().filter(
      (path) => path !== "apps/api/src/database/context.ts" && /\bwithOrganizationContext\b/.test(read(path)),
    );
    // Named at all, called or imported (an alias would hide a call). A
    // context with an organization and no person reads past every member's
    // rule but the organization's: only the public download, once a link's
    // secret has found its organization, may open one, and the public logo
    // read, once both ids are canonical, to read that organization's logo's
    // two columns (organizations has no row-level security). The fleets
    // service gets it as a dependency only from the public route's wiring.
    expect(callers.length).toBeGreaterThan(0);
    expect(
      callers.filter(
        (path) =>
          !path.startsWith("apps/api/src/modules/quick-deploy/") &&
          path !== "apps/api/src/modules/organizations/logo-routes.ts",
      ),
    ).toEqual([]);
    expect(callers.sort()).toEqual([
      "apps/api/src/modules/organizations/logo-routes.ts",
      "apps/api/src/modules/quick-deploy/routes.ts",
    ]);
  });

  it("calls createAuthContext only from authenticate.ts", () => {
    const callers = productionSources().filter(
      (path) => path !== "apps/api/src/database/context.ts" && /\bcreateAuthContext\s*\(/.test(read(path)),
    );
    expect(callers).toEqual(["apps/api/src/modules/sessions/authenticate.ts"]);
  });

  it("names createApiTokenContext only in modules/public-api/authenticate-api-token.ts", () => {
    const callers = productionSources().filter(
      (path) => path !== "apps/api/src/database/context.ts" && /\bcreateApiTokenContext\b/.test(read(path)),
    );
    // Named at all, called or imported (an alias or a destructured dynamic
    // import would hide a call). The token's context is built in one place,
    // from the lookup's row: the token check.
    expect(callers).toEqual(["apps/api/src/modules/public-api/authenticate-api-token.ts"]);
    expect(read("apps/api/src/database/context.ts")).toMatch(/\bexport function createApiTokenContext\b/);
  });

  it("names createApiTokenStore only in modules/public-api/authenticate-api-token.ts, which defines it, and routes.ts", () => {
    const callers = productionSources().filter((path) => /\bcreateApiTokenStore\b/.test(read(path)));
    // Named at all, called or imported. Its findLive is the definer lookup
    // by a hash (the pin below): another module holding the store would
    // walk around that pin. The public surface's wiring is its one user.
    expect(callers.sort()).toEqual([
      "apps/api/src/modules/public-api/authenticate-api-token.ts",
      "apps/api/src/modules/public-api/routes.ts",
    ]);
  });

  it("calls findLiveApiTokenByHash only from modules/public-api/authenticate-api-token.ts", () => {
    const callers = productionSources().filter(
      (path) =>
        path !== "apps/api/src/modules/service-accounts/repositories/api-token-repository.ts" &&
        !path.startsWith("packages/db/migrations/") &&
        /\bfindLiveApiTokenByHash\b/.test(read(path)),
    );
    // Named at all, called or imported (an alias would hide a call), outside
    // its defining file; migration 035's comments name it, and nothing there
    // runs it. The lookup reads past row-level security by a token's hash,
    // so only the token check may run it.
    expect(callers).toEqual(["apps/api/src/modules/public-api/authenticate-api-token.ts"]);
  });

  it("names claimPublicSurface only in route-guard.ts, which defines it, plugin.ts and open-routes.ts", () => {
    const callers = productionSources().filter((path) => /\bclaimPublicSurface\b/.test(read(path)));
    // Named at all, called or imported: a plugin that claimed a surface
    // would have its routes verified for /api/public/v1 with no check.
    expect(callers.sort()).toEqual([
      "apps/api/src/modules/public-api/open-routes.ts",
      "apps/api/src/modules/public-api/plugin.ts",
      "apps/api/src/modules/public-api/route-guard.ts",
    ]);
  });

  it("calls setNotFoundHandler only in errors.ts (the root's) and public-api/plugin.ts, and names publicNotFoundOptions only there and in route-guard.ts", () => {
    // Another not-found handler under /api/public/v1 would answer with no token check; the verification refuses any but
    // the plugin's own at request time, and this keeps a second one from being written at all.
    // In code: route-guard.ts' comments name it, to say who may call it.
    const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const setters = productionSources().filter((path) => /\bsetNotFoundHandler\b/.test(withoutComments(read(path))));
    expect(setters.sort()).toEqual(["apps/api/src/errors.ts", "apps/api/src/modules/public-api/plugin.ts"]);
    const namers = productionSources().filter((path) => /\bpublicNotFoundOptions\b/.test(read(path)));
    expect(namers.sort()).toEqual(["apps/api/src/modules/public-api/plugin.ts", "apps/api/src/modules/public-api/route-guard.ts"]);
  });

  it("keeps route-guard.ts' surface and verification symbols its own: unique symbols, never exported", () => {
    const guard = read("apps/api/src/modules/public-api/route-guard.ts");
    expect(guard).toMatch(/^const SURFACE = Symbol\("telflo\.publicApiSurface"\);$/m);
    expect(guard).toMatch(/^const VERIFIED = Symbol\("telflo\.publicApiVerifiedRoute"\);$/m);
    expect(guard).toMatch(/^const verifiedTokens = new WeakMap</m);
    expect(guard).toMatch(/^const PUBLIC_NOT_FOUND = Symbol\("telflo\.publicApiNotFound"\);$/m);
    expect(guard).toMatch(/^const publicNotFoundTokens = new WeakSet</m);
    // Not exported, and not reachable by name from anywhere else.
    expect(
      /export\s+(const|let|var)\s+(SURFACE|VERIFIED|verifiedTokens|PUBLIC_NOT_FOUND|publicNotFoundTokens)\b|export\s*\{[^}]*\b(SURFACE|VERIFIED|verifiedTokens|PUBLIC_NOT_FOUND|publicNotFoundTokens)\b/.test(
        guard,
      ),
    ).toBe(false);
    const others = productionSources().filter(
      (path) =>
        path !== "apps/api/src/modules/public-api/route-guard.ts" &&
        /telflo\.publicApiSurface|telflo\.publicApiVerifiedRoute|telflo\.publicApiNotFound|\bverifiedTokens\b|\bpublicNotFoundTokens\b/.test(read(path)),
    );
    expect(others).toEqual([]);
  });

  it("names find_live_api_token_by_hash only in api-token-repository.ts and the migrations", () => {
    const repository = "apps/api/src/modules/service-accounts/repositories/api-token-repository.ts";
    const offenders = productionSources().filter(
      (path) =>
        path !== repository && !path.startsWith("packages/db/migrations/") && /find_live_api_token_by_hash/.test(read(path)),
    );
    // So no other code can call the definer through raw SQL, past the pin above.
    expect(offenders).toEqual([]);
    expect(read(repository)).toMatch(/find_live_api_token_by_hash/);
  });
});
