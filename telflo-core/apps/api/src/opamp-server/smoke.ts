import { randomUUID } from "node:crypto";
import {
  sha256Hex,
  type GetOrganizationResult,
  type OpampServerClient,
  type PublicationCollector,
  type PublicationRequest,
} from "./client.js";
import type { PublicationSummary } from "./schemas.js";

// The stack smoke test's sequences, run by stack-smoke.ts inside the API
// container against the real opamp-server, and by smoke.test.ts against the
// fake.
//
// runStackSmoke registers an organization under a random id, as the platform
// does, and registers it again (unchanged); posts a publication under it
// with its own id (0.2.4's postPublication; its collector answered as
// posted), posts it again (unchanged), posts a changed body and then another
// collector under the same id (conflict, twice), reads it (the YAML and the
// collector equal), lists it (the collector equal), posts a second
// publication of the same configuration under a fresh id, deletes that one
// by its id and reads it (not found), deletes the configuration's
// publications, and reads the first again (not found); then deletes the
// organization and reads its publication again (organization_not_found).
//
// expectOrganizationRegistered, expectOrganizationName and
// expectOrganizationGone poll for what the platform sent the opamp-server
// after a response: a new account's personal organization, and a group
// organization created, renamed and deleted through the gateway.
// expectPublications polls for a configuration's snapshots: the one a publish
// through the gateway put, and none once the configuration is deleted, which
// the platform removes after the response. expectPublication checks the one
// snapshot a publish put is of the version published, by its id, holds the
// YAML saved, by its SHA-256, and names the collector the version is pinned
// to, of the configuration's distribution. runStackSmokeCommand reads
// stack-smoke.ts's arguments and runs one of them.
//
// Any surprise throws a StackSmokeError naming the step and the result's
// kind, never the secret, the YAML or an organization's or a
// configuration's name (their ids are fine).

export class StackSmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackSmokeError";
  }
}

/** One step's result as the error says it: the kind, and an invalid's code. */
function describe(result: { kind: string; code?: string }): string {
  return result.code === undefined ? result.kind : `${result.kind} (${result.code})`;
}

function expectKind<Result extends { kind: string }, Kind extends Result["kind"]>(
  step: string,
  result: Result,
  kind: Kind,
): Extract<Result, { kind: Kind }> {
  if (result.kind !== kind) {
    throw new StackSmokeError(`${step}: expected ${kind}, got ${describe(result as { kind: string; code?: string })}`);
  }
  return result as Extract<Result, { kind: Kind }>;
}

/**
 * Runs the sequence; resolves when every step answered as it should.
 * `log` gets one line per step (no value from the publication).
 */
export async function runStackSmoke(client: OpampServerClient, log: (line: string) => void = () => {}): Promise<void> {
  const organizationId = randomUUID();
  expectKind(
    "register the organization",
    await client.createOrganization({ id: organizationId, name: "stack smoke" }),
    "created",
  );
  log("register the organization: created");

  expectKind(
    "register it again",
    await client.createOrganization({ id: organizationId, name: "stack smoke" }),
    "unchanged",
  );
  log("register it again: unchanged");

  const publicationId = randomUUID();
  const configurationId = randomUUID();
  // Multi-byte on purpose: the YAML must come back byte for byte.
  const yaml = `# stack smoke ${publicationId} — ünïcödé\nreceivers:\n  otlp:\n    protocols:\n      grpc: {}\n`;
  const publication: PublicationRequest = {
    configuration: { id: configurationId, name: "stack-smoke" },
    version: { id: randomUUID(), number: 1, label: "smoke" },
    yaml,
    sha256: sha256Hex(yaml),
    publishedBy: null,
    publishedAt: new Date().toISOString(),
    // Not the server's column defaults (Contrib 0.162.0, migration 00003):
    // a server leaving the columns to them answers another collector.
    collector: { distribution: "otelcol-contrib", version: "0.161.0" },
  };

  const created = expectKind("post", await client.postPublication(organizationId, publicationId, publication), "created");
  if (created.publication.yaml !== yaml) throw new StackSmokeError("post: the stored YAML differs from the YAML posted");
  if (!sameCollector(created.publication.collector, publication.collector)) {
    throw new StackSmokeError("post: the stored collector differs from the collector posted");
  }
  log("post: created");

  expectKind("post again", await client.postPublication(organizationId, publicationId, publication), "unchanged");
  log("post again: unchanged");

  const changedYaml = `${yaml}# changed\n`;
  const changed = { ...publication, yaml: changedYaml, sha256: sha256Hex(changedYaml) };
  expectKind("post a changed body", await client.postPublication(organizationId, publicationId, changed), "conflict");
  log("post a changed body: conflict");

  const otherCollector = { ...publication, collector: { ...publication.collector, version: "0.162.0" } };
  expectKind(
    "post another collector",
    await client.postPublication(organizationId, publicationId, otherCollector),
    "conflict",
  );
  log("post another collector: conflict");

  const found = expectKind("get", await client.getPublication(organizationId, publicationId), "found");
  if (found.publication.yaml !== yaml) throw new StackSmokeError("get: the YAML read differs from the YAML posted");
  if (!sameCollector(found.publication.collector, publication.collector)) {
    throw new StackSmokeError("get: the collector read differs from the collector posted");
  }
  log("get: found, the YAML and the collector equal");

  const listed = expectKind("list", await client.listPublications(organizationId, { configurationId }), "page");
  if (listed.page.publications.length !== 1 || listed.page.publications[0]?.id !== publicationId) {
    throw new StackSmokeError(`list: expected the one publication, got ${listed.page.publications.length}`);
  }
  if (!sameCollector(listed.page.publications[0].collector, publication.collector)) {
    throw new StackSmokeError("list: the collector listed differs from the collector posted");
  }
  log("list: the publication, its collector equal");

  const secondPublicationId = randomUUID();
  expectKind(
    "post a second publication",
    await client.postPublication(organizationId, secondPublicationId, publication),
    "created",
  );
  log("post a second publication: created");

  expectKind(
    "delete the second publication",
    await client.deletePublication(organizationId, secondPublicationId),
    "deleted",
  );
  log("delete the second publication: deleted");

  expectKind(
    "get the deleted publication",
    await client.getPublication(organizationId, secondPublicationId),
    "not_found",
  );
  log("get the deleted publication: not_found");

  expectKind(
    "delete the configuration's publications",
    await client.deleteConfigurationPublications(organizationId, configurationId),
    "deleted",
  );
  log("delete the configuration's publications: deleted");

  expectKind("get after the delete", await client.getPublication(organizationId, publicationId), "not_found");
  log("get after the delete: not_found");

  expectKind("post a third publication", await client.postPublication(organizationId, randomUUID(), publication), "created");
  log("post a third publication: created");

  expectKind("delete the organization", await client.deleteOrganization(organizationId), "deleted");
  log("delete the organization: deleted");

  expectKind(
    "list after the organization's delete",
    await client.listPublications(organizationId, { configurationId }),
    "organization_not_found",
  );
  log("list after the organization's delete: organization_not_found");
}

/** Whether two collectors are the same distribution and version. */
function sameCollector(a: PublicationCollector, b: PublicationCollector): boolean {
  return a.distribution === b.distribution && a.version === b.version;
}

export interface PollOptions {
  /** How many times to ask; default 20. */
  attempts?: number;
  /** Between two asks; default 500 ms, so 20 asks span about 10 s. */
  intervalMs?: number;
  /** What the errors call the organization; default "organization <id>". */
  label?: string;
  /** Tests only. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/** The name an organization is expected under: exactly, or an email address, as a personal one's is. */
export type ExpectedName = { name: string } | { emailAddress: true };

/**
 * A personal organization is named by its owner's email: the
 * smoke never learns which, so it checks only that the name is an address.
 */
export const PERSONAL_ORGANIZATION_NAME: ExpectedName = { emailAddress: true };

/** One `@`, no spaces, a dot after the `@`: the web's invite dialog's pattern. */
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Asks for `organizationId` until `isWaiting` says the answer is no longer
 * one to wait out, or the attempts run out; answers the last result. The
 * platform sends its calls after its responses, so the first
 * answer can be an old one.
 */
async function pollOrganization(
  client: OpampServerClient,
  organizationId: string,
  options: PollOptions,
  isWaiting: (result: GetOrganizationResult) => boolean,
): Promise<GetOrganizationResult> {
  const { attempts = 20, intervalMs = 500 } = options;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  let result = await client.getOrganization(organizationId);
  for (let attempt = 1; attempt < attempts && isWaiting(result); attempt += 1) {
    await sleep(intervalMs);
    result = await client.getOrganization(organizationId);
  }
  return result;
}

function labelOf(organizationId: string, options: PollOptions): string {
  return options.label ?? `organization ${organizationId}`;
}

function hasName(name: string, expected: ExpectedName): boolean {
  return "name" in expected ? name === expected.name : EMAIL_ADDRESS.test(name);
}

/**
 * Resolves once `organizationId` is registered under the expected name. It
 * waits while the organization isn't registered; a registration under
 * another name fails at once (a create never renames).
 */
export async function expectOrganizationRegistered(
  client: OpampServerClient,
  organizationId: string,
  expected: ExpectedName,
  options: PollOptions = {},
): Promise<void> {
  const step = labelOf(organizationId, options);
  const result = await pollOrganization(client, organizationId, options, (answer) => answer.kind === "not_found");
  const found = expectKind(step, result, "found");
  if (!hasName(found.organization.name, expected)) {
    throw new StackSmokeError(
      "name" in expected
        ? `${step}: registered, but under another name`
        : `${step}: registered, but its name isn't an email address`,
    );
  }
}

/**
 * Resolves once the registered `organizationId` has the name `name`: after
 * a rename on the platform. It waits while it has another name; not being
 * registered fails at once.
 */
export async function expectOrganizationName(
  client: OpampServerClient,
  organizationId: string,
  name: string,
  options: PollOptions = {},
): Promise<void> {
  const step = labelOf(organizationId, options);
  const result = await pollOrganization(
    client,
    organizationId,
    options,
    (answer) => answer.kind === "found" && answer.organization.name !== name,
  );
  const found = expectKind(step, result, "found");
  if (found.organization.name !== name) {
    throw new StackSmokeError(`${step}: still registered under another name`);
  }
}

/**
 * Resolves once `organizationId` is no longer registered: after a delete on
 * the platform. It waits while it is still registered.
 */
export async function expectOrganizationGone(
  client: OpampServerClient,
  organizationId: string,
  options: PollOptions = {},
): Promise<void> {
  const step = labelOf(organizationId, options);
  const result = await pollOrganization(client, organizationId, options, (answer) => answer.kind === "found");
  if (result.kind === "found") throw new StackSmokeError(`${step}: still registered`);
  expectKind(step, result, "not_found");
}

export interface ExpectedPublications {
  /** How many snapshots of the configuration the server holds; 0 to 100. */
  count: number;
  /** When given, every one of them is of this version number. */
  versionNumber?: number;
}

/**
 * Resolves once the server holds exactly `expected.count` snapshots of
 * `configurationId` under `organizationId`, each of `expected.versionNumber`
 * when given. It waits while the count differs (the platform's clean-up
 * runs after its response); a snapshot of another version fails at once,
 * and so does an answer other than a page (the organization stays
 * registered when a configuration is deleted).
 */
export async function expectPublications(
  client: OpampServerClient,
  organizationId: string,
  configurationId: string,
  expected: ExpectedPublications,
  options: Omit<PollOptions, "label"> = {},
): Promise<void> {
  await publicationsAsExpected(client, organizationId, configurationId, expected, options);
}

/** expectPublications's check, answering the snapshots it found. */
async function publicationsAsExpected(
  client: OpampServerClient,
  organizationId: string,
  configurationId: string,
  expected: ExpectedPublications,
  options: Omit<PollOptions, "label">,
): Promise<PublicationSummary[]> {
  const { attempts = 20, intervalMs = 500 } = options;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const step = `the configuration ${configurationId}'s publications`;
  const list = () => client.listPublications(organizationId, { configurationId, limit: 100 });
  let result = await list();
  for (
    let attempt = 1;
    attempt < attempts && result.kind === "page" && result.page.publications.length !== expected.count;
    attempt += 1
  ) {
    await sleep(intervalMs);
    result = await list();
  }
  const { page } = expectKind(step, result, "page");
  if (page.publications.length !== expected.count) {
    throw new StackSmokeError(`${step}: expected ${expected.count}, found ${page.publications.length}`);
  }
  const { versionNumber } = expected;
  if (versionNumber !== undefined) {
    const other = page.publications.find((publication) => publication.version.number !== versionNumber);
    if (other) {
      throw new StackSmokeError(`${step}: expected version ${versionNumber}, found version ${other.version.number}`);
    }
  }
  return page.publications;
}

export interface ExpectedPublication {
  /** The version's number, as the snapshot names it. */
  versionNumber: number;
  /** The version's id, as the snapshot names it. */
  versionId: string;
  /** The SHA-256 (hex) of the YAML saved as that version, computed by the caller from what it sent. */
  sha256: string;
  /** The configuration's distribution and the version's collector version, as the platform reports them. */
  collector: PublicationCollector;
}

/**
 * Resolves once the server holds exactly one snapshot of `configurationId`
 * (expectPublications, so it waits as that does), of the expected version
 * number and version id, read by its id, whose recorded `sha256` and whose
 * YAML's own SHA-256 are both `expected.sha256`, and whose collector, listed
 * and read, is `expected.collector`: the snapshot is the version published,
 * holding the text saved and the pin it had. Its errors name ids, numbers and
 * the collectors only, never the YAML or a hash.
 */
export async function expectPublication(
  client: OpampServerClient,
  organizationId: string,
  configurationId: string,
  expected: ExpectedPublication,
  options: Omit<PollOptions, "label"> = {},
): Promise<void> {
  const step = `the configuration ${configurationId}'s publication`;
  const [summary] = await publicationsAsExpected(
    client,
    organizationId,
    configurationId,
    { count: 1, versionNumber: expected.versionNumber },
    options,
  );
  // expectPublications found exactly one.
  if (summary === undefined) throw new StackSmokeError(`${step}: expected 1, found 0`);
  if (summary.version.id !== expected.versionId) {
    throw new StackSmokeError(`${step}: expected version ${expected.versionId}, found version ${summary.version.id}`);
  }
  const { publication } = expectKind(step, await client.getPublication(organizationId, summary.id), "found");
  if (publication.version.id !== expected.versionId) {
    throw new StackSmokeError(`${step}: read, it is of version ${publication.version.id}`);
  }
  if (publication.sha256 !== expected.sha256) {
    throw new StackSmokeError(`${step}: its sha256 isn't the saved YAML's`);
  }
  if (sha256Hex(publication.yaml) !== expected.sha256) {
    throw new StackSmokeError(`${step}: its YAML isn't the YAML saved`);
  }
  for (const found of [summary.collector, publication.collector]) {
    if (!sameCollector(found, expected.collector)) {
      throw new StackSmokeError(
        `${step}: expected collector ${expected.collector.distribution} ${expected.collector.version}, found ${found.distribution} ${found.version}`,
      );
    }
  }
}

const USAGE =
  "usage: stack-smoke <personal organization id> | group-registered <id> <name> | group-renamed <id> <name> | group-gone <id> | publications <organization id> <configuration id> <count> [version number] | publication <organization id> <configuration id> <version number> <version id> <sha256> <distribution> <collector version>";

/** A count's or a version number's argument: digits only, at least `min`, at most `max`. */
function integerArgument(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !/^\d{1,10}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= min && number <= max ? number : undefined;
}

/**
 * stack-smoke.ts's arguments, run:
 *
 * - `<personal organization id>`: runStackSmoke, then the new account's
 *   personal organization registered under an email address, a personal
 *   organization's name;
 * - `group-registered <id> <name>`: a group organization registered under
 *   its name, after "New organization";
 * - `group-renamed <id> <name>`: renamed to `<name>`, after a rename;
 * - `group-gone <id>`: no longer registered, after a delete;
 * - `publications <organization id> <configuration id> <count> [version
 *   number]`: the configuration has `count` snapshots (0 to 100), each of
 *   that version number when given, after a publish through the gateway,
 *   or none after its delete;
 * - `publication <organization id> <configuration id> <version number>
 *   <version id> <sha256> <distribution> <collector version>`: the
 *   configuration has one snapshot, of that version, holding the YAML whose
 *   SHA-256 (hex) is given and naming that collector, after a publish
 *   through the gateway.
 *
 * Anything else throws the usage, never the arguments (a name is one).
 */
export async function runStackSmokeCommand(
  client: OpampServerClient,
  args: readonly string[],
  log: (line: string) => void = () => {},
  options: Omit<PollOptions, "label"> = {},
): Promise<void> {
  const [first, id, name] = args;
  const given = (value: string | undefined): value is string => value !== undefined && value !== "";
  if (first === "group-registered" && given(id) && given(name) && args.length === 3) {
    await expectOrganizationRegistered(client, id, { name }, { ...options, label: `the group organization ${id}` });
    log(`the group organization ${id} is registered under its name`);
  } else if (first === "group-renamed" && given(id) && given(name) && args.length === 3) {
    await expectOrganizationName(client, id, name, { ...options, label: `the group organization ${id}` });
    log(`the group organization ${id} is registered under its new name`);
  } else if (first === "group-gone" && given(id) && args.length === 2) {
    await expectOrganizationGone(client, id, { ...options, label: `the group organization ${id}` });
    log(`the group organization ${id} is no longer registered`);
  } else if (first === "publications" && (args.length === 4 || args.length === 5)) {
    const [, organizationId, configurationId, countArgument, versionArgument] = args;
    const count = integerArgument(countArgument, 0, 100);
    const versionNumber = versionArgument === undefined ? undefined : integerArgument(versionArgument, 1, 2_147_483_647);
    if (
      !given(organizationId) ||
      !given(configurationId) ||
      count === undefined ||
      (versionArgument !== undefined && versionNumber === undefined)
    ) {
      throw new StackSmokeError(USAGE);
    }
    await expectPublications(
      client,
      organizationId,
      configurationId,
      versionNumber === undefined ? { count } : { count, versionNumber },
      options,
    );
    log(
      `the configuration ${configurationId} has ${count} publication(s)${versionNumber === undefined ? "" : ` of version ${versionNumber}`}`,
    );
  } else if (first === "publication" && args.length === 8) {
    const [, organizationId, configurationId, versionArgument, versionId, sha256, distribution, collectorVersion] = args;
    const versionNumber = integerArgument(versionArgument, 1, 2_147_483_647);
    if (
      !given(organizationId) ||
      !given(configurationId) ||
      versionNumber === undefined ||
      !given(versionId) ||
      sha256 === undefined ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      distribution === undefined ||
      !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(distribution) ||
      collectorVersion === undefined ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(collectorVersion)
    ) {
      throw new StackSmokeError(USAGE);
    }
    const collector = { distribution, version: collectorVersion };
    await expectPublication(
      client,
      organizationId,
      configurationId,
      { versionNumber, versionId, sha256, collector },
      options,
    );
    log(
      `the configuration ${configurationId}'s one publication is version ${versionNumber} (${versionId}), holding the YAML saved, for ${distribution} ${collectorVersion}`,
    );
  } else if (
    given(first) &&
    !first.startsWith("group-") &&
    first !== "publications" &&
    first !== "publication" &&
    args.length === 1
  ) {
    await runStackSmoke(client, log);
    await expectOrganizationRegistered(
      client,
      first,
      PERSONAL_ORGANIZATION_NAME,
      { ...options, label: "the new account's personal organization" },
    );
    log("the new account's personal organization is registered");
  } else {
    throw new StackSmokeError(USAGE);
  }
}
