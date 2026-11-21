import type { OrganizationCreation, ProductAdminSettings } from "@telflo/contracts";
import { productAdminRequired } from "./errors.js";
import type { ISystemRepository, ProductAdminActor } from "./repositories/system-repository.js";

/*
 * The site's settings a product admin changes: "Only product admins can
 * create organizations". Read from migration 044's one row (no personal
 * data, so not audited, as the pending count); changed through the
 * SystemRepository, which audits the change, the unchanged value, or the
 * refusal in the same transaction.
 *
 * The write counts against `productAdminWritesPerUser` after the body's
 * validation and the gate (the route's preHandler), as the grant does.
 */

export interface SettingsServiceDependencies {
  system: Pick<ISystemRepository, "setOrganizationCreation">;
  /** The switch's current value (site-settings/organization-creation.ts). */
  readOrganizationCreation: () => Promise<OrganizationCreation>;
  /** Counts one write for the caller, or throws the 429. */
  countWrite: (userId: string) => void;
}

export interface ISettingsService {
  read(): Promise<ProductAdminSettings>;
  change(actor: ProductAdminActor, settings: ProductAdminSettings): Promise<ProductAdminSettings>;
}

export function createSettingsService(deps: SettingsServiceDependencies): ISettingsService {
  return {
    async read() {
      return { organizationCreation: await deps.readOrganizationCreation() };
    },

    async change(actor, { organizationCreation }) {
      deps.countWrite(actor.userId);
      const result = await deps.system.setOrganizationCreation(actor, organizationCreation);
      if (result.outcome === "forbidden") throw productAdminRequired();
      return { organizationCreation };
    },
  };
}
