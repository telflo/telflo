import { HELM_VALUES_DOWNLOAD_NAME, installBundleFileName, QUICK_DEPLOY_SECRET_PATTERN } from "@telflo/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withOrganizationContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import {
  createInFlightCap,
  createPublicDownloadErrorHandler,
  PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT,
  type PublicDownloadLogFields,
  requesterOf,
  sendDownload,
  type Requester,
} from "../../http/public-download.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { QUICK_DEPLOY_ROUTE } from "../../http/request-log.js";
import { createInstallTemplateLoader } from "../../install/templates.js";
import { createCollectorCatalogueRepository } from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import { createPublishedVersionRepository } from "../configurations/repositories/published-version-repository.js";
import { createFleetsService, type WithFleetsTransaction, type WithOrganizationTransaction } from "../fleets/service.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { QUICK_DEPLOY_LINK_DOWNLOADED, QUICK_DEPLOY_LINK_SUBJECT } from "./actions.js";
import {
  downloadLinkEnded,
  downloadLinkExpired,
  downloadLinkNotFound,
  downloadLinkRevoked,
  downloadLinksDisabled,
  downloadFleetGone,
  downloadUnavailable,
} from "./errors.js";
import {
  createQuickDeployLinkRepository,
  findQuickDeployLinkBySecretHash,
  type QuickDeployLink,
} from "./repositories/quick-deploy-link-repository.js";
import { openValues, SealedValuesError } from "./sealed-values.js";
import { quickDeploySecretHash } from "./secret.js";

/*
 * The public download: GET /api/v1/quick-deploy/{secret}, for whoever holds a
 * link, with no session, no cookie read and no CSRF header (a GET). Its
 * machinery is http/public-download.ts'. Registered after the fleet routes
 * (server.ts), outside their hooks: no `authenticate`.
 *
 * The order, exactly: the per-IP limit (the `onRequest` hook, every request
 * counted, an unknown or malformed secret's included); the secret's shape
 * (404); its sha-256 and the definer's lookup (404); the per-link limit (every
 * attempt on a found link, by its id, 429); the row, in the link's
 * organization's context with no person; revoked (410); expired (410); the
 * organization not live (410); the organization's "Public install links"
 * switch off (403 plain text, read with the link; counted by the limits above,
 * never by the download count, audited nowhere); a render slot (8 per process,
 * 503 with Retry-After: 1); the render, by the link's kind: a Linux link's
 * (the fleets service's `quickDeployBundle`: the fleet, the group, its current
 * version, the variables, the default token, the values opened into the start
 * script, the templates) or a Helm values link's (`quickDeployHelmValues`: the
 * group's current Helm facts, the values, a bearer of the link's default token
 * revealed last with no actor); then, in ONE transaction after the build, the
 * switch read again `for share` (off: 403, nothing counted), the counter (the
 * link still active, else 410) and the `quick_deploy_link.downloaded` audit
 * row with the requester's address and user agent; 200, the download's
 * headers, `telflo-collector-{method}-{arch}.tar.gz`, or a Helm link's
 * `values.yaml` (`text/yaml; charset=utf-8`).
 *
 * A Helm link's reply holds the fleet's default token's bearer (the one
 * public download that does): `no-store`, and never logged (the request
 * log keeps no reply body; a render's refusal logs ids and a field only).
 *
 * The handler hashes the secret at once: only the hash and ids go further.
 * Nothing logs the secret: the request log cuts it from every line
 * (request-log.ts), no error carries it, no audit row names it. Every
 * refusal is plain text, never a label, a name, a path or a value. A HEAD
 * isn't routed (`exposeHeadRoute: false`: one would run the handler,
 * rendering, counting and auditing).
 */

/** Any string: a secret of the wrong shape is the route's own 404, in plain text, never a 400 naming it. */
const SecretParamsSchema = z.object({ secret: z.string() });

/** The public route's work in a link's organization with no person, for the service and the route alike. */
function organizationTransactions(deps: ServerDependencies): WithOrganizationTransaction {
  return (organizationId, work) =>
    withOrganizationContext(deps.db, organizationId, (transaction) =>
      work({
        organization: createActiveOrganizationRepository(transaction, { organizationId }),
        quickDeployLinks: createQuickDeployLinkRepository(transaction, { organizationId }),
        publishedVersions: createPublishedVersionRepository(transaction, { organizationId, userId: null }),
        catalogue: createCollectorCatalogueRepository(transaction),
        audit: createAuditRepository(transaction),
      }),
    );
}

/** The public route acts for no person: a member's transaction is never opened here. */
const NO_PERSON: WithFleetsTransaction = () => {
  throw new Error("the public download acts for no person: it opens no member's transaction");
};

export function registerQuickDeployRoutes(
  server: FastifyInstance,
  deps: ServerDependencies & { now: () => Date },
  rateLimiters: Pick<RateLimiters, "fleetsPerUser" | "quickDeployPerIp" | "quickDeployPerLink">,
): void {
  const { db, now, opampServer, settings } = deps;
  const { keyRing } = settings.quickDeploy;
  const withOrganizationTransaction = organizationTransactions(deps);
  const service = createFleetsService({
    withTransaction: NO_PERSON,
    withOrganizationTransaction,
    opampServer,
    // A member's limit: quickDeployBundle spends none (the public limits are the route's).
    limiter: rateLimiters.fleetsPerUser,
    // A fleet's create's hook: never called on this path.
    opampRegistration: { deleted: () => undefined },
    now,
    log: server.log,
    install: settings.install,
    installTemplates: deps.installTemplates ?? createInstallTemplateLoader(settings.install.templatesDirectory),
    quickDeploy: settings.quickDeploy,
  });
  const renders = createInFlightCap(PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT);
  /** The ids of the link a request found, for its refusal's log line: ids only, never the secret or its hash. */
  const linkIds = new WeakMap<FastifyRequest, PublicDownloadLogFields>();

  /**
   * The link's values, sealed for it, opened into the bundle's
   * COLLECTOR_ENV_EXPORTS; none typed, none. A link that names variables but
   * holds no sealed values is malformed: the route's logged 503, never a
   * bundle without them.
   */
  const valuesOf = (link: QuickDeployLink) => {
    if (link.sealed === null) {
      if (link.choices.envNames.length > 0) throw new SealedValuesError("malformed");
      return [];
    }
    return openValues(keyRing, link.sealed, { organizationId: link.organizationId, linkId: link.id }, link.choices.envNames);
  };

  /**
   * The counter and the audit row, in one transaction after the build. The
   * organization's switch read again, locked `for share` (an admin's
   * change waits, or this waits on it): off, 403; the organization gone
   * meanwhile, 410. The link no longer active (revoked or expired
   * meanwhile): 410. Nothing counted or audited on any of them.
   */
  async function recordDownload(link: QuickDeployLink, requester: Requester, at: Date): Promise<void> {
    let counted: QuickDeployLink | "links_disabled" | "organization_gone" | undefined;
    try {
      counted = await withOrganizationTransaction(link.organizationId, async (transaction) => {
        const organization = await transaction.organization.findSettingsForShare();
        if (organization === undefined) return "organization_gone";
        if (!organization.publicInstallLinks) return "links_disabled";
        const recorded = await transaction.quickDeployLinks.recordDownload(link.id, at);
        if (recorded === undefined) return undefined;
        // No actor; ids, a Linux link's method and arch or a Helm link's kind, the requester: never the secret,
        // its hash, a path, a release, a namespace or a value.
        const { choices } = link;
        await transaction.audit.record({
          action: QUICK_DEPLOY_LINK_DOWNLOADED,
          organizationId: link.organizationId,
          subjectType: QUICK_DEPLOY_LINK_SUBJECT,
          subjectId: link.id,
          metadata: {
            linkId: link.id,
            fleetId: link.fleetId,
            groupId: link.groupId,
            ...(choices.kind === "helm" ? { kind: "helm" } : { method: choices.method, arch: choices.arch }),
          },
          ipAddress: requester.ipAddress,
          userAgent: requester.userAgent,
        });
        return recorded;
      });
    } catch (error) {
      // FAIL CLOSED: a count or `downloaded` row that can't be written rolls
      // back both, and the download is refused, 503: nothing served, nothing
      // counted. (The signed-in bundle serves instead, logging the failed
      // row.) Ids, the error's name and its code (Postgres's SQLSTATE) only.
      server.log.error(
        {
          operation: "quickDeployDownload",
          organizationId: link.organizationId,
          fleetId: link.fleetId,
          linkId: link.id,
          error: errorName(error),
          ...errorCodeOf(error),
        },
        "the quick-deploy download's count or audit row wasn't written: nothing was served",
      );
      throw downloadUnavailable();
    }
    if (counted === "links_disabled") throw downloadLinksDisabled();
    if (counted === "organization_gone") throw downloadFleetGone();
    if (counted === undefined) throw downloadLinkEnded();
  }

  const typed = server.withTypeProvider<ZodTypeProvider>();
  typed.get(
    QUICK_DEPLOY_ROUTE,
    {
      exposeHeadRoute: false,
      onRequest: rateLimiters.quickDeployPerIp,
      errorHandler: createPublicDownloadErrorHandler((request) => linkIds.get(request)),
      schema: { params: SecretParamsSchema },
    },
    async (request, reply) => {
      const { secret } = request.params;
      if (!QUICK_DEPLOY_SECRET_PATTERN.test(secret)) throw downloadLinkNotFound();
      // From here on only the hash and ids.
      const found = await findQuickDeployLinkBySecretHash(db, quickDeploySecretHash(secret));
      if (found === undefined) throw downloadLinkNotFound();
      linkIds.set(request, { organizationId: found.organizationId, linkId: found.id });
      // Every attempt on a found link counts, whatever refuses it next.
      rateLimiters.quickDeployPerLink.count(found.id);
      // The link and its organization's switch, in one transaction.
      const { link, organization } = await withOrganizationTransaction(found.organizationId, async (transaction) => ({
        link: await transaction.quickDeployLinks.findForDownload(found.id),
        organization: await transaction.organization.findSettings(),
      }));
      if (link === undefined) throw downloadLinkNotFound();
      linkIds.set(request, { organizationId: link.organizationId, fleetId: link.fleetId, linkId: link.id });
      if (link.revokedAt !== null) throw downloadLinkRevoked();
      if (link.expiresAt !== null && link.expiresAt.getTime() <= now().getTime()) throw downloadLinkExpired();
      if (!found.organizationIsLive || organization === undefined) throw downloadFleetGone();
      if (!organization.publicInstallLinks) throw downloadLinksDisabled();
      const requester = requesterOf(request);
      const { choices } = link;
      if (choices.kind === "helm") {
        // The values file holds the bearer: built, counted, sent, never kept or logged.
        const values = await renders.run(async () => {
          const built = await service.quickDeployHelmValues(link, valuesOf);
          await recordDownload(link, requester, now());
          return built;
        });
        return sendDownload(reply, {
          // values.yaml: what a browser opening the link saves; the Quick Deploy command's curl names its own file.
          fileName: HELM_VALUES_DOWNLOAD_NAME,
          contentType: "text/yaml; charset=utf-8",
          body: Buffer.from(values, "utf8"),
        });
      }
      const archive = await renders.run(async () => {
        const built = await service.quickDeployBundle(link, valuesOf);
        await recordDownload(link, requester, now());
        return built;
      });
      return sendDownload(reply, { fileName: installBundleFileName(choices.method, choices.arch), body: archive });
    },
  );
}

/** An error's name only: its message could quote anything. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A database error's SQLSTATE (pg's `code`: five digits or capitals), else nothing: never free text. */
function errorCodeOf(error: unknown): { code?: string } {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? { code } : {};
}
