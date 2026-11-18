import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadSettings } from "../settings.js";

// The collector tester's development secret lives in three places that must
// agree (D14a decision 30, Preflight ruling 4): the file the tester reads
// (docker/otelcol-testing/development-secret, through compose's `secrets:`),
// the compose anchor the API's environment takes it from
// (x-otelcol-testing-secret), and .env.example's line for the native API.
// A drift would leave the API refused with 401 on every run. Compose's
// wiring of the API to the tester is checked here too: the URL, the
// internal network, and `depends_on` started (not healthy).

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const read = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");

/** The secret file's text, its one trailing newline dropped. */
const fileSecret = read("docker/otelcol-testing/development-secret").replace(/\n$/, "");

interface ComposeFile {
  "x-otelcol-testing-secret": string;
  services: Record<
    string,
    {
      environment?: Record<string, string>;
      networks?: string[] | Record<string, unknown>;
      depends_on?: Record<string, { condition: string }>;
    }
  >;
  secrets: Record<string, { file: string }>;
}

const compose = parseYaml(read("docker-compose.yml")) as ComposeFile;
const api = compose.services["api"]!;

/** A service's networks by name: Compose takes a list or a mapping (the API's, for its alias). */
const networksOf = (service: { networks?: string[] | Record<string, unknown> } | undefined): string[] =>
  Array.isArray(service?.networks) ? service.networks : Object.keys(service?.networks ?? {});

describe("the collector tester's development secret and compose wiring", () => {
  it("the file holds one line, at least 32 bytes, as the tester requires", () => {
    expect(read("docker/otelcol-testing/development-secret")).toBe(`${fileSecret}\n`);
    expect(fileSecret).not.toMatch(/\s/);
    expect(Buffer.byteLength(fileSecret)).toBeGreaterThanOrEqual(32);
  });

  it("compose's anchor equals the file, and the API's environment takes it", () => {
    expect(compose["x-otelcol-testing-secret"]).toBe(fileSecret);
    expect(api.environment?.TELFLO_OTELCOL_TESTING_SECRET).toBe(fileSecret);
    expect(compose.secrets.otelcol_testing_secret?.file).toBe("./docker/otelcol-testing/development-secret");
  });

  it("the API calls the tester directly on its internal network, once it has started", () => {
    expect(api.environment?.TELFLO_OTELCOL_TESTING_URL).toBe("http://otelcol-testing:8002");
    expect(networksOf(api)).toContain("otelcol-testing");
    expect(api.depends_on?.["otelcol-testing"]).toEqual({ condition: "service_started" });
  });

  it("the API's compose environment loads, with the tester's settings", () => {
    // Compose interpolates `${…}` from its own environment; unset, each is
    // empty, or its `:-` or `-` default (the agent endpoint's, D17c-1; the
    // site's, D36-1).
    const environment = Object.fromEntries(
      Object.entries(api.environment ?? {}).map(([name, value]) => [
        name,
        String(value).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-([^}]*))?\}/g, (_reference, fallback: string | undefined) => fallback ?? ""),
      ]),
    );
    const settings = loadSettings(environment);
    expect(settings.otelcolTesting).toEqual({ url: "http://otelcol-testing:8002", secret: fileSecret });
    expect(settings.testRuns).toEqual({ runsPerTester: 4, downFailAfterSeconds: 600 });
  });

  it(".env.example names the forwarder on 127.0.0.1:51237 and the same secret, for the native API", () => {
    const example = parseEnv(read("telflo-core/.env.example"));
    expect(example.TELFLO_OTELCOL_TESTING_URL).toBe("http://127.0.0.1:51237");
    expect(example.TELFLO_OTELCOL_TESTING_SECRET).toBe(fileSecret);
  });
});
