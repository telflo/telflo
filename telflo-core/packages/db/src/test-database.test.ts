import { describe, expect, it } from "vitest";
import { databaseName, testDatabaseUrl, testMigrationDatabaseUrl } from "./test-database.js";

const DEV = "postgresql://telflo_platform_owner:telflo-local@localhost:55432/telflo_platform";

describe("testDatabaseUrl", () => {
  it("appends _test to the development database's name", () => {
    expect(testDatabaseUrl({ TELFLO_DATABASE_URL: DEV })).toBe(
      "postgresql://telflo_platform_owner:telflo-local@localhost:55432/telflo_platform_test",
    );
  });

  it("keeps the query string, credentials, host and port", () => {
    const url = testDatabaseUrl({
      TELFLO_DATABASE_URL: "postgresql://app:p%40ss@db.internal:6543/telflo_platform?sslmode=require&application_name=x",
    });
    expect(url).toBe("postgresql://app:p%40ss@db.internal:6543/telflo_platform_test?sslmode=require&application_name=x");
  });

  it("is idempotent: a database already named *_test is used as it is, never *_test_test", () => {
    const once = testDatabaseUrl({ TELFLO_DATABASE_URL: DEV });
    expect(testDatabaseUrl({ TELFLO_DATABASE_URL: once })).toBe(once);
  });

  it("uses TELFLO_TEST_DATABASE_URL over TELFLO_DATABASE_URL when set", () => {
    const explicit = "postgresql://ci:ci@elsewhere:5432/suite_test?sslmode=disable";
    expect(testDatabaseUrl({ TELFLO_DATABASE_URL: DEV, TELFLO_TEST_DATABASE_URL: explicit })).toBe(explicit);
    expect(testDatabaseUrl({ TELFLO_TEST_DATABASE_URL: explicit })).toBe(explicit);
  });

  it("treats an empty TELFLO_TEST_DATABASE_URL as unset", () => {
    expect(testDatabaseUrl({ TELFLO_DATABASE_URL: DEV, TELFLO_TEST_DATABASE_URL: "" })).toMatch(/\/telflo_platform_test$/);
  });

  it("refuses a TELFLO_TEST_DATABASE_URL whose database does not end in _test, rather than suffixing it", () => {
    expect(() => testDatabaseUrl({ TELFLO_DATABASE_URL: DEV, TELFLO_TEST_DATABASE_URL: DEV })).toThrow(
      /Refusing to run tests against database "telflo_platform" \(from TELFLO_TEST_DATABASE_URL\).*must end in "_test"/,
    );
    expect(() =>
      testDatabaseUrl({ TELFLO_TEST_DATABASE_URL: "postgresql://u:p@h/telflo_testing?sslmode=require" }),
    ).toThrow(/Refusing to run tests against database "telflo_testing"/);
  });

  it("checks the database name, not the query string", () => {
    expect(() =>
      testDatabaseUrl({ TELFLO_TEST_DATABASE_URL: "postgresql://u:p@h/telflo_platform?application_name=x_test" }),
    ).toThrow(/Refusing to run tests against database "telflo_platform"/);
  });

  it("refuses a URL that names no database, without echoing its password", () => {
    const run = () => testDatabaseUrl({ TELFLO_DATABASE_URL: "postgresql://u:hunter2@h:5432/" });
    expect(run).toThrow(/TELFLO_DATABASE_URL names no database/);
    expect(run).not.toThrow(/hunter2/);
  });

  it("refuses when neither variable is set", () => {
    expect(() => testDatabaseUrl({})).toThrow(/TELFLO_DATABASE_URL \(or TELFLO_TEST_DATABASE_URL\)/);
  });

  it("refuses a value that is not a URL", () => {
    expect(() => testDatabaseUrl({ TELFLO_DATABASE_URL: "not a url" })).toThrow(/TELFLO_DATABASE_URL is not a valid URL/);
  });
});

describe("testMigrationDatabaseUrl", () => {
  const OWNER = "postgresql://telflo_platform_owner:telflo-local@localhost:55432/telflo_platform";

  it("appends _test to the owner's database, as for the application role", () => {
    expect(testMigrationDatabaseUrl({ TELFLO_MIGRATION_DATABASE_URL: OWNER })).toBe(
      "postgresql://telflo_platform_owner:telflo-local@localhost:55432/telflo_platform_test",
    );
  });

  it("uses TELFLO_TEST_MIGRATION_DATABASE_URL over TELFLO_MIGRATION_DATABASE_URL when set", () => {
    const explicit = "postgresql://ci:ci@elsewhere:5432/suite_test";
    expect(
      testMigrationDatabaseUrl({ TELFLO_MIGRATION_DATABASE_URL: OWNER, TELFLO_TEST_MIGRATION_DATABASE_URL: explicit }),
    ).toBe(explicit);
  });

  it("refuses a TELFLO_TEST_MIGRATION_DATABASE_URL whose database does not end in _test", () => {
    expect(() => testMigrationDatabaseUrl({ TELFLO_TEST_MIGRATION_DATABASE_URL: OWNER })).toThrow(
      /Refusing to run tests against database "telflo_platform" \(from TELFLO_TEST_MIGRATION_DATABASE_URL\)/,
    );
  });

  it("refuses when neither variable is set, pointing at .env.example, whatever TELFLO_DATABASE_URL says", () => {
    expect(() => testMigrationDatabaseUrl({ TELFLO_DATABASE_URL: DEV })).toThrow(
      /Tests need TELFLO_MIGRATION_DATABASE_URL \(or TELFLO_TEST_MIGRATION_DATABASE_URL\).*\.env\.example/,
    );
  });
});

describe("the shared test setup (vitest.setup.ts)", () => {
  it("points this process's TELFLO_DATABASE_URL and TELFLO_MIGRATION_DATABASE_URL at one database whose name ends in _test", () => {
    const application = databaseName(new URL(process.env.TELFLO_DATABASE_URL!));
    expect(application).toMatch(/_test$/);
    expect(databaseName(new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!))).toBe(application);
  });

  it("clears development-only overrides, so settings take their deployed defaults", () => {
    // "" rather than absent, so a later process.loadEnvFile cannot refill it.
    for (const name of [
      "TELFLO_COOKIE_SECURE",
      "TELFLO_TRUST_PROXY_HOPS",
      "TELFLO_WEB_ORIGIN",
      "TELFLO_ACCESS_TOKEN_TTL_MINUTES",
      "TELFLO_REFRESH_TOKEN_TTL_DAYS",
      "TELFLO_SMTP_ALLOW_INSECURE",
    ]) {
      expect(process.env[name], name).toBe("");
    }
  });
});
