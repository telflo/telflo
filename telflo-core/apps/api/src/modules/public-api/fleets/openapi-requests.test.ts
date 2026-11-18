import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  PublicCreateCollectorGroupRequestSchema,
  PublicCreateFleetRequestSchema,
  PublicInstallRequestSchema,
  PublicUpdateCollectorGroupRequestSchema,
} from "@telflo/contracts";
import { publicApiDocument } from "../openapi/document.js";

/*
 * The fleets fragment's request schemas are the contracts' (D25 Ruling 165's
 * rule for every area): each body below is accepted or refused alike by the
 * document's schema (ajv 2020, as the reply validator compiles a reply's)
 * and the route's Zod contract. One rule JSON Schema can't say is left out
 * of the bodies and named in the document instead: an install's variable
 * named twice (400 from the contract).
 */

/** The document's schema `name`, compiled with every component beside it. */
function compiled(name: string) {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  const schemas = publicApiDocument().components.schemas ?? {};
  const rewritten = JSON.parse(JSON.stringify(schemas).replaceAll("#/components/schemas/", "#/$defs/")) as Record<string, object>;
  return ajv.compile({ $defs: rewritten, $ref: `#/$defs/${name}` });
}

const UUID = "3d4e5f60-7182-4394-aa5b-6c7d8e9fa0b1";

const cases: Array<{ name: string; contract: { safeParse: (value: unknown) => { success: boolean } }; bodies: unknown[] }> = [
  {
    name: "CreateFleetRequest",
    contract: PublicCreateFleetRequestSchema,
    bodies: [
      { label: "edge", type: "server" },
      { label: "edge prod 🚀", type: "kubernetes-supervisor", expiresIn: "2y" },
      { label: "l".repeat(80), type: "server", expiresIn: "never" },
      { label: "", type: "server" },
      { label: " edge", type: "server" },
      { label: "edge ", type: "server" },
      { label: "ed\u0007ge", type: "server" },
      { label: "e ", type: "server" },
      { label: "l".repeat(81), type: "server" },
      { label: "🚀".repeat(80), type: "server" },
      { label: "edge", type: "server-supervisor" },
      { label: "edge", type: "server", expiresIn: "3y" },
      { label: "edge", type: "server", id: UUID },
      { label: "edge" },
    ],
  },
  {
    name: "CreateCollectorGroupRequest",
    contract: PublicCreateCollectorGroupRequestSchema,
    bodies: [
      { name: "edge", configurationId: UUID, versionNumber: 1 },
      { name: "traces", configurationId: "anything", versionNumber: 999_999_999, role: "gateway", replicas: 1000, namespace: "a-b-0" },
      { name: "edge", configurationId: UUID, versionNumber: 0 },
      { name: "edge", configurationId: UUID, versionNumber: 1_000_000_000 },
      { name: "edge", configurationId: UUID, versionNumber: 1.5 },
      { name: "edge", configurationId: UUID },
      { name: "", configurationId: UUID, versionNumber: 1 },
      { name: " edge", configurationId: UUID, versionNumber: 1 },
      { name: "n".repeat(81), configurationId: UUID, versionNumber: 1 },
      { name: "edge", configurationId: "c".repeat(65), versionNumber: 1 },
      { name: "edge", configurationId: UUID, versionNumber: 1, role: "agent" },
      { name: "edge", configurationId: UUID, versionNumber: 1, replicas: 0 },
      { name: "edge", configurationId: UUID, versionNumber: 1, replicas: 1001 },
      { name: "edge", configurationId: UUID, versionNumber: 1, namespace: "Tracing" },
      { name: "edge", configurationId: UUID, versionNumber: 1, namespace: "-x" },
      { name: "edge", configurationId: UUID, versionNumber: 1, namespace: "n".repeat(64) },
      { name: "edge", configurationId: UUID, versionNumber: 1, annotations: {} },
    ],
  },
  {
    name: "UpdateCollectorGroupRequest",
    contract: PublicUpdateCollectorGroupRequestSchema,
    bodies: [
      { name: "west" },
      { configurationId: UUID, versionNumber: 2 },
      { versionNumber: 3 },
      { configurationId: null },
      { namespace: null, replicas: null },
      { namespace: "tracing", replicas: 5 },
      {},
      { configurationId: UUID },
      { configurationId: null, versionNumber: 1 },
      { name: null },
      { versionNumber: null },
      { role: "node" },
      { namespace: "" },
      { replicas: 0 },
      { name: "w".repeat(81) },
    ],
  },
  {
    name: "InstallRequest",
    contract: PublicInstallRequestSchema,
    bodies: [
      { platform: "docker" },
      { platform: "docker", groupId: UUID, displayName: "  edge 1 ", env: [{ name: "NGINX_ENV", value: "it's" }] },
      { platform: "docker", displayName: "" },
      { platform: "docker", displayName: "   " },
      { platform: "docker", displayName: `a${" ".repeat(78)}b` },
      { platform: "docker", displayName: "x".repeat(81) },
      { platform: "docker", displayName: "it's" },
      { platform: "docker", displayName: " ".repeat(1001) },
      { platform: "docker", env: [{ name: "A-B", value: "x" }] },
      { platform: "docker", env: [{ name: "A", value: "" }] },
      { platform: "docker", env: [{ name: "A", value: "a\nb" }] },
      { platform: "docker", env: [{ name: "A", value: "a\uD800b" }] },
      { platform: "docker", env: [{ name: "A", value: "a🚀b" }] },
      { platform: "docker", env: [{ name: "A", value: "v".repeat(4097) }] },
      { platform: "docker", env: [{ name: "A", value: "  spaced  " }] },
      { platform: "docker", env: [{ name: "A", value: "\t a b \n" }] },
      { platform: "docker", env: [{ name: "A", value: "   " }] },
      { platform: "docker", env: [{ name: "A", value: "\t\n" }] },
      { platform: "docker", env: [{ name: "A", value: "a\tb" }] },
      { platform: "docker", env: [{ name: "A", value: ` ${"v".repeat(4096)} ` }] },
      { platform: "docker", env: [{ name: "A", value: ` ${"v".repeat(4097)} ` }] },
      { platform: "docker", env: [{ name: "A", value: "\u00a0a\u00a0" }] },
      { platform: "docker", env: [{ name: "A", value: "\u0085a" }] },
      { platform: "docker", env: Array.from({ length: 51 }, (_, index) => ({ name: `V${index}`, value: "x" })) },
      { platform: "docker", arch: "amd64" },
      { platform: "linux", arch: "arm64", rootPath: "/etc/otelcol", systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "/opt/telflo///", systemd: false, displayName: "vm 7" },
      { platform: "linux", arch: "amd64", rootPath: `/${"r".repeat(199)}`, systemd: true },
      { platform: "linux", arch: "amd64", rootPath: `/${"r".repeat(200)}`, systemd: true },
      { platform: "linux", arch: "amd64", rootPath: `/${"r".repeat(199)}////`, systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "/", systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "///", systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "", systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "etc/otelcol", systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "/etc/./otelcol", systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "/etc/..", systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "/etc/..otelcol", systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "/etc/otel col", systemd: true },
      { platform: "linux", arch: "riscv", rootPath: "/etc/otelcol", systemd: true },
      { platform: "linux", rootPath: "/etc/otelcol", systemd: true },
      { platform: "linux", arch: "amd64", rootPath: "/etc/otelcol" },
      { platform: "kubernetes" },
      { platform: "kubernetes", groupId: UUID, env: [{ name: "NODE_ENV_X", value: "x" }] },
      { platform: "kubernetes", displayName: "x" },
      { platform: "windows" },
      {},
    ],
  },
];

describe("the fleets fragment's requests are the contracts' (D25 Ruling 165)", () => {
  it.each(cases)("$name accepts and refuses each body as its contract does", ({ name, contract, bodies }) => {
    const validate = compiled(name);
    const disagreements = bodies.flatMap((body, index) => (validate(body) === contract.safeParse(body).success ? [] : [index]));
    expect(disagreements).toEqual([]);
  });
});
