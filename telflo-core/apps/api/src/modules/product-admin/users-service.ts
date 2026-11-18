import { ADMIN_USERS_PAGE_SIZE, type AdminUsersPage } from "@telflo/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { IFileStore } from "../../file-store/file-store.js";
import type { OpampRegistration } from "../organizations/opamp-registration.js";
import { canonicalIdOf, removeLogoQuietly } from "../organizations/service.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { productAdminRequired, userDeleteBlocked, userDeleteBusy, userDeleteSelf, userNotFound } from "./errors.js";
import type { ISystemRepository, ProductAdminActor } from "./repositories/system-repository.js";

/*
 * Users (D29 decisions 3, 9, 11, 29 to 31): the list and the delete, on the
 * SystemRepository, which audits each call in its transaction.
 *
 *   * list: a page of live people, newest first, ADMIN_USERS_PAGE_SIZE at
 *     most, after the cursor; the repository reads one more row to know
 *     whether another page follows (`hasMore`: `nextCursor` is the last row
 *     shown, else null) and audits the rows returned (Ruling 264). The term
 *     goes to the database only: never a log line, an error or the cursor.
 *   * delete: the id through canonicalIdOf (a non-canonical one is 404,
 *     never reaching the database); the repository's refusals as the
 *     contracts' fixed errors (`user_delete_blocked` carries the block's
 *     kind only). After the commit, as an organization's delete does: each
 *     organization the person's delete removed is sent to the opamp-server
 *     (`opampRegistration.deleted`, after the response, retried) and its
 *     logo's bytes removed (`removeLogoQuietly`: a failure is a warning
 *     with the organization's id and codes, never a throw).
 */

export interface UsersServiceDependencies {
  systemRepository: ISystemRepository;
  now: () => Date;
  opampRegistration: Pick<OpampRegistration, "deleted">;
  fileStore: Pick<IFileStore, "remove">;
  log: Pick<FastifyBaseLogger, "warn">;
}

export interface ListUsersRequest {
  /** Trimmed by the contract; empty or absent is no search. */
  q?: string | undefined;
  cursor?: string | undefined;
}

export interface IUsersService {
  list(actor: ProductAdminActor, request: ListUsersRequest): Promise<AdminUsersPage>;
  delete(actor: ProductAdminActor, userId: string): Promise<void>;
}

export function createUsersService(deps: UsersServiceDependencies): IUsersService {
  const { systemRepository, now, opampRegistration, fileStore, log } = deps;

  return {
    async list(actor, { q, cursor }) {
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      const { rows: shown, hasMore } = await systemRepository.listUsers(actor, {
        query: q === undefined || q === "" ? undefined : q,
        after,
        pageSize: ADMIN_USERS_PAGE_SIZE,
        at: now(),
      });
      const last = shown.at(-1);
      return {
        items: shown.map((row) => ({
          id: row.id,
          email: row.email,
          createdAt: row.createdAt.toISOString(),
          isProductAdmin: row.isProductAdmin,
          block: row.block,
        })),
        nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
      };
    },

    async delete(actor, userId) {
      const id = canonicalIdOf(userId);
      if (id === undefined) throw userNotFound();
      const result = await systemRepository.deleteUser(actor, id, now());
      switch (result.outcome) {
        case "not_found":
          throw userNotFound();
        case "self":
          throw userDeleteSelf();
        case "forbidden":
          throw productAdminRequired();
        case "blocked":
          throw userDeleteBlocked(result.kind);
        case "busy":
          throw userDeleteBusy();
        case "deleted":
          break;
      }
      // Committed: each logo's bytes are unreachable now, and removed; the
      // opamp-server deletes each organization after the response.
      for (const organization of result.organizations) {
        if (organization.logoId !== null) await removeLogoQuietly({ fileStore, log }, organization.id, organization.logoId);
        opampRegistration.deleted(organization.id);
      }
    },
  };
}
