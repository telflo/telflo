import { sql, type Kysely, type Transaction } from "kysely";
import type { ApiTokenAccess, Database, OrganizationRole } from "@telflo/db";

/*
 * The database context: who a transaction acts for, as the row-level
 * security policies read it (migration
 * 1700000000011_organization_members_rls). This module is the only code that
 * names the two settings, the test-run dispatcher's third
 * (`withDispatcherContext`) and the product admin's fourth
 * (`withProductAdminContext`); a test fails if they appear anywhere else
 * outside migrations and tests.
 *
 * Every setting is made with `set_config(…, true)`, which lasts until the
 * transaction ends, so a pooled connection never carries one request's
 * context into the next. Values always travel as bind parameters.
 */

/** Who a transaction acts for. A null organization: only the user's own memberships are visible. */
export interface DatabaseContext {
  userId: string;
  organizationId: string | null;
}

/**
 * Who an action is for, whatever authenticated it: the user, the organization
 * they act in and their membership's role there. What the data services read:
 * a session's `AuthContext` and a token's `ApiTokenContext` are both one, and
 * no service reads anything else of either (none reads `sessionId`).
 */
export interface ActorContext extends DatabaseContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: OrganizationRole;
}

/**
 * Who a request acts as, built once per request by the `authenticate`
 * preHandler from the session check, and frozen. The role is read from the
 * membership on every request, never carried in the token, so a demotion
 * takes effect on the member's next request. A session's: it stays for
 * sessions, OIDC and the account.
 */
export interface AuthContext extends ActorContext {
  readonly sessionId: string;
}

/** Called only by `authenticate` (a test scans the source for other callers). */
export function createAuthContext(context: AuthContext): AuthContext {
  return Object.freeze({
    userId: context.userId,
    organizationId: context.organizationId,
    role: context.role,
    sessionId: context.sessionId,
  });
}

/** Whose a `tf_` token is: a service account's, or a person's own. */
export type ApiTokenKind = "service_account" | "person";

/**
 * Who a request on the public surface acts as once its `tf_` token is
 * accepted, honestly not a session's: the token's user in the token's
 * organization, with the membership's role as the token check read it on
 * this request, the token's kind, its id and its access. Built once per
 * request by the token check (modules/public-api/authenticate-api-token.ts),
 * and frozen. It has no `sessionId`: a token has no session, and
 * `AuthContext` stays a session's. Database work for it runs in
 * `withDatabaseContext` with its user and organization: the token's user
 * acts as itself in its organization.
 */
export interface ApiTokenContext extends ActorContext {
  readonly kind: ApiTokenKind;
  readonly tokenId: string;
  readonly access: ApiTokenAccess;
}

/** Called only by the token check, authenticate-api-token.ts (a test scans the source for other callers). */
export function createApiTokenContext(context: ApiTokenContext): ApiTokenContext {
  return Object.freeze({
    userId: context.userId,
    organizationId: context.organizationId,
    role: context.role,
    kind: context.kind,
    tokenId: context.tokenId,
    access: context.access,
  });
}

/**
 * Sets both settings on a transaction already open. For work that learns
 * whom it acts for only partway through, as refresh does once it has read
 * the session's user. A null organization clears that setting.
 */
export async function setDatabaseContext(transaction: Transaction<Database>, context: DatabaseContext): Promise<void> {
  await sql`
    select set_config('telflo.user_id', ${context.userId}, true),
           set_config('telflo.organization_id', ${context.organizationId ?? ""}, true)
  `.execute(transaction);
}

/**
 * Sets only the organization, for a transaction that must insert a
 * membership into an organization its context didn't name: registration's
 * `createAccount` and creating a group organization, each for the
 * organization it has just made, and joining by invitation, for the
 * organization whose invitation the token found. The user, if set, stays.
 */
export async function setOrganizationContext(transaction: Transaction<Database>, organizationId: string): Promise<void> {
  await sql`select set_config('telflo.organization_id', ${organizationId}, true)`.execute(transaction);
}

/**
 * Opens a transaction, sets the context, runs `work` and resolves once the
 * transaction commits. If `work` rejects, the transaction rolls back and the
 * rejection propagates.
 */
export function withDatabaseContext<Result>(
  db: Kysely<Database>,
  context: DatabaseContext,
  work: (transaction: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  return db.transaction().execute(async (transaction) => {
    await setDatabaseContext(transaction, context);
    return work(transaction);
  });
}

/** `withDatabaseContext` for a request's `ActorContext` (a session's or a token's): its user and its organization. */
export function withAuthContext<Result>(
  db: Kysely<Database>,
  context: ActorContext,
  work: (transaction: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  return withDatabaseContext(db, { userId: context.userId, organizationId: context.organizationId }, work);
}

/**
 * `withDatabaseContext` with only the user, for identity paths that act for
 * a user before any organization is chosen: sign-in's personal
 * organization, `/me`'s list, refresh.
 */
export function withUserContext<Result>(
  db: Kysely<Database>,
  userId: string,
  work: (transaction: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  return withDatabaseContext(db, { userId, organizationId: null }, work);
}

/**
 * `withDatabaseContext` with an organization and no person (the public
 * download): the user setting empty, so the policies show the
 * organization's rows that need no viewer (its quick-deploy links, every
 * published configuration and its versions, migration 021) and none that do
 * (a member's draft). Called only from the public download's files
 * (modules/quick-deploy/), once a link's secret has found its organization
 * (a test scans the source for other callers, as the dispatcher's).
 */
export function withOrganizationContext<Result>(
  db: Kysely<Database>,
  organizationId: string,
  work: (transaction: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  return db.transaction().execute(async (transaction) => {
    await sql`
      select set_config('telflo.user_id', '', true),
             set_config('telflo.organization_id', ${organizationId}, true)
    `.execute(transaction);
    return work(transaction);
  });
}

/**
 * Opens a READ COMMITTED transaction as the test-run dispatcher, runs `work`
 * and resolves once it commits (the claim runs only under READ COMMITTED, so
 * it is named rather than left to the server's default): `telflo.dispatcher`
 * is `on`, and the user and the organization are empty, the only context in
 * which migration 1700000000028's dispatcher functions (test_runs_claim,
 * _finish, _release, _reap, _fail_waiting, otelcol_testing_mark) act; they
 * refuse any other with 42501. The dispatcher works across organizations, so
 * the context names none, and row-level security shows it no organization's
 * rows: it reaches runs only through those functions.
 *
 * Called only from the dispatcher's files (modules/test-runs/dispatcher.ts and
 * reaper.ts) and the tester's health monitor (a test scans the source for
 * other callers). A guard against bugs: a member's request can't reach the
 * dispatcher's transitions through its own context.
 */
export function withDispatcherContext<Result>(
  db: Kysely<Database>,
  work: (transaction: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  return db
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await sql`
        select set_config('telflo.dispatcher', 'on', true),
               set_config('telflo.user_id', '', true),
               set_config('telflo.organization_id', '', true)
      `.execute(transaction);
      return work(transaction);
    });
}

/**
 * Opens a READ COMMITTED transaction as a product admin, runs `work` and
 * resolves once it commits: `telflo.product_admin` is `on`, the user is the
 * caller and the organization empty, the only context in which migration
 * 1700000000041's product-admin functions act (their gate also reads the
 * caller's flag, live, in each call, and refuses any other context with
 * 42501). A product admin works across organizations, so the context names
 * none, and row-level security shows it no organization's rows: it reaches
 * people and feedback only through those functions. READ COMMITTED, named
 * rather than left to the server's default: the writing functions re-read
 * the caller after their locks, which needs a fresh snapshot per statement.
 *
 * Called only from modules/product-admin/repositories/system-repository.ts
 * (a test scans the source for other callers), which audits every call in
 * the same transaction. `requireProductAdmin` on the routes is the other,
 * independent gate.
 */
export function withProductAdminContext<Result>(
  db: Kysely<Database>,
  actorUserId: string,
  work: (transaction: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  return db
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await sql`
        select set_config('telflo.product_admin', 'on', true),
               set_config('telflo.user_id', ${actorUserId}, true),
               set_config('telflo.organization_id', '', true)
      `.execute(transaction);
      return work(transaction);
    });
}
