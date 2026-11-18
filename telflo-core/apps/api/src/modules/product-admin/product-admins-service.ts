import type { ProductAdmin } from "@telflo/contracts";
import { canonicalIdOf } from "../organizations/service.js";
import { lastProductAdmin, productAdminNotFound, productAdminRequired, productAdminTargetNotFound } from "./errors.js";
import type { ISystemRepository, ProductAdminActor } from "./repositories/system-repository.js";

/*
 * Product admins (D29 decisions 5, 27 and 28): the list, a grant by exact
 * email, a removal by id. Everything crosses organizations, so everything
 * goes through the SystemRepository, which audits each call in its own
 * transaction (decision 20) and answers the database gate's refusal 403.
 *
 * The rules themselves live in the functions (migration 1700000000041):
 * the target a live, verified human (never a service account), the caller
 * re-read under the rows' locks (`forbidden`: a removal committed while the
 * write waited wins), the last admin kept. This service turns their answers
 * into the routes' refusals, in fixed words only: no message names a person
 * or an email (decision 41).
 *
 * Writes count against `productAdminWritesPerUser` after the body's
 * validation and the gate (the routes' preHandlers) and after the path's id
 * is canonical, so a refused request counts nothing (Preflight ruling 10).
 * A non-canonical id names no one: 404 `product_admin_not_found`, before
 * the database, as every D29 route's id (decision 28).
 */

export interface ProductAdminsServiceDependencies {
  system: Pick<ISystemRepository, "listProductAdmins" | "grantProductAdmin" | "revokeProductAdmin">;
  /** The API's clock: the functions' `p_at` (Ruling 259). */
  now: () => Date;
  /** Counts one write for the caller, or throws the 429. */
  countWrite: (userId: string) => void;
}

/** A grant's answer: 201 when it made one, 200 when the person already was one. */
export interface GrantAnswer {
  status: 200 | 201;
  admin: ProductAdmin;
}

export interface IProductAdminsService {
  list(actor: ProductAdminActor): Promise<ProductAdmin[]>;
  grant(actor: ProductAdminActor, email: string): Promise<GrantAnswer>;
  revoke(actor: ProductAdminActor, userId: string): Promise<void>;
}

export function createProductAdminsService(deps: ProductAdminsServiceDependencies): IProductAdminsService {
  return {
    async list(actor) {
      const rows = await deps.system.listProductAdmins(actor);
      return rows.map((row) => ({ id: row.id, email: row.email }));
    },

    async grant(actor, email) {
      deps.countWrite(actor.userId);
      const result = await deps.system.grantProductAdmin(actor, email, deps.now());
      switch (result.outcome) {
        case "granted":
          return { status: 201, admin: { id: result.user.id, email: result.user.email } };
        case "unchanged":
          return { status: 200, admin: { id: result.user.id, email: result.user.email } };
        case "forbidden":
          throw productAdminRequired();
        case "not_found":
          throw productAdminTargetNotFound();
      }
    },

    async revoke(actor, userId) {
      const id = canonicalIdOf(userId);
      if (id === undefined) throw productAdminNotFound();
      deps.countWrite(actor.userId);
      const outcome = await deps.system.revokeProductAdmin(actor, id, deps.now());
      switch (outcome) {
        case "revoked":
          return;
        case "not_found":
          throw productAdminNotFound();
        case "last_admin":
          throw lastProductAdmin();
        case "forbidden":
          throw productAdminRequired();
      }
    },
  };
}
