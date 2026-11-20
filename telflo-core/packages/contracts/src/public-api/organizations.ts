import { z } from "zod";
import { OrganizationRoleSchema, OrganizationTypeSchema } from "../organizations.js";

/*
 * The public surface's request and response shapes for /whoami and /orgs
 * (routes 2–3): strict Zod schemas, camelCase. `/whoami`'s is the service
 * accounts' `WhoAmIResponseSchema` (service-accounts.ts). `/orgs` answers
 * the organizations the token may act in, each `{ id, name, type, role }`
 * (no logo); a list, not paginated.
 */

/** An organization the token may act in, with the token's user's role there. Its name is organization content. */
export const PublicOrganizationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: OrganizationTypeSchema,
    role: OrganizationRoleSchema,
  })
  .strict();

export type PublicOrganization = z.infer<typeof PublicOrganizationSchema>;

/**
 * `GET /orgs`: a service account's one organization; a person's every live
 * membership, personal first, then by name. Not paginated.
 */
export const PublicOrganizationsSchema = z
  .object({ items: z.array(PublicOrganizationSchema), nextCursor: z.null() })
  .strict();

export type PublicOrganizations = z.infer<typeof PublicOrganizationsSchema>;
