import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpampServer, type FakeOpampServer } from "../testing/fake-opamp-server.js";
import { createOpampServerClient, sha256Hex, type OpampServerClient } from "./client.js";
import {
  expectOrganizationGone,
  expectOrganizationName,
  expectOrganizationRegistered,
  expectPublication,
  expectPublications,
  PERSONAL_ORGANIZATION_NAME,
  runStackSmoke,
  runStackSmokeCommand,
  StackSmokeError,
} from "./smoke.js";

// The stack smoke test's sequences (D11a Tasks 7 and 10b), against the fake:
// the same functions stack-smoke.ts runs inside the compose stack against
// the real opamp-server (Task 8).

let fake: FakeOpampServer;
let client: OpampServerClient;

beforeAll(async () => {
  fake = await startFakeOpampServer();
  client = createOpampServerClient({ url: fake.url, secret: fake.secret });
});

afterEach(() => {
  expect(fake.takeViolations()).toEqual([]);
});

afterAll(async () => {
  await fake.close();
});

/** The client, with one method answering differently. */
function withOverride<Method extends keyof OpampServerClient>(
  method: Method,
  override: (real: OpampServerClient[Method]) => OpampServerClient[Method],
): OpampServerClient {
  return { ...client, [method]: override(client[method].bind(client) as OpampServerClient[Method]) };
}

async function failureOf(smoke: Promise<void>): Promise<StackSmokeError> {
  const error = await smoke.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StackSmokeError);
  return error as StackSmokeError;
}

describe("runStackSmoke", () => {
  it("runs its sequence against a server that keeps the contract", async () => {
    const lines: string[] = [];

    await runStackSmoke(client, (line) => lines.push(line));

    expect(lines).toEqual([
      "register the organization: created",
      "register it again: unchanged",
      "post: created",
      "post again: unchanged",
      "post a changed body: conflict",
      "post another collector: conflict",
      "get: found, the YAML and the collector equal",
      "list: the publication, its collector equal",
      "post a second publication: created",
      "delete the second publication: deleted",
      "get the deleted publication: not_found",
      "delete the configuration's publications: deleted",
      "get after the delete: not_found",
      "post a third publication: created",
      "delete the organization: deleted",
      "list after the organization's delete: organization_not_found",
    ]);
  });

  it("runs without a log", async () => {
    await expect(runStackSmoke(client)).resolves.toBeUndefined();
  });

  it("fails on a surprise, naming the step and the result, never the YAML or the secret", async () => {
    fake.nextFault("error_500");

    const error = await failureOf(runStackSmoke(client));

    expect(error.message).toBe("register the organization: expected created, got unavailable");
    expect(`${error.message}${error.stack}`).not.toContain(fake.secret);
    expect(`${error.message}${error.stack}`).not.toContain("receivers");
  });

  it("names an invalid result's code", async () => {
    const refusing = withOverride("postPublication", () => () =>
      Promise.resolve({ kind: "invalid", code: "sha256_mismatch" }),
    );

    expect((await failureOf(runStackSmoke(refusing))).message).toBe("post: expected created, got invalid (sha256_mismatch)");
  });

  it("fails when the stored YAML differs from the YAML posted", async () => {
    const altering = withOverride("postPublication", (real) => async (...args) => {
      const result = await real(...args);
      return result.kind === "created" ? { ...result, publication: { ...result.publication, yaml: "other: {}\n" } } : result;
    });

    expect((await failureOf(runStackSmoke(altering))).message).toBe("post: the stored YAML differs from the YAML posted");
  });

  it("fails when the YAML read differs from the YAML posted", async () => {
    const altering = withOverride("getPublication", (real) => async (...args) => {
      const result = await real(...args);
      return result.kind === "found" ? { ...result, publication: { ...result.publication, yaml: "other: {}\n" } } : result;
    });

    expect((await failureOf(runStackSmoke(altering))).message).toBe("get: the YAML read differs from the YAML posted");
  });

  it("fails when the stored collector differs from the collector post: a server leaving it to its defaults (D13a decision 7)", async () => {
    const defaulting = withOverride("postPublication", (real) => async (...args) => {
      const result = await real(...args);
      return result.kind === "created"
        ? { ...result, publication: { ...result.publication, collector: { distribution: "otelcol-contrib", version: "0.162.0" } } }
        : result;
    });

    expect((await failureOf(runStackSmoke(defaulting))).message).toBe("post: the stored collector differs from the collector posted");
  });

  it("fails when the server takes another collector under the same id as the same publication", async () => {
    const ignoring = withOverride("postPublication", (real) => (organizationId, publicationId, publication) =>
      real(organizationId, publicationId, { ...publication, collector: { distribution: "otelcol-contrib", version: "0.161.0" } }),
    );

    expect((await failureOf(runStackSmoke(ignoring))).message).toBe("post another collector: expected conflict, got unchanged");
  });

  it("fails when the collector read or listed differs from the collector posted", async () => {
    const other = { distribution: "otelcol-k8s", version: "0.161.0" };
    const reading = withOverride("getPublication", (real) => async (...args) => {
      const result = await real(...args);
      return result.kind === "found" ? { ...result, publication: { ...result.publication, collector: other } } : result;
    });
    const listing = withOverride("listPublications", (real) => async (...args) => {
      const result = await real(...args);
      return result.kind === "page"
        ? { ...result, page: { ...result.page, publications: result.page.publications.map((p) => ({ ...p, collector: other })) } }
        : result;
    });

    expect((await failureOf(runStackSmoke(reading))).message).toBe("get: the collector read differs from the collector posted");
    expect((await failureOf(runStackSmoke(listing))).message).toBe("list: the collector listed differs from the collector posted");
  });

  it("fails when the list doesn't hold the one publication", async () => {
    const empty = withOverride("listPublications", () => () =>
      Promise.resolve({ kind: "page", page: { publications: [], nextCursor: null } }),
    );

    expect((await failureOf(runStackSmoke(empty))).message).toBe("list: expected the one publication, got 0");
  });

  it("fails when deleting the second publication doesn't answer deleted", async () => {
    const missing = withOverride("deletePublication", () => () => Promise.resolve({ kind: "not_found" }));

    expect((await failureOf(runStackSmoke(missing))).message).toBe("delete the second publication: expected deleted, got not_found");
  });

  it("fails when the second publication survives its delete", async () => {
    const keeping = withOverride("deletePublication", () => () => Promise.resolve({ kind: "deleted" }));

    expect((await failureOf(runStackSmoke(keeping))).message).toBe("get the deleted publication: expected not_found, got found");
  });

  it("fails when the organization was registered already under another name", async () => {
    const taken = withOverride("createOrganization", () => () => Promise.resolve({ kind: "conflict" }));

    expect((await failureOf(runStackSmoke(taken))).message).toBe("register the organization: expected created, got conflict");
  });

  it("fails when registering the organization again doesn't answer unchanged", async () => {
    const forgetful = withOverride("createOrganization", (real) => async (organization) => {
      const result = await real(organization);
      return result.kind === "unchanged" ? { kind: "created", organizationId: result.organizationId } : result;
    });

    expect((await failureOf(runStackSmoke(forgetful))).message).toBe("register it again: expected unchanged, got created");
  });

  it("fails when the organization's delete leaves it registered", async () => {
    const keeping = withOverride("deleteOrganization", () => () => Promise.resolve({ kind: "deleted" }));

    expect((await failureOf(runStackSmoke(keeping))).message).toBe(
      "list after the organization's delete: expected organization_not_found, got page",
    );
  });

  it("fails when the publication survives its configuration's delete", async () => {
    const keeping = withOverride("deleteConfigurationPublications", () => () => Promise.resolve({ kind: "deleted" }));

    expect((await failureOf(runStackSmoke(keeping))).message).toBe("get after the delete: expected not_found, got found");
  });
});

const noWait = () => Promise.resolve();

/** A sleep that records its waits and, on the `at`th, runs `then` (the platform's job landing late). */
function recordingSleep(at?: number, then?: () => Promise<unknown>) {
  const waits: number[] = [];
  const sleep = async (milliseconds: number) => {
    waits.push(milliseconds);
    if (waits.length === at && then) await then();
  };
  return { waits, sleep };
}

describe("expectOrganizationRegistered", () => {
  const personal = PERSONAL_ORGANIZATION_NAME;

  it("resolves for a registered personal organization", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "smoke@example.com" });

    await expect(expectOrganizationRegistered(client, id, personal, { sleep: noWait })).resolves.toBeUndefined();
  });

  it("resolves for an organization registered under exactly the name", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Stack smoke group" });

    await expect(expectOrganizationRegistered(client, id, { name: "Stack smoke group" }, { sleep: noWait })).resolves.toBeUndefined();
  });

  it("asks again until the platform's job has registered it", async () => {
    const id = randomUUID();
    const { waits, sleep } = recordingSleep(3, () => client.createOrganization({ id, name: "late@example.com" }));

    await expectOrganizationRegistered(client, id, personal, { sleep });

    expect(waits).toEqual([500, 500, 500]);
  });

  it("gives up after its attempts, about 10 s by default, naming the id", async () => {
    const id = randomUUID();
    const { waits, sleep } = recordingSleep();

    const error = await failureOf(expectOrganizationRegistered(client, id, { name: "Never registered" }, { sleep }));

    expect(error.message).toBe(`organization ${id}: expected found, got not_found`);
    expect(waits).toHaveLength(19);
    expect(waits.reduce((total, wait) => total + wait, 0)).toBe(9500);
  });

  it("asks as often and as far apart as it's told", async () => {
    const { waits, sleep } = recordingSleep();

    await failureOf(expectOrganizationRegistered(client, randomUUID(), personal, { attempts: 3, intervalMs: 7, sleep }));

    expect(waits).toEqual([7, 7]);
  });

  it("fails, without the name, for an organization registered under another kind of name", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Acme secret-name-marker" });

    const error = await failureOf(
      expectOrganizationRegistered(client, id, personal, { label: "the new account's personal organization", sleep: noWait }),
    );

    expect(error.message).toBe("the new account's personal organization: registered, but its name isn't an email address");
    expect(error.message).not.toContain("secret-name-marker");
  });

  it("fails for a personal organization still under the old default, <email>'s workspace (Q263)", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "smoke@example.com's workspace" });

    const error = await failureOf(
      expectOrganizationRegistered(client, id, personal, { label: "the new account's personal organization", sleep: noWait }),
    );

    expect(error.message).toBe("the new account's personal organization: registered, but its name isn't an email address");
  });

  it("fails at once, without either name, for an organization registered under another name", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Registered secret-name-marker" });
    const { waits, sleep } = recordingSleep();

    const error = await failureOf(expectOrganizationRegistered(client, id, { name: "Expected other-name-marker" }, { sleep }));

    expect(error.message).toBe(`organization ${id}: registered, but under another name`);
    expect(error.message).not.toMatch(/secret-name-marker|other-name-marker/);
    expect(waits).toEqual([]);
  });

  it("fails at once when the server can't be asked", async () => {
    fake.nextFault("error_500");
    const { waits, sleep } = recordingSleep();

    const error = await failureOf(
      expectOrganizationRegistered(client, randomUUID(), personal, { label: "the new account's personal organization", sleep }),
    );

    expect(error.message).toBe("the new account's personal organization: expected found, got unavailable");
    expect(waits).toEqual([]);
  });
});

describe("expectOrganizationName", () => {
  it("resolves for an organization registered under the name", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Renamed group" });

    await expect(expectOrganizationName(client, id, "Renamed group", { sleep: noWait })).resolves.toBeUndefined();
  });

  it("asks again until the platform's job has renamed it", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Before" });
    const { waits, sleep } = recordingSleep(2, () => client.renameOrganization(id, "After"));

    await expectOrganizationName(client, id, "After", { sleep });

    expect(waits).toEqual([500, 500]);
  });

  it("gives up, without either name, when it keeps another name", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Old secret-name-marker" });
    const { waits, sleep } = recordingSleep();

    const error = await failureOf(expectOrganizationName(client, id, "New other-name-marker", { sleep }));

    expect(error.message).toBe(`organization ${id}: still registered under another name`);
    expect(error.message).not.toMatch(/secret-name-marker|other-name-marker/);
    expect(waits).toHaveLength(19);
  });

  it("fails at once when the organization isn't registered", async () => {
    const id = randomUUID();
    const { waits, sleep } = recordingSleep();

    const error = await failureOf(expectOrganizationName(client, id, "Anything", { sleep }));

    expect(error.message).toBe(`organization ${id}: expected found, got not_found`);
    expect(waits).toEqual([]);
  });

  it("fails at once when the server can't be asked", async () => {
    fake.nextFault("error_500");
    const id = randomUUID();

    const error = await failureOf(expectOrganizationName(client, id, "Anything", { sleep: noWait }));

    expect(error.message).toBe(`organization ${id}: expected found, got unavailable`);
  });
});

describe("expectOrganizationGone", () => {
  it("resolves for an organization that isn't registered", async () => {
    await expect(expectOrganizationGone(client, randomUUID(), { sleep: noWait })).resolves.toBeUndefined();
  });

  it("asks again until the platform's job has deleted it", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Doomed group" });
    const { waits, sleep } = recordingSleep(4, () => client.deleteOrganization(id));

    await expectOrganizationGone(client, id, { sleep });

    expect(waits).toEqual([500, 500, 500, 500]);
  });

  it("gives up, without the name, while it is still registered", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Kept secret-name-marker" });
    const { waits, sleep } = recordingSleep();

    const error = await failureOf(expectOrganizationGone(client, id, { label: "the group organization", sleep }));

    expect(error.message).toBe("the group organization: still registered");
    expect(error.message).not.toContain("secret-name-marker");
    expect(waits).toHaveLength(19);
  });

  it("fails at once when the server can't be asked", async () => {
    fake.nextFault("error_500");
    const id = randomUUID();

    const error = await failureOf(expectOrganizationGone(client, id, { sleep: noWait }));

    expect(error.message).toBe(`organization ${id}: expected not_found, got unavailable`);
  });
});

/** The collector publishedConfiguration's `put` sends: not the server's column defaults (D13a). */
const PUT_COLLECTOR = { distribution: "otelcol-contrib", version: "0.161.0" };

/** A registered organization with a configuration, and a way to put snapshots of its versions. */
async function publishedConfiguration() {
  const organizationId = randomUUID();
  const configurationId = randomUUID();
  await client.createOrganization({ id: organizationId, name: "Secret organization-name-marker" });
  const put = async (versionNumber: number, versionId: string = randomUUID()) => {
    const yaml = `# secret yaml-marker\nreceivers: {}\n`;
    const publicationId = randomUUID();
    const result = await client.postPublication(organizationId, publicationId, {
      configuration: { id: configurationId, name: "Secret configuration-name-marker" },
      version: { id: versionId, number: versionNumber, label: null },
      yaml,
      sha256: sha256Hex(yaml),
      publishedBy: null,
      publishedAt: new Date().toISOString(),
      collector: PUT_COLLECTOR,
    });
    expect(result.kind).toBe("created");
    return publicationId;
  };
  return { organizationId, configurationId, put };
}

describe("expectPublications", () => {
  it("resolves for a configuration with the one snapshot of the version", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    await put(2);

    await expect(
      expectPublications(client, organizationId, configurationId, { count: 1, versionNumber: 2 }, { sleep: noWait }),
    ).resolves.toBeUndefined();
  });

  it("resolves for a configuration with none, in a registered organization", async () => {
    const { organizationId, configurationId } = await publishedConfiguration();
    const { waits, sleep } = recordingSleep();

    await expectPublications(client, organizationId, configurationId, { count: 0 }, { sleep });

    expect(waits).toEqual([]);
  });

  it("counts only the configuration's own snapshots", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    await put(1);
    await put(2);
    const other = await publishedConfiguration();
    await other.put(1);

    await expect(expectPublications(client, organizationId, configurationId, { count: 2 }, { sleep: noWait })).resolves.toBeUndefined();
  });

  it("asks again until the platform's clean-up has removed them", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    await put(1);
    const { waits, sleep } = recordingSleep(3, () => client.deleteConfigurationPublications(organizationId, configurationId));

    await expectPublications(client, organizationId, configurationId, { count: 0 }, { sleep });

    expect(waits).toEqual([500, 500, 500]);
  });

  it("gives up after its attempts, about 10 s by default, naming the ids and the counts only", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    await put(1);
    const { waits, sleep } = recordingSleep();

    const error = await failureOf(expectPublications(client, organizationId, configurationId, { count: 0 }, { sleep }));

    expect(error.message).toBe(`the configuration ${configurationId}'s publications: expected 0, found 1`);
    expect(error.message).not.toMatch(/marker/);
    expect(waits).toHaveLength(19);
    expect(waits.reduce((total, wait) => total + wait, 0)).toBe(9500);
  });

  it("asks as often and as far apart as it's told", async () => {
    const { organizationId, configurationId } = await publishedConfiguration();
    const { waits, sleep } = recordingSleep();

    await failureOf(expectPublications(client, organizationId, configurationId, { count: 1 }, { attempts: 3, intervalMs: 7, sleep }));

    expect(waits).toEqual([7, 7]);
  });

  it("fails at once for a snapshot of another version", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    await put(1);
    const { waits, sleep } = recordingSleep();

    const error = await failureOf(
      expectPublications(client, organizationId, configurationId, { count: 1, versionNumber: 2 }, { sleep }),
    );

    expect(error.message).toBe(`the configuration ${configurationId}'s publications: expected version 2, found version 1`);
    expect(waits).toEqual([]);
  });

  it("fails at once when the organization isn't registered", async () => {
    const { waits, sleep } = recordingSleep();
    const configurationId = randomUUID();

    const error = await failureOf(expectPublications(client, randomUUID(), configurationId, { count: 0 }, { sleep }));

    expect(error.message).toBe(`the configuration ${configurationId}'s publications: expected page, got organization_not_found`);
    expect(waits).toEqual([]);
  });

  it("fails at once when the server can't be asked", async () => {
    const { organizationId, configurationId } = await publishedConfiguration();
    fake.nextFault("error_500");

    const error = await failureOf(expectPublications(client, organizationId, configurationId, { count: 0 }, { sleep: noWait }));

    expect(error.message).toBe(`the configuration ${configurationId}'s publications: expected page, got unavailable`);
  });
});

/** The SHA-256 of the YAML publishedConfiguration's `put` sends. */
const PUT_YAML_SHA256 = sha256Hex(`# secret yaml-marker\nreceivers: {}\n`);

describe("expectPublication (D11b Ruling 29)", () => {
  it("resolves for the one snapshot of the version, by its id, holding the YAML whose SHA-256 is given", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    const versionId = randomUUID();
    await put(2, versionId);

    await expect(
      expectPublication(
        client,
        organizationId,
        configurationId,
        { versionNumber: 2, versionId, sha256: PUT_YAML_SHA256, collector: PUT_COLLECTOR },
        { sleep: noWait },
      ),
    ).resolves.toBeUndefined();
  });

  it("fails for a snapshot of another version id, naming the ids only", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    const putVersionId = randomUUID();
    await put(2, putVersionId);
    const expectedVersionId = randomUUID();

    const error = await failureOf(
      expectPublication(
        client,
        organizationId,
        configurationId,
        { versionNumber: 2, versionId: expectedVersionId, sha256: PUT_YAML_SHA256, collector: PUT_COLLECTOR },
        { sleep: noWait },
      ),
    );

    expect(error.message).toBe(
      `the configuration ${configurationId}'s publication: expected version ${expectedVersionId}, found version ${putVersionId}`,
    );
  });

  it("fails for a snapshot holding other YAML, naming neither the YAML nor a hash", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    const versionId = randomUUID();
    await put(2, versionId);
    const otherSha256 = sha256Hex("# the YAML saved\n");

    const error = await failureOf(
      expectPublication(
        client,
        organizationId,
        configurationId,
        { versionNumber: 2, versionId, sha256: otherSha256, collector: PUT_COLLECTOR },
        { sleep: noWait },
      ),
    );

    expect(error.message).toBe(`the configuration ${configurationId}'s publication: its sha256 isn't the saved YAML's`);
    expect(error.message).not.toContain(otherSha256);
    expect(error.message).not.toContain(PUT_YAML_SHA256);
    expect(error.message).not.toContain("marker");
  });

  it("fails when the stored YAML doesn't hash to its recorded sha256 (a server that changed it)", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    const versionId = randomUUID();
    await put(2, versionId);
    const changing = withOverride("getPublication", (real) => async (...args) => {
      const result = await real(...args);
      return result.kind === "found"
        ? { ...result, publication: { ...result.publication, yaml: `${result.publication.yaml}# changed\n` } }
        : result;
    });

    const error = await failureOf(
      expectPublication(
        changing,
        organizationId,
        configurationId,
        { versionNumber: 2, versionId, sha256: PUT_YAML_SHA256, collector: PUT_COLLECTOR },
        { sleep: noWait },
      ),
    );

    expect(error.message).toBe(`the configuration ${configurationId}'s publication: its YAML isn't the YAML saved`);
  });

  it.each([
    ["another collector version", { distribution: "otelcol-contrib", version: "0.162.0" }],
    ["another distribution", { distribution: "otelcol-k8s", version: "0.161.0" }],
  ])("fails for a snapshot naming %s than the version's pin, naming the collectors only (D13a decision 7)", async (_label, collector) => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    const versionId = randomUUID();
    await put(2, versionId);

    const error = await failureOf(
      expectPublication(
        client,
        organizationId,
        configurationId,
        { versionNumber: 2, versionId, sha256: PUT_YAML_SHA256, collector },
        { sleep: noWait },
      ),
    );

    expect(error.message).toBe(
      `the configuration ${configurationId}'s publication: expected collector ${collector.distribution} ${collector.version}, found otelcol-contrib 0.161.0`,
    );
  });

  it("fails when the snapshot read names another collector than the one listed (a server that changed it)", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    const versionId = randomUUID();
    await put(2, versionId);
    const changing = withOverride("getPublication", (real) => async (...args) => {
      const result = await real(...args);
      return result.kind === "found"
        ? { ...result, publication: { ...result.publication, collector: { distribution: "otelcol-contrib", version: "0.162.0" } } }
        : result;
    });

    const error = await failureOf(
      expectPublication(
        changing,
        organizationId,
        configurationId,
        { versionNumber: 2, versionId, sha256: PUT_YAML_SHA256, collector: PUT_COLLECTOR },
        { sleep: noWait },
      ),
    );

    expect(error.message).toBe(
      `the configuration ${configurationId}'s publication: expected collector otelcol-contrib 0.161.0, found otelcol-contrib 0.162.0`,
    );
  });

  it("fails as expectPublications does for no snapshot, two, or another version number", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    const versionId = randomUUID();
    const expected = { versionNumber: 2, versionId, sha256: PUT_YAML_SHA256, collector: PUT_COLLECTOR };
    const step = `the configuration ${configurationId}'s publications`;

    const none = await failureOf(
      expectPublication(client, organizationId, configurationId, expected, { attempts: 2, sleep: noWait }),
    );
    await put(1, versionId);
    const otherNumber = await failureOf(
      expectPublication(client, organizationId, configurationId, expected, { sleep: noWait }),
    );
    await put(2, versionId);
    const two = await failureOf(
      expectPublication(client, organizationId, configurationId, expected, { attempts: 2, sleep: noWait }),
    );

    expect([none.message, otherNumber.message, two.message]).toEqual([
      `${step}: expected 1, found 0`,
      `${step}: expected version 2, found version 1`,
      `${step}: expected 1, found 2`,
    ]);
  });
});

describe("runStackSmokeCommand", () => {
  const options = { sleep: noWait };

  it("with a personal organization's id, runs the sequence and finds it registered", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "smoke@example.com" });
    const lines: string[] = [];

    await runStackSmokeCommand(client, [id], (line) => lines.push(line), options);

    expect(lines[0]).toBe("register the organization: created");
    expect(lines.at(-1)).toBe("the new account's personal organization is registered");
  });

  it("with a personal organization's id, fails under the personal organization's label", async () => {
    const error = await failureOf(runStackSmokeCommand(client, [randomUUID()], undefined, options));

    expect(error.message).toBe("the new account's personal organization: expected found, got not_found");
  });

  it("follows a group organization through its registration, rename and delete, never logging its name", async () => {
    const id = randomUUID();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    await client.createOrganization({ id, name: "Group secret-name-marker" });

    await runStackSmokeCommand(client, ["group-registered", id, "Group secret-name-marker"], log, options);
    await client.renameOrganization(id, "Renamed secret-name-marker");
    await runStackSmokeCommand(client, ["group-renamed", id, "Renamed secret-name-marker"], log, options);
    await client.deleteOrganization(id);
    await runStackSmokeCommand(client, ["group-gone", id], log, options);

    expect(lines).toEqual([
      `the group organization ${id} is registered under its name`,
      `the group organization ${id} is registered under its new name`,
      `the group organization ${id} is no longer registered`,
    ]);
  });

  it("names the group organization by its id when a check fails", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Still here" });

    const registered = await failureOf(runStackSmokeCommand(client, ["group-registered", id, "Other"], undefined, options));
    const renamed = await failureOf(runStackSmokeCommand(client, ["group-renamed", id, "Other"], undefined, options));
    const gone = await failureOf(runStackSmokeCommand(client, ["group-gone", id], undefined, options));

    expect([registered.message, renamed.message, gone.message]).toEqual([
      `the group organization ${id}: registered, but under another name`,
      `the group organization ${id}: still registered under another name`,
      `the group organization ${id}: still registered`,
    ]);
  });

  it("checks a configuration's publications, and their version when given, never logging a name", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    await put(2);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    await runStackSmokeCommand(client, ["publications", organizationId, configurationId, "1", "2"], log, options);
    await client.deleteConfigurationPublications(organizationId, configurationId);
    await runStackSmokeCommand(client, ["publications", organizationId, configurationId, "0"], log, options);

    expect(lines).toEqual([
      `the configuration ${configurationId} has 1 publication(s) of version 2`,
      `the configuration ${configurationId} has 0 publication(s)`,
    ]);
  });

  it("names the configuration by its id when its publications aren't as expected", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    await put(1);

    const counted = await failureOf(
      runStackSmokeCommand(client, ["publications", organizationId, configurationId, "0"], undefined, options),
    );
    const versioned = await failureOf(
      runStackSmokeCommand(client, ["publications", organizationId, configurationId, "1", "3"], undefined, options),
    );

    expect([counted.message, versioned.message]).toEqual([
      `the configuration ${configurationId}'s publications: expected 0, found 1`,
      `the configuration ${configurationId}'s publications: expected version 3, found version 1`,
    ]);
  });

  it("checks a configuration's one publication by its version id and its YAML's SHA-256, never logging a name or the YAML", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    const versionId = randomUUID();
    await put(2, versionId);
    const lines: string[] = [];

    await runStackSmokeCommand(
      client,
      ["publication", organizationId, configurationId, "2", versionId, PUT_YAML_SHA256, "otelcol-contrib", "0.161.0"],
      (line) => lines.push(line),
      options,
    );

    expect(lines).toEqual([
      `the configuration ${configurationId}'s one publication is version 2 (${versionId}), holding the YAML saved, for otelcol-contrib 0.161.0`,
    ]);
    expect(lines.join("\n")).not.toMatch(/marker|receivers/);
  });

  it("names the configuration by its id when its publication isn't the one saved", async () => {
    const { organizationId, configurationId, put } = await publishedConfiguration();
    const versionId = randomUUID();
    await put(2, versionId);

    const error = await failureOf(
      runStackSmokeCommand(
        client,
        ["publication", organizationId, configurationId, "2", versionId, sha256Hex("other: {}\n"), "otelcol-contrib", "0.161.0"],
        undefined,
        options,
      ),
    );
    const repinned = await failureOf(
      runStackSmokeCommand(
        client,
        ["publication", organizationId, configurationId, "2", versionId, PUT_YAML_SHA256, "otelcol-contrib", "0.162.0"],
        undefined,
        options,
      ),
    );

    expect(error.message).toBe(`the configuration ${configurationId}'s publication: its sha256 isn't the saved YAML's`);
    expect(repinned.message).toBe(
      `the configuration ${configurationId}'s publication: expected collector otelcol-contrib 0.162.0, found otelcol-contrib 0.161.0`,
    );
  });

  it.each([
    [[]],
    [[""]],
    [["group-registered"]],
    [["group-registered", "an-id"]],
    [["group-registered", "an-id", ""]],
    [["group-renamed", "an-id"]],
    [["group-gone"]],
    [["group-gone", "an-id", "secret-name-marker"]],
    [["group-unknown", "an-id"]],
    [["an-id", "secret-name-marker"]],
    [["publications"]],
    [["publications", "an-org"]],
    [["publications", "an-org", "a-configuration"]],
    [["publications", "", "a-configuration", "1"]],
    [["publications", "an-org", "", "1"]],
    [["publications", "an-org", "a-configuration", "one"]],
    [["publications", "an-org", "a-configuration", "-1"]],
    [["publications", "an-org", "a-configuration", "1.5"]],
    [["publications", "an-org", "a-configuration", "101"]],
    [["publications", "an-org", "a-configuration", "1", "0"]],
    [["publications", "an-org", "a-configuration", "1", "v2"]],
    [["publications", "an-org", "a-configuration", "1", "2", "secret-name-marker"]],
    [["publication"]],
    [["publication", "an-org", "a-configuration", "2", "a-version"]],
    [["publication", "", "a-configuration", "2", "a-version", "a".repeat(64)]],
    [["publication", "an-org", "", "2", "a-version", "a".repeat(64)]],
    [["publication", "an-org", "a-configuration", "0", "a-version", "a".repeat(64)]],
    [["publication", "an-org", "a-configuration", "two", "a-version", "a".repeat(64)]],
    [["publication", "an-org", "a-configuration", "2", "", "a".repeat(64)]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(63)]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "A".repeat(64)]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "secret-name-marker"]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(64), "secret-name-marker"]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(64)]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(64), "otelcol-contrib"]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(64), "", "0.162.0"]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(64), "Secret-Name-Marker", "0.162.0"]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(64), "otelcol-contrib", ""]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(64), "otelcol-contrib", "0.162"]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(64), "otelcol-contrib", "v0.162.0"]],
    [["publication", "an-org", "a-configuration", "2", "a-version", "a".repeat(64), "otelcol-contrib", "0.162.0", "secret-name-marker"]],
  ])("refuses %j with the usage, never the arguments", async (args) => {
    const error = await failureOf(runStackSmokeCommand(client, args, undefined, options));

    expect(error.message).toMatch(/^usage: stack-smoke /);
    expect(error.message).not.toContain("secret-name-marker");
  });
});
