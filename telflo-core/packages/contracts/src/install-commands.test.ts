import { describe, expect, it } from "vitest";
import { containerCommand, containerPreview, OPAMP_VOLUME, type ContainerCommandParts } from "./install-commands.js";
import { INSTALL_MASKED_TOKEN } from "./install.js";

/*
 * The container command, shared so the public install route and the
 * install dialog build the same bytes. The web's own tests (apps/web
 * `lib/install.test.ts`, run unchanged through its re-export) pin every
 * line, quoting and refusal with a real bash; these pin the shared module
 * itself. The bearer here is a fixture, not a secret.
 */

const BEARER = "Zml4dHVyZS1iZWFyZXI+/=";

const FACTS: ContainerCommandParts["facts"] = {
  imageTag: "ghcr.io/telflo/telflo/collector:0.162.0",
  endpoint: "wss://opamp.example.com/v1/opamp",
  allowInsecureConnections: true,
  groupId: "3d4e5f60-7182-4394-aa5b-6c7d8e9fa0b1",
  mounts: [{ hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true }],
};

describe("containerCommand", () => {
  it("is the dialog's command, one flag a line, every value quoted once", () => {
    expect(OPAMP_VOLUME).toBe("telflo-opamp:/app/opamp");
    expect(containerCommand({ facts: FACTS, bearer: BEARER, displayName: "edge 1", env: [{ name: "NGINX_ENV", value: "it's" }] })).toBe(
      [
        "docker run -d --restart unless-stopped --name telflo-collector \\",
        "  -v telflo-opamp:/app/opamp \\",
        "  -v '/var/log/nginx:/var/log/nginx:ro' \\",
        "  -e COLLECTOR_GROUP_ID='3d4e5f60-7182-4394-aa5b-6c7d8e9fa0b1' \\",
        "  -e OPAMP_ENDPOINT='wss://opamp.example.com/v1/opamp' \\",
        "  -e OPAMP_ALLOW_INSECURE_CONNECTIONS='true' \\",
        "  -e OPAMP_SERVER_NAME='edge 1' \\",
        `  -e OPAMP_TOKEN='${BEARER}' \\`,
        "  -e NGINX_ENV='it'\\''s' \\",
        "  'ghcr.io/telflo/telflo/collector:0.162.0'",
      ].join("\n"),
    );
  });

  it("leaves the display name's line out when there is none", () => {
    expect(containerCommand({ facts: FACTS, bearer: BEARER, displayName: "", env: [] })).not.toContain("OPAMP_SERVER_NAME");
  });

  it("refuses a variable that isn't a shell name, one the install sets itself, and one given twice", () => {
    const base = { facts: FACTS, bearer: BEARER, displayName: "" };
    expect(() => containerCommand({ ...base, env: [{ name: "A-B", value: "x" }] })).toThrow("isn't a shell name");
    expect(() => containerCommand({ ...base, env: [{ name: "OPAMP_TOKEN", value: "x" }] })).toThrow("sets itself");
    expect(() => containerCommand({ ...base, env: [{ name: "A", value: "x" }, { name: "A", value: "y" }] })).toThrow("given twice");
  });
});

describe("containerPreview", () => {
  it("is the command with the token masked, and holds no bearer", () => {
    const parts = { facts: FACTS, displayName: "edge 1", env: [] };
    const preview = containerPreview(parts);
    expect(preview).toBe(containerCommand({ ...parts, bearer: INSTALL_MASKED_TOKEN }));
    expect(preview.includes(BEARER)).toBe(false);
  });
});
