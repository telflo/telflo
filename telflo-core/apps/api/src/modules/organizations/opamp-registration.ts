import type { FastifyBaseLogger } from "fastify";
import type { RunAfterResponse } from "../../http/after-response.js";
import {
  OpampServerMisconfigurationError,
  type CreateOrganizationResult,
  type OpampServerClient,
  type RenameOrganizationResult,
} from "../../opamp-server/client.js";

/*
 * The opamp-server's registry of organizations, kept in step with the
 * platform's (D11a decision 20). The platform registers an organization
 * after its own commit, best effort: each change is scheduled with
 * runAfterResponse, so a request is never slower for it and never fails
 * because the opamp-server is down. A miss is a logged warning; D11b's
 * publish and D16b's fleet create "ensure" the organization first
 * (`ensureOrganization`, below), which heals it.
 *
 * - created: createAccount's personal organization (password, Google and
 *   invitation sign-up) and "New organization"'s group one, POSTed with the
 *   platform's own id, so a retry is safe;
 * - renamed: PATCH, when a rename changed the name;
 * - deleted: DELETE, which takes the organization's publications, fleets,
 *   collectors and tokens with it, retried until it lands (D16b decision
 *   20, Preflight ruling 14; nothing else would heal a missed delete).
 *
 * The create and the rename aren't retried: a retried rename could land
 * after a later one, and a fleet's create and a publish ensure both.
 *
 * The log lines name the operation, the organization's id and the result's
 * kind (with a reason, a status or an error code): never its name, which
 * carries a personal organization's owner's email, nor any email or the
 * secret. The id is the platform's opaque key, logged as other modules log
 * it, so an operator can find the organization to heal.
 */

export interface OpampRegistration {
  /** After the organization's creation has committed. */
  created(organization: { id: string; name: string }): void;
  /** After a rename that changed the name has committed. */
  renamed(organization: { id: string; name: string }): void;
  /** After the organization's deletion has committed. */
  deleted(organizationId: string): void;
}

/** The registration as the server holds it: the hooks, and what is still pending when it stops. */
export interface OpampRegistrationService extends OpampRegistration {
  /**
   * Tests only (the server never calls it: close() logs the same ids): the
   * organizations whose delete hasn't landed or stopped yet, an attempt
   * queued, running or waiting on its timer.
   */
  pendingDeletes(): string[];
  /**
   * At the server's close: cancels the retries' timers and logs, at error,
   * the organizations whose delete is still pending. Not all of them are
   * lost: an attempt queued or in flight at close may still land (its
   * failure is then a warning, not retried), but no retry will run, so each
   * is to be checked and reconciled by hand. A delete asked for after close
   * is attempted once, and logged at error the same way.
   */
  close(): void;
}

/**
 * Schedules `callback` after `delayMs` without holding the process open
 * (an unref'd timer), and answers a function that cancels it.
 */
export type SetTimer = (callback: () => void, delayMs: number) => () => void;

/** The production timer: Node's setTimeout, unref'd. */
export const unrefTimer: SetTimer = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  handle.unref();
  return () => clearTimeout(handle);
};

/**
 * Preflight ruling 14: an organization's delete is attempted at once (the
 * after-response task), then 5 s, 30 s, 2 min and 10 min after each
 * failure before it (five attempts, about 12.6 minutes in all).
 */
export const DELETE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 30_000, 120_000, 600_000]);

export interface OpampRegistrationDependencies {
  /** Required (D11b decision 8): every server has one, and tests a fake's. */
  opampServer: OpampServerClient;
  runAfterResponse: RunAfterResponse;
  log: Pick<FastifyBaseLogger, "warn" | "error">;
  /** The waits before a delete's later attempts, one per retry (DELETE_RETRY_DELAYS_MS by default). */
  deleteRetryDelaysMs?: readonly number[];
  /** How a later attempt is scheduled (unrefTimer by default). */
  setTimer?: SetTimer;
}

type Operation = "createOrganization" | "renameOrganization";

/**
 * What a result says in a log line: its kind, and an unavailable's reason
 * and status or an invalid's code (the client keeps no server text). The
 * publish and the configuration delete's clean-up log their results with
 * it too (configurations/publishing.ts).
 */
export function describeResult(result: {
  kind: string;
  reason?: string;
  status?: number;
  code?: string;
}): Record<string, unknown> {
  return {
    result: result.kind,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.status === undefined ? {} : { status: result.status }),
    ...(result.code === undefined ? {} : { code: result.code }),
  };
}

/**
 * What `ensureOrganization` did: the organization is registered under its
 * current name, or the call that failed and its result, for the caller to
 * map (a publish's 503 `publishing_unavailable` or 500, a fleet create's
 * 503 `fleets_unavailable`).
 */
export type EnsureOrganizationResult =
  | { kind: "ensured" }
  | {
      kind: "failed";
      operation: "createOrganization";
      result: Exclude<CreateOrganizationResult, { kind: "created" | "unchanged" | "conflict" }>;
    }
  | {
      kind: "failed";
      operation: "renameOrganization";
      result: Exclude<RenameOrganizationResult, { kind: "renamed" }>;
    };

/**
 * D11a decision 20, as D11b's publish ensures it before its snapshot (and
 * D16b's fleet create before its fleet, decision 15): the organization
 * registered under its current name. A create with the platform's id; on a
 * conflict (registered under another name, by an earlier rename the
 * best-effort hooks missed), a rename. A rename that finds it gone (deleted
 * since the conflict) fails, as an outage would: a retry registers it
 * again. A misconfiguration (the client's OpampServerMisconfigurationError)
 * is thrown, as the client throws it. Logs nothing: the caller logs its
 * ids and the result's kind.
 */
export async function ensureOrganization(
  opampServer: Pick<OpampServerClient, "createOrganization" | "renameOrganization">,
  organization: { id: string; name: string },
): Promise<EnsureOrganizationResult> {
  const created = await opampServer.createOrganization({ id: organization.id, name: organization.name });
  switch (created.kind) {
    case "created":
    case "unchanged":
      return { kind: "ensured" };
    case "unavailable":
    case "invalid":
      return { kind: "failed", operation: "createOrganization", result: created };
    case "conflict":
      break;
  }
  const renamed = await opampServer.renameOrganization(organization.id, organization.name);
  if (renamed.kind === "renamed") return { kind: "ensured" };
  return { kind: "failed", operation: "renameOrganization", result: renamed };
}

const WARNINGS: Record<Operation, string> = {
  createOrganization: "the opamp-server didn't register the organization",
  renameOrganization: "the opamp-server didn't rename the organization",
};

export function createOpampRegistration(deps: OpampRegistrationDependencies): OpampRegistrationService {
  const { opampServer, runAfterResponse, log } = deps;
  const retryDelaysMs = deps.deleteRetryDelaysMs ?? DELETE_RETRY_DELAYS_MS;
  const setTimer = deps.setTimer ?? unrefTimer;
  const attempts = retryDelaysMs.length + 1;
  /** Each organization whose delete is pending, with how many deletes of it are (a fleet's create can ask again: Preflight ruling 13). */
  const pending = new Map<string, number>();
  /** The cancels of the timers waiting to hand a later attempt to the runner. */
  const timers = new Set<() => void>();
  /** Set at the server's close: an attempt still running then schedules no other. */
  let isClosed = false;

  /**
   * Schedules `call`, and logs a warning for any result but the ones in
   * `expected`. Nothing is thrown into the request, nor out of the job: a
   * misconfiguration (a 401, or a reply the API doesn't document) is logged
   * as an error with its message, which names no secret, name or email.
   */
  function schedule(
    operation: Operation,
    organizationId: string,
    expected: readonly string[],
    call: () => Promise<{ kind: string }>,
  ): void {
    runAfterResponse(async () => {
      try {
        const result = await call();
        if (!expected.includes(result.kind)) {
          log.warn({ operation, organizationId, ...describeResult(result) }, WARNINGS[operation]);
        }
      } catch (error) {
        if (error instanceof OpampServerMisconfigurationError) {
          log.error({ operation, organizationId, error: error.message }, "the opamp-server's settings are wrong");
          return;
        }
        // A bug: its name only, since its message could quote anything.
        log.error(
          { operation, organizationId, error: error instanceof Error ? error.name : typeof error },
          "registering the organization in the opamp-server failed",
        );
      }
    });
  }

  /** One delete of `organizationId` ended: landed, stopped or out of attempts. */
  function finished(organizationId: string): void {
    const left = (pending.get(organizationId) ?? 1) - 1;
    if (left > 0) pending.set(organizationId, left);
    else pending.delete(organizationId);
  }

  /**
   * Preflight ruling 14: attempt `attempt` of the organization's delete,
   * handed to the runner (so the tests' and the browser tests' runners see
   * every attempt). Done: deleted, or not found (the DELETE is idempotent).
   * Retried, after the next delay: unavailable (a timeout, the network, a
   * 5xx, an oversized reply). Stopped at once, at error: invalid, a
   * misconfiguration, any other throw (its name only). Each failed attempt
   * is a warning with the ids, the attempt and the wait; the last an error
   * saying to reconcile by hand. Never a name, an email or a message.
   */
  function attemptDelete(organizationId: string, attempt: number): void {
    runAfterResponse(async () => {
      const ids = { operation: "deleteOrganization", organizationId, attempt, attempts };
      let result: Awaited<ReturnType<OpampServerClient["deleteOrganization"]>>;
      try {
        result = await opampServer.deleteOrganization(organizationId);
      } catch (error) {
        finished(organizationId);
        if (error instanceof OpampServerMisconfigurationError) {
          log.error({ ...ids, error: error.message }, "the opamp-server's settings are wrong: the organization's delete stops here; reconcile it by hand");
          return;
        }
        // A bug: its name only, since its message could quote anything.
        log.error(
          { ...ids, error: error instanceof Error ? error.name : typeof error },
          "deleting the organization in the opamp-server failed: the delete stops here; reconcile it by hand",
        );
        return;
      }
      switch (result.kind) {
        case "deleted":
        case "not_found":
          finished(organizationId);
          return;
        case "unavailable": {
          const delayMs = retryDelaysMs[attempt - 1];
          if (isClosed) {
            // Stopping: close() logged it among the pending, and nothing would run the retry.
            log.warn({ ...ids, ...describeResult(result) }, "the opamp-server didn't delete the organization, and the server is stopping: not retried");
            return;
          }
          if (delayMs === undefined) {
            finished(organizationId);
            log.error(
              { ...ids, ...describeResult(result) },
              "the opamp-server didn't delete the organization after every attempt: reconcile it by hand",
            );
            return;
          }
          log.warn({ ...ids, retryInSeconds: delayMs / 1000, ...describeResult(result) }, "the opamp-server didn't delete the organization: retrying");
          const cancel = setTimer(() => {
            timers.delete(cancel);
            attemptDelete(organizationId, attempt + 1);
          }, delayMs);
          timers.add(cancel);
          return;
        }
        default:
          finished(organizationId);
          log.error({ ...ids, ...describeResult(result) }, "the opamp-server refused to delete the organization: reconcile it by hand");
      }
    });
  }

  return {
    created({ id, name }) {
      schedule("createOrganization", id, ["created", "unchanged"], () => opampServer.createOrganization({ id, name }));
    },
    renamed({ id, name }) {
      schedule("renameOrganization", id, ["renamed"], () => opampServer.renameOrganization(id, name));
    },
    deleted(organizationId) {
      if (isClosed) {
        // After close() logged what was pending: this one would be missed.
        log.error(
          { operation: "deleteOrganization", organizationId },
          "the organization was deleted while the server is stopping: its delete in the opamp-server is attempted once, with no retry, and may be lost; reconcile it by hand unless it landed",
        );
      }
      pending.set(organizationId, (pending.get(organizationId) ?? 0) + 1);
      attemptDelete(organizationId, 1);
    },
    pendingDeletes() {
      return [...pending.keys()];
    },
    close() {
      isClosed = true;
      for (const cancel of timers) cancel();
      timers.clear();
      const organizationIds = [...pending.keys()];
      if (organizationIds.length > 0) {
        log.error(
          { operation: "deleteOrganization", organizationIds },
          "stopping with organizations' deletes pending in the opamp-server: an attempt in flight may still land, but no retry will run; reconcile each by hand unless it landed",
        );
      }
    },
  };
}
