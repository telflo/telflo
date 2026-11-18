import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadSettings } from "../settings.js";

// The OTTL evaluator's development secret lives in three places that must
// agree (D15a Preflight ruling 12, as the collector tester's): the file the
// evaluator reads (docker/ottl-evaluator/development-secret, through
// compose's `secrets:`), the compose anchor the API's environment takes it
// from (x-ottl-evaluator-secret), and .env.example's line for the native
// API. A drift would leave the API refused with 401 on every check. Compose's
// lockdown of the evaluator and its wiring to the API are checked here too
// (Preflight ruling 13): its own internal network, which the API joins and
// only the forwarder publishes, `depends_on` healthy, and the API's
// environment (TELFLO_OTTL_EVALUATOR_URL, and the secret taken from the
// anchor), which loadSettings reads (D15a Task 5), as the tester's test does.
// D15a Task 3's follow-up (the controller's Ruling 34) pins the rest of the
// lockdown: the thread and memory limits, the grace period serve's shutdown
// needs, and serve's GOMAXPROCS.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const read = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");

/** The secret file's text, its one trailing newline dropped. */
const fileSecret = read("docker/ottl-evaluator/development-secret").replace(/\n$/, "");

interface ComposeService {
  environment?: Record<string, string>;
  networks?: string[] | Record<string, unknown>;
  depends_on?: Record<string, { condition: string }>;
  secrets?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  ports?: string[];
  command?: string[];
  pids_limit?: number;
  mem_limit?: string;
  stop_grace_period?: string;
}

interface ComposeFile {
  "x-ottl-evaluator-secret": string;
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean }>;
  secrets: Record<string, { file: string }>;
}

const compose = parseYaml(read("docker-compose.yml")) as ComposeFile;
const api = compose.services["api"]!;

/** A service's networks by name: Compose takes a list or a mapping (the API's, for its alias). */
const networksOf = (service: { networks?: string[] | Record<string, unknown> } | undefined): string[] =>
  Array.isArray(service?.networks) ? service.networks : Object.keys(service?.networks ?? {});
const evaluator = compose.services["ottl-evaluator"]!;
const forwarder = compose.services["ottl-evaluator-forward"]!;

describe("the OTTL evaluator's development secret and compose wiring", () => {
  it("the file holds one line, at least 32 bytes, as the evaluator requires", () => {
    expect(read("docker/ottl-evaluator/development-secret")).toBe(`${fileSecret}\n`);
    expect(fileSecret).not.toMatch(/\s/);
    expect(Buffer.byteLength(fileSecret)).toBeGreaterThanOrEqual(32);
  });

  it("compose's anchor equals the file, and the evaluator reads the file, never its environment", () => {
    expect(compose["x-ottl-evaluator-secret"]).toBe(fileSecret);
    expect(compose.secrets.ottl_evaluator_secret?.file).toBe("./docker/ottl-evaluator/development-secret");
    expect(evaluator.secrets).toEqual(["ottl_evaluator_secret"]);
    expect(evaluator.environment).toEqual({ OTTL_EVALUATOR_SECRET_FILE: "/run/secrets/ottl_evaluator_secret", GOMAXPROCS: "4" });
  });

  it("the evaluator is locked down, alone on its own internal network", () => {
    expect(evaluator.command).toEqual(["serve"]);
    expect(evaluator.read_only).toBe(true);
    expect(evaluator.cap_drop).toEqual(["ALL"]);
    expect(evaluator.security_opt).toEqual(["no-new-privileges:true"]);
    expect(evaluator.networks).toEqual(["ottl-evaluator"]);
    expect(evaluator.ports).toBeUndefined();
    expect(compose.networks["ottl-evaluator"]).toEqual({ internal: true });
  });

  it("its threads, memory and stop are bounded as measured (Rulings 33 and 34)", () => {
    // pids_limit counts threads: serve and its 4 evaluation + 8 validation
    // children at once, with headroom; serve's GOMAXPROCS keeps its own
    // threads from growing with the host's CPUs (the children get 2).
    expect(evaluator.pids_limit).toBe(256);
    expect(evaluator.environment?.GOMAXPROCS).toBe("4");
    expect(evaluator.mem_limit).toBe("3g");
    // serve's shutdown takes up to 40 s: Docker's default 10 s would kill it part way.
    expect(evaluator.stop_grace_period).toBe("45s");
  });

  it("only its own forwarder publishes it, on the host's loopback, and not on the tester's network", () => {
    expect(forwarder.networks).toEqual(["default", "ottl-evaluator"]);
    expect(forwarder.ports).toEqual(["127.0.0.1:51238:8003"]);
    const onItsNetwork = Object.entries(compose.services)
      .filter(([, service]) => networksOf(service).includes("ottl-evaluator"))
      .map(([name]) => name)
      .sort();
    expect(onItsNetwork).toEqual(["api", "ottl-evaluator", "ottl-evaluator-forward"]);
  });

  it("the API joins the evaluator's network and starts once it is healthy", () => {
    expect(networksOf(api)).toContain("ottl-evaluator");
    expect(api.depends_on?.["ottl-evaluator"]).toEqual({ condition: "service_healthy" });
  });

  it("the API's environment takes the anchor's secret, and calls the evaluator directly on its network", () => {
    expect(api.environment?.TELFLO_OTTL_EVALUATOR_SECRET).toBe(fileSecret);
    expect(api.environment?.TELFLO_OTTL_EVALUATOR_URL).toBe("http://ottl-evaluator:8003");
  });

  it("the API's compose environment loads, with the evaluator's settings", () => {
    // Compose interpolates `${…}` from its own environment; unset, each is
    // empty, or its `:-` or `-` default (the agent endpoint's, D17c-1; the
    // site's, D36-1).
    const environment = Object.fromEntries(
      Object.entries(api.environment ?? {}).map(([name, value]) => [
        name,
        String(value).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-([^}]*))?\}/g, (_reference, fallback: string | undefined) => fallback ?? ""),
      ]),
    );
    expect(loadSettings(environment).ottlEvaluator).toEqual({ url: "http://ottl-evaluator:8003", secret: fileSecret });
  });

  it(".env.example names the forwarder on 127.0.0.1:51238 and the same secret, for the native API", () => {
    const example = parseEnv(read("telflo-core/.env.example"));
    expect(example.TELFLO_OTTL_EVALUATOR_URL).toBe("http://127.0.0.1:51238");
    expect(example.TELFLO_OTTL_EVALUATOR_SECRET).toBe(fileSecret);
  });
});
