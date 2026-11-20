import { ErrorResponseSchema, PublicOrganizationsSchema, WhoAmIResponseSchema, type PublicOrganization } from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { withDatabaseContext, withUserContext } from "../../../database/context.js";
import { createPersonalApiTokenRepository } from "../../account/repositories/personal-api-token-repository.js";
import { createOrganizationRepository } from "../../organizations/repositories/organization-repository.js";
import { createApiTokenRepository } from "../../service-accounts/repositories/api-token-repository.js";
import type { PublicApiArea } from "../area.js";
import { requireAcceptedApiToken, requireApiTokenAuthentication } from "../authenticate-api-token.js";
import { invalidApiToken } from "../errors.js";

/*
 * The public surface's own identity routes, registered into the
 * `/api/public/v1` plugin (routes.ts): `/whoami` and `/orgs`. Both answer a
 * personal token too, with or without X-Telflo-Org
 * (`organization: "optional"`): a header that is sent is checked by the
 * plugin first (400 `organization_required`, 403
 * `organization_access_denied`). Their OpenAPI fragment is
 * `openapi/organizations.yaml`.
 */

/** The reply names the token's organization and name: no cache, the browser's or a proxy's, keeps it. */
const NO_STORE = "no-store";

/** A sent X-Telflo-Org's refusals (the plugin's organization check), beside the token's. */
const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  429: ErrorResponseSchema,
};

export const registerOrganizationPublicRoutes: PublicApiArea = (api, { deps }) => {
  const { db } = deps;
  const typed = api.withTypeProvider<ZodTypeProvider>();

  // Who the token is.
  // The name is read through the policies in the token's own context; a token
  // revoked since the check names none, and gets the one 401. Read access; a
  // personal token may call it without X-Telflo-Org. A person's: kind
  // `person`, the organization the header named and the check accepted, or
  // null with no header; its name read in `{ userId, organizationId: null }`
  // (personal_api_tokens' policies read the user alone).
  typed.get(
    "/whoami",
    {
      config: { access: "read", organization: "optional" },
      schema: { response: { 200: WhoAmIResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const accepted = requireAcceptedApiToken(request);
      if (accepted.kind === "person") {
        const organizationId = request.apiTokenAuthentication?.context.organizationId ?? null;
        const tokenName = await withUserContext(db, accepted.userId, (transaction) =>
          createPersonalApiTokenRepository(transaction).findName(accepted.userId, accepted.tokenId),
        );
        if (tokenName === undefined) throw invalidApiToken();
        return reply.header("cache-control", NO_STORE).send({
          organizationId,
          tokenName,
          access: accepted.access,
          kind: "person",
        });
      }
      const { context } = requireApiTokenAuthentication(request);
      const tokenName = await withDatabaseContext(
        db,
        { userId: context.userId, organizationId: context.organizationId },
        (transaction) => createApiTokenRepository(transaction, context).findName(context.tokenId),
      );
      if (tokenName === undefined) throw invalidApiToken();
      return reply.header("cache-control", NO_STORE).send({
        organizationId: context.organizationId,
        tokenName,
        access: context.access,
        kind: "service_account",
      });
    },
  );

  // The organizations the token may act in, each with its
  // user's role there, from the organizations repository's `listForUser`
  // (live memberships of live organizations, personal first, then by name),
  // read in the user's own database context. A service account's token acts
  // in its one organization, so the list is that one, filtered to the
  // token's organization (an account has no other membership; were one
  // added, the token still couldn't act there). A token whose organization
  // or membership went since the check answers an empty list. A person's
  // token answers every live membership. Read access; no X-Telflo-Org
  // needed, one sent is checked first, and the list is the same either way;
  // one page; no logo.
  typed.get(
    "/orgs",
    {
      config: { access: "read", organization: "optional" },
      schema: { response: { 200: PublicOrganizationsSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const accepted = requireAcceptedApiToken(request);
      const memberships = await withUserContext(db, accepted.userId, (transaction) =>
        createOrganizationRepository(transaction).listForUser(accepted.userId),
      );
      const items: PublicOrganization[] = organizationsOf(request, memberships).map(({ id, name, type, role }) => ({
        id,
        name,
        type,
        role,
      }));
      return reply.header("cache-control", NO_STORE).send({ items, nextCursor: null });
    },
  );
};

/**
 * Which of the user's live memberships the token may act in: a person's
 * token, every one; a service account's token, its own organization only.
 */
function organizationsOf<Membership extends { id: string }>(
  request: Parameters<typeof requireAcceptedApiToken>[0],
  memberships: readonly Membership[],
): Membership[] {
  if (requireAcceptedApiToken(request).kind === "person") return [...memberships];
  const { context } = requireApiTokenAuthentication(request);
  return memberships.filter((membership) => membership.id === context.organizationId);
}
