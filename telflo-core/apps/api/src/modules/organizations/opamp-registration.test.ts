import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import {
  createOpampServerClient,
  OpampServerMisconfigurationError,
  sha256Hex,
  type DeleteOrganizationResult,
  type OpampServerClient,
} from "../../opamp-server/client.js";
import { startFakeOpampServer, type FakeOpampServer } from "../../testing/fake-opamp-server.js";
import {
  createOpampRegistration,
  DELETE_RETRY_DELAYS_MS,
  ensureOrganization,
  unrefTimer,
  type OpampRegistrationService,
} from "./opamp-registration.js";

// D11a decision 20: the platform keeps the opamp-server's registry in step
// after its own commits, best effort, against the OpenAPI-checked fake. The
// routes' tests (opamp-registration.integration.test.ts) show each path
// calls it; these show what one call sends, and what it logs.

/** A name that is an email, as a personal organization's is (Q263). */
const NAME = "secret-person@example.com";

interface LogLine {
  level: "warn" | "error";
  fields: Record<string, unknown>;
  message: string;
}

let fake: FakeOpampServer;
let client: OpampServerClient;
let runner: CollectingRunner;
let lines: LogLine[];
let registration: OpampRegistrationService;

const log = {
  warn: (fields: Record<string, unknown>, message: string) => void lines.push({ level: "warn", fields, message }),
  error: (fields: Record<string, unknown>, message: string) => void lines.push({ level: "error", fields, message }),
};

/** The registration, through `through` (the fake's client by default), queued on this test's runner. */
function registrationWith(through: OpampServerClient = client): OpampRegistrationService {
  return createOpampRegistration({ opampServer: through, runAfterResponse: runner.run, log: log as never });
}

beforeAll(async () => {
  fake = await startFakeOpampServer();
  client = createOpampServerClient({ url: fake.url, secret: fake.secret });
});

beforeEach(() => {
  runner = createCollectingRunner();
  lines = [];
  registration = registrationWith();
});

afterEach(() => {
  expect(fake.takeViolations()).toEqual([]);
  // Whatever the result: no name, no email, no secret in a log line.
  const logged = JSON.stringify(lines);
  expect(logged).not.toContain("secret-person");
  expect(logged).not.toContain("example.com");
  expect(logged).not.toContain(fake.secret);
});

afterAll(async () => {
  await fake.close();
});

describe("createOpampRegistration", () => {
  it("registers a created organization under its id and name, after the response only", async () => {
    const id = randomUUID();

    registration.created({ id, name: NAME });
    expect(await client.getOrganization(id)).toEqual({ kind: "not_found" });
    await runner.settle();

    expect(await client.getOrganization(id)).toMatchObject({ kind: "found", organization: { organizationId: id, name: NAME } });
    expect(lines).toEqual([]);
  });

  it("logs nothing when the organization was registered already with its name (unchanged)", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: NAME });

    registration.created({ id, name: NAME });
    await runner.settle();

    expect(lines).toEqual([]);
  });

  it("warns, naming the id and the result only, when the id is registered under another name (409)", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "another-person@example.com" });

    registration.created({ id, name: NAME });
    await runner.settle();

    expect(lines).toEqual([
      {
        level: "warn",
        fields: { operation: "createOrganization", organizationId: id, result: "conflict" },
        message: "the opamp-server didn't register the organization",
      },
    ]);
  });

  it("warns with the error's code when the server refuses the request", async () => {
    const id = randomUUID();

    registration.created({ id, name: "x".repeat(401) });
    await runner.settle();

    expect(fake.takeViolations()).toHaveLength(1);
    expect(lines).toEqual([
      {
        level: "warn",
        fields: { operation: "createOrganization", organizationId: id, result: "invalid", code: "invalid_request" },
        message: "the opamp-server didn't register the organization",
      },
    ]);
  });

  it("warns, and throws nothing, when the opamp-server is down", async () => {
    const id = randomUUID();
    fake.nextFault("error_500");

    registration.created({ id, name: NAME });
    await expect(runner.settle()).resolves.toBeUndefined();

    expect(lines).toEqual([
      {
        level: "warn",
        fields: { operation: "createOrganization", organizationId: id, result: "unavailable", reason: "server_error", status: 500 },
        message: "the opamp-server didn't register the organization",
      },
    ]);
  });

  it("warns when nothing listens at all", async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((done) => closed.close(() => done()));
    const nobody = registrationWith(createOpampServerClient({ url: `http://127.0.0.1:${port}`, secret: fake.secret }));
    const id = randomUUID();

    nobody.created({ id, name: NAME });
    await runner.settle();

    expect(lines).toEqual([
      expect.objectContaining({ level: "warn", fields: expect.objectContaining({ result: "unavailable", reason: "network" }) }),
    ]);
  });

  it("renames with PATCH", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Acme" });

    registration.renamed({ id, name: "Acme Corp" });
    await runner.settle();

    expect(await client.getOrganization(id)).toMatchObject({ organization: { name: "Acme Corp" } });
    expect(lines).toEqual([]);
  });

  it("warns when the organization to rename isn't registered (404)", async () => {
    const id = randomUUID();

    registration.renamed({ id, name: NAME });
    await runner.settle();

    expect(lines).toEqual([
      {
        level: "warn",
        fields: { operation: "renameOrganization", organizationId: id, result: "not_found" },
        message: "the opamp-server didn't rename the organization",
      },
    ]);
  });

  it("deletes with DELETE, and the organization's publications go with it", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "Acme" });
    const yaml = "receivers:\n  otlp:\n";
    const publicationId = randomUUID();
    const put = await client.postPublication(id, publicationId, {
      configuration: { id: randomUUID(), name: "payments" },
      version: { id: randomUUID(), number: 1, label: null },
      yaml,
      sha256: sha256Hex(yaml),
      publishedBy: null,
      publishedAt: new Date().toISOString(),
      collector: { distribution: "otelcol-contrib", version: "0.162.0" },
    });
    expect(put.kind).toBe("created");

    registration.deleted(id);
    await runner.settle();

    expect(await client.getOrganization(id)).toEqual({ kind: "not_found" });
    await client.createOrganization({ id, name: "Acme" });
    expect(await client.getPublication(id, publicationId)).toEqual({ kind: "not_found" });
    expect(lines).toEqual([]);
  });

  it("counts the delete of an organization it doesn't hold (404) as done: the DELETE is idempotent (D16b Preflight ruling 14)", async () => {
    const id = randomUUID();

    registration.deleted(id);
    expect(registration.pendingDeletes()).toEqual([id]);
    await runner.settle();

    expect(lines).toEqual([]);
    expect(registration.pendingDeletes()).toEqual([]);
  });

  it("logs a refused secret as an error with the client's message, which names no secret", async () => {
    const wrongSecret = "a-wrong-but-long-enough-secret-0123456789";
    const misconfigured = registrationWith(createOpampServerClient({ url: fake.url, secret: wrongSecret }));
    const id = randomUUID();

    misconfigured.created({ id, name: NAME });
    await expect(runner.settle()).resolves.toBeUndefined();

    expect(lines).toEqual([
      {
        level: "error",
        fields: {
          operation: "createOrganization",
          organizationId: id,
          error: "The opamp-server answered createOrganization with 401: it doesn't accept TELFLO_OPAMP_MANAGEMENT_SECRET.",
        },
        message: "the opamp-server's settings are wrong",
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(wrongSecret);
  });

  it("logs any other failure by its error's name only", async () => {
    const failing = registrationWith({
      ...client,
      deleteOrganization: () => Promise.reject(new TypeError(`a message quoting ${NAME}`)),
    });
    const id = randomUUID();

    failing.deleted(id);
    await expect(runner.settle()).resolves.toBeUndefined();

    expect(lines).toEqual([
      {
        level: "error",
        fields: { operation: "deleteOrganization", organizationId: id, attempt: 1, attempts: 5, error: "TypeError" },
        message: "deleting the organization in the opamp-server failed: the delete stops here; reconcile it by hand",
      },
    ]);
  });
});

describe("an organization's delete, retried (D16b decision 20; Preflight ruling 14)", () => {
  /** How many attempts the registration has handed the runner. */
  let handed: number;

  beforeEach(() => {
    vi.useFakeTimers();
    handed = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type Step = DeleteOrganizationResult | Error;

  /**
   * A registration whose client answers each organization's deletes from its
   * script, in order (`deleted` once a script runs out), counting the
   * attempts it hands the runner. A scripted client, not the fake over a
   * socket: the client's own timer is a setTimeout, which fake timers hold.
   */
  function scripted(scripts: Record<string, Step[]>) {
    const deleteOrganization = vi.fn(async (organizationId: string): Promise<DeleteOrganizationResult> => {
      const step = scripts[organizationId]?.shift() ?? { kind: "deleted" };
      if (step instanceof Error) throw step;
      return step;
    });
    const scriptedRegistration = createOpampRegistration({
      opampServer: { ...client, deleteOrganization },
      runAfterResponse: (task) => {
        handed += 1;
        runner.run(task);
      },
      log: log as never,
    });
    return { registration: scriptedRegistration, deleteOrganization };
  }

  /** Lets `ms` pass, then runs what the timers handed the runner. */
  const after = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    await runner.settle();
  };

  const TIMEOUT: DeleteOrganizationResult = { kind: "unavailable", reason: "timeout" };
  const SERVER_ERROR: DeleteOrganizationResult = { kind: "unavailable", reason: "server_error", status: 503 };
  const OVERSIZED: DeleteOrganizationResult = { kind: "unavailable", reason: "oversized_reply" };

  /** A failed attempt's warning: the ids, the attempt, the wait and the result's kind. */
  const retrying = (organizationId: string, attempt: number, retryInSeconds: number, result: Record<string, unknown>) => ({
    level: "warn",
    fields: { operation: "deleteOrganization", organizationId, attempt, attempts: 5, retryInSeconds, ...result },
    message: "the opamp-server didn't delete the organization: retrying",
  });

  it("waits 5 s, 30 s, 2 min and 10 min: five attempts, a frozen list", () => {
    expect(DELETE_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000, 600_000]);
    expect(Object.isFrozen(DELETE_RETRY_DELAYS_MS)).toBe(true);
    expect(() => (DELETE_RETRY_DELAYS_MS as number[]).push(1)).toThrow(TypeError);
  });

  it("deletes at the first attempt, after the response: one call, nothing logged, nothing pending, no timer", async () => {
    const id = randomUUID();
    const { registration: hooks, deleteOrganization } = scripted({ [id]: [{ kind: "deleted" }] });

    hooks.deleted(id);
    expect(deleteOrganization).not.toHaveBeenCalled();
    expect(hooks.pendingDeletes()).toEqual([id]);
    await runner.settle();

    expect(deleteOrganization.mock.calls).toEqual([[id]]);
    expect(handed).toBe(1);
    expect(lines).toEqual([]);
    expect(hooks.pendingDeletes()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deletes after two failures: the second attempt 5 s after the first, the third 30 s after the second, each through the runner", async () => {
    const id = randomUUID();
    const { registration: hooks, deleteOrganization } = scripted({ [id]: [TIMEOUT, SERVER_ERROR, { kind: "deleted" }] });

    hooks.deleted(id);
    await runner.settle();
    expect(deleteOrganization).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await after(4_999);
    expect(handed).toBe(1);
    await after(1);
    expect(handed).toBe(2);
    expect(deleteOrganization).toHaveBeenCalledTimes(2);

    await after(29_999);
    expect(handed).toBe(2);
    await after(1);
    expect(handed).toBe(3);
    expect(deleteOrganization.mock.calls).toEqual([[id], [id], [id]]);

    expect(lines).toEqual([
      retrying(id, 1, 5, { result: "unavailable", reason: "timeout" }),
      retrying(id, 2, 30, { result: "unavailable", reason: "server_error", status: 503 }),
    ]);
    expect(hooks.pendingDeletes()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts a 404 after a failure as done", async () => {
    const id = randomUUID();
    const { registration: hooks, deleteOrganization } = scripted({ [id]: [OVERSIZED, { kind: "not_found" }] });

    hooks.deleted(id);
    await runner.settle();
    await after(5_000);
    await after(60 * 60_000);

    expect(deleteOrganization).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([retrying(id, 1, 5, { result: "unavailable", reason: "oversized_reply" })]);
    expect(hooks.pendingDeletes()).toEqual([]);
  });

  it("counts as done a delete that finished after the platform hung up: the first attempt times out at the client's 25 s, the retry answers 404, and nothing is an error (Ruling 32)", async () => {
    const id = randomUUID();
    const requests: string[] = [];
    const hangsThenNotFound = createOpampServerClient({
      url: "http://opamp-server.invalid",
      secret: fake.secret,
      fetch: (url, init) => {
        requests.push(`${init?.method} ${String(url)}`);
        if (requests.length === 1) {
          // The opamp-server is still deleting: no answer until the client gives up.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        // It finished meanwhile: the organization is gone.
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "not_found", message: "Not found." } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    const hooks = createOpampRegistration({ opampServer: hangsThenNotFound, runAfterResponse: runner.run, log: log as never });

    hooks.deleted(id);
    const firstAttempt = runner.settle();
    await vi.advanceTimersByTimeAsync(24_999);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await firstAttempt;
    expect(lines).toEqual([retrying(id, 1, 5, { result: "unavailable", reason: "timeout" })]);

    await after(5_000);

    expect(requests).toEqual([
      `DELETE http://opamp-server.invalid/api/v1/organizations/${id}`,
      `DELETE http://opamp-server.invalid/api/v1/organizations/${id}`,
    ]);
    expect(lines).toEqual([retrying(id, 1, 5, { result: "unavailable", reason: "timeout" })]);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
    expect(hooks.pendingDeletes()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never attempts more than five times: the fifth failure is an error saying to reconcile by hand", async () => {
    const id = randomUUID();
    const { registration: hooks, deleteOrganization } = scripted({ [id]: Array.from({ length: 10 }, () => TIMEOUT) });

    hooks.deleted(id);
    await runner.settle();
    for (const delay of [5_000, 30_000, 120_000, 600_000]) await after(delay);
    expect(deleteOrganization).toHaveBeenCalledTimes(5);
    await after(24 * 60 * 60_000);

    expect(deleteOrganization).toHaveBeenCalledTimes(5);
    expect(handed).toBe(5);
    const unavailable = { result: "unavailable", reason: "timeout" };
    expect(lines).toEqual([
      retrying(id, 1, 5, unavailable),
      retrying(id, 2, 30, unavailable),
      retrying(id, 3, 120, unavailable),
      retrying(id, 4, 600, unavailable),
      {
        level: "error",
        fields: { operation: "deleteOrganization", organizationId: id, attempt: 5, attempts: 5, ...unavailable },
        message: "the opamp-server didn't delete the organization after every attempt: reconcile it by hand",
      },
    ]);
    expect(hooks.pendingDeletes()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("doesn't retry a misconfiguration: an error with the client's message, which names no secret", async () => {
    const id = randomUUID();
    const message = "The opamp-server answered deleteOrganization with 401: it doesn't accept TELFLO_OPAMP_MANAGEMENT_SECRET.";
    const { registration: hooks, deleteOrganization } = scripted({ [id]: [TIMEOUT, new OpampServerMisconfigurationError(message), TIMEOUT] });

    hooks.deleted(id);
    await runner.settle();
    await after(5_000);
    await after(24 * 60 * 60_000);

    expect(deleteOrganization).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([
      retrying(id, 1, 5, { result: "unavailable", reason: "timeout" }),
      {
        level: "error",
        fields: { operation: "deleteOrganization", organizationId: id, attempt: 2, attempts: 5, error: message },
        message: "the opamp-server's settings are wrong: the organization's delete stops here; reconcile it by hand",
      },
    ]);
    expect(hooks.pendingDeletes()).toEqual([]);
  });

  it("doesn't retry a refusal (invalid): an error with its code", async () => {
    const id = randomUUID();
    const { registration: hooks, deleteOrganization } = scripted({
      [id]: [{ kind: "invalid", code: "invalid_request" }, TIMEOUT],
    });

    hooks.deleted(id);
    await runner.settle();
    await after(24 * 60 * 60_000);

    expect(deleteOrganization).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      {
        level: "error",
        fields: { operation: "deleteOrganization", organizationId: id, attempt: 1, attempts: 5, result: "invalid", code: "invalid_request" },
        message: "the opamp-server refused to delete the organization: reconcile it by hand",
      },
    ]);
    expect(hooks.pendingDeletes()).toEqual([]);
  });

  it("doesn't retry any other throw: its name only", async () => {
    const id = randomUUID();
    const { registration: hooks, deleteOrganization } = scripted({ [id]: [new RangeError(`a message quoting ${NAME}`), TIMEOUT] });

    hooks.deleted(id);
    await runner.settle();
    await after(24 * 60 * 60_000);

    expect(deleteOrganization).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      expect.objectContaining({ level: "error", fields: { operation: "deleteOrganization", organizationId: id, attempt: 1, attempts: 5, error: "RangeError" } }),
    ]);
    expect(hooks.pendingDeletes()).toEqual([]);
  });

  it("empties the pending set as retries finish, and at close logs those still pending at error, cancelling their timers", async () => {
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    const { registration: hooks, deleteOrganization } = scripted({
      [first]: [TIMEOUT, { kind: "deleted" }],
      [second]: [TIMEOUT, TIMEOUT],
      [third]: [{ kind: "deleted" }],
    });

    hooks.deleted(first);
    hooks.deleted(second);
    hooks.deleted(third);
    expect(hooks.pendingDeletes()).toEqual([first, second, third]);
    await runner.settle();
    expect(hooks.pendingDeletes()).toEqual([first, second]);
    await after(5_000);
    expect(hooks.pendingDeletes()).toEqual([second]);
    expect(vi.getTimerCount()).toBe(1);

    lines = [];
    hooks.close();
    expect(lines).toEqual([
      {
        level: "error",
        fields: { operation: "deleteOrganization", organizationIds: [second] },
        message:
          "stopping with organizations' deletes pending in the opamp-server: an attempt in flight may still land, but no retry will run; reconcile each by hand unless it landed",
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await after(24 * 60 * 60_000);
    expect(deleteOrganization).toHaveBeenCalledTimes(5);
  });

  it("logs nothing at close when no delete is pending", async () => {
    const id = randomUUID();
    const { registration: hooks } = scripted({ [id]: [{ kind: "deleted" }] });
    hooks.deleted(id);
    await runner.settle();
    hooks.close();
    expect(lines).toEqual([]);
  });

  it("keeps an organization pending while any of its deletes is (a fleet's create asking again, Preflight ruling 13)", async () => {
    const id = randomUUID();
    const { registration: hooks, deleteOrganization } = scripted({ [id]: [TIMEOUT, { kind: "deleted" }, { kind: "deleted" }] });

    hooks.deleted(id);
    await runner.settle();
    hooks.deleted(id);
    await runner.settle();
    // The second delete landed; the first still waits on its retry.
    expect(hooks.pendingDeletes()).toEqual([id]);
    await after(5_000);
    expect(hooks.pendingDeletes()).toEqual([]);
    expect(deleteOrganization).toHaveBeenCalledTimes(3);
  });

  it("schedules no retry for an attempt that fails after close", async () => {
    const id = randomUUID();
    const { registration: hooks, deleteOrganization } = scripted({ [id]: [TIMEOUT] });

    hooks.deleted(id);
    hooks.close();
    await runner.settle();
    await after(24 * 60 * 60_000);

    expect(deleteOrganization).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(lines.at(-1)).toMatchObject({ level: "warn", fields: { organizationId: id, attempt: 1, result: "unavailable" } });
  });

  it("logs at error a delete asked for after close, which close() couldn't name, and attempts it once with no retry", async () => {
    const [landing, failing] = [randomUUID(), randomUUID()];
    const { registration: hooks, deleteOrganization } = scripted({ [landing]: [{ kind: "deleted" }], [failing]: [TIMEOUT, { kind: "deleted" }] });
    hooks.close();
    expect(lines).toEqual([]);

    hooks.deleted(landing);
    hooks.deleted(failing);
    const lost = (organizationId: string) => ({
      level: "error",
      fields: { operation: "deleteOrganization", organizationId },
      message:
        "the organization was deleted while the server is stopping: its delete in the opamp-server is attempted once, with no retry, and may be lost; reconcile it by hand unless it landed",
    });
    expect(lines).toEqual([lost(landing), lost(failing)]);
    await runner.settle();
    await after(24 * 60 * 60_000);

    expect(deleteOrganization.mock.calls).toEqual([[landing], [failing]]);
    expect(lines).toEqual([
      lost(landing),
      lost(failing),
      {
        level: "warn",
        fields: { operation: "deleteOrganization", organizationId: failing, attempt: 1, attempts: 5, result: "unavailable", reason: "timeout" },
        message: "the opamp-server didn't delete the organization, and the server is stopping: not retried",
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds nothing open: every retry's timer is unref'd", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const id = randomUUID();
    const { registration: hooks } = scripted({ [id]: [TIMEOUT, TIMEOUT] });
    try {
      hooks.deleted(id);
      await runner.settle();
      await after(5_000);

      const handles = setTimeoutSpy.mock.results.map((result) => result.value as NodeJS.Timeout);
      expect(handles).toHaveLength(2);
      for (const handle of handles) expect(handle.hasRef()).toBe(false);
    } finally {
      setTimeoutSpy.mockRestore();
      hooks.close();
    }
  });
});

describe("unrefTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules on a Node timer that doesn't hold the process open", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const cancel = unrefTimer(() => undefined, 60_000);
      const handle = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout;
      expect(handle.hasRef()).toBe(false);
      cancel();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("runs the callback after the delay, and never once cancelled", () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    unrefTimer(() => ran.push("kept"), 1_000);
    const cancel = unrefTimer(() => ran.push("cancelled"), 1_000);
    cancel();
    vi.advanceTimersByTime(999);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ran).toEqual(["kept"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ensureOrganization (D11a decision 20; D16b Preflight ruling 10: publishing's, moved)", () => {
  it("registers an unknown organization, and answers one already registered under its name, ensured", async () => {
    const id = randomUUID();
    expect(await ensureOrganization(client, { id, name: NAME })).toEqual({ kind: "ensured" });
    expect(await ensureOrganization(client, { id, name: NAME })).toEqual({ kind: "ensured" });
    expect(fake.snapshotOf(id)).toMatchObject({ organization: { name: NAME } });
  });

  it("renames one registered under another name (a rename the hooks missed)", async () => {
    const id = randomUUID();
    await client.createOrganization({ id, name: "an older name" });
    expect(await ensureOrganization(client, { id, name: NAME })).toEqual({ kind: "ensured" });
    expect(fake.snapshotOf(id)).toMatchObject({ organization: { name: NAME } });
  });

  it("answers the call that failed and its result, for the caller to map: the create's, then the rename's", async () => {
    const id = randomUUID();
    fake.nextFault("error_500", "createOrganization");
    expect(await ensureOrganization(client, { id, name: NAME })).toEqual({
      kind: "failed",
      operation: "createOrganization",
      result: { kind: "unavailable", reason: "server_error", status: 500 },
    });
    const invalid = { kind: "invalid", code: "invalid_request" } as const;
    expect(
      await ensureOrganization({ ...client, createOrganization: async () => invalid }, { id, name: NAME }),
    ).toEqual({ kind: "failed", operation: "createOrganization", result: invalid });

    await client.createOrganization({ id, name: "an older name" });
    // Deleted between the create's conflict and the rename.
    const vanishing = { ...client, renameOrganization: async () => ({ kind: "not_found" }) as const };
    expect(await ensureOrganization(vanishing, { id, name: NAME })).toEqual({
      kind: "failed",
      operation: "renameOrganization",
      result: { kind: "not_found" },
    });
  });
});
