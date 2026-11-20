import { connect } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerErrorHandling } from "../errors.js";
import {
  LIBRARY_LINK_ROUTE,
  loggedClientField,
  loggedRequestUrl,
  PUBLIC_UNMATCHED_URL,
  PUBLISHED_FLOW_ROUTE,
  PUBLISHED_FLOWS_ROUTE,
  QUICK_DEPLOY_ROUTE,
  REDACTED_API_TOKEN_URL,
  REDACTED_FIELD,
  REDACTED_LIBRARY_LINK_URL,
  REDACTED_QUICK_DEPLOY_URL,
  serializeRequest,
  urlMayHoldPublicLinkSecret,
} from "./request-log.js";

describe("loggedRequestUrl", () => {
  it("drops the OIDC callback's query, which holds the code and state", () => {
    expect(loggedRequestUrl("/api/v1/auth/oidc/google/callback?code=c&state=s", "/api/v1/auth/oidc/:provider/callback")).toBe(
      "/api/v1/auth/oidc/google/callback",
    );
  });

  it("drops the OIDC start's query", () => {
    expect(loggedRequestUrl("/api/v1/auth/oidc/google?redirectTo=%2Fapp", "/api/v1/auth/oidc/:provider")).toBe(
      "/api/v1/auth/oidc/google",
    );
  });

  it("drops it when a percent-encoded path reached an OIDC route", () => {
    expect(loggedRequestUrl("/api/v1/auth/%6Fidc/google/callback?code=c", "/api/v1/auth/oidc/:provider/callback")).toBe(
      "/api/v1/auth/%6Fidc/google/callback",
    );
  });

  it.each([
    ["a doubled slash at the start", "//api/v1/auth/oidc/google/callback?code=c&state=s"],
    ["a doubled slash before the OIDC segment", "/api/v1/auth//oidc/google/callback?code=c&state=s"],
    ["a run of slashes after it", "/api/v1/auth/oidc///google/callback?code=c&state=s"],
    ["a doubled slash and a percent-encoded segment", "/api/v1//auth/%6Fidc/google/callback?code=c&state=s"],
    ["an encoded doubled slash", "/api/v1/auth/%2F%2Foidc/google/callback?code=c&state=s"],
  ])("drops the OIDC callback's query with %s, which matches no route", (_label, url) => {
    expect(loggedRequestUrl(url, undefined)).toBe(url.slice(0, url.indexOf("?")));
  });

  it("drops the configurations list's query, whose q is usually a configuration's name", () => {
    const route = "/api/v1/organizations/:organizationId/configurations";
    expect(loggedRequestUrl("/api/v1/organizations/o-1/configurations?q=Payments%20gateway&mine=true", route)).toBe(
      "/api/v1/organizations/o-1/configurations",
    );
    expect(loggedRequestUrl("/api/v1/organizations/o-1/%63onfigurations?q=secret", route)).toBe(
      "/api/v1/organizations/o-1/%63onfigurations",
    );
  });

  it("drops it when the list's path matched no route, as with a trailing slash", () => {
    expect(loggedRequestUrl("/api/v1/organizations/o-1/configurations/?q=secret", undefined)).toBe(
      "/api/v1/organizations/o-1/configurations/",
    );
    expect(loggedRequestUrl("/api/v1/organizations/o-1/configurations?q=secret", undefined)).toBe(
      "/api/v1/organizations/o-1/configurations",
    );
  });

  it.each([
    ["a doubled slash before the organizations", "/api/v1//organizations/o-1/configurations?q=secret"],
    ["a doubled slash before the configurations", "/api/v1/organizations/o-1//configurations?q=secret"],
    ["a run of slashes after them", "/api/v1/organizations/o-1/configurations///?q=secret"],
    ["an encoded doubled slash", "/api/v1/organizations/o-1/%2F%2Fconfigurations?q=secret"],
    ["a percent-encoded segment and a doubled slash", "/api/v1//organizations/o-1/%63onfigurations?q=secret"],
    ["a doubled slash and an encoded slash in the organization", "/api/v1/organizations/o-1%2Fx//configurations?q=secret"],
  ])("drops the list's query with %s, which matches no route", (_label, url) => {
    expect(loggedRequestUrl(url, undefined)).toBe(url.slice(0, url.indexOf("?")));
  });

  it.each([
    ["the collector search", "/api/v1/organizations/o-1/fleets/f-1/collectors#q=CANARY-Q", "/api/v1/organizations/:organizationId/fleets/:fleetId/collectors", "/api/v1/organizations/o-1/fleets/f-1/collectors"],
    ["a fleets path matched by its spelling", "/api/v1/organizations/o-1/fleets#q=CANARY-Q", undefined, "/api/v1/organizations/o-1/fleets"],
    ["the OIDC callback", "/api/v1/auth/oidc/google/callback#code=CANARY-C&state=s", "/api/v1/auth/oidc/:provider/callback", "/api/v1/auth/oidc/google/callback"],
    ["the configurations list", "/api/v1/organizations/o-1/configurations#q=CANARY-Q", "/api/v1/organizations/:organizationId/configurations", "/api/v1/organizations/o-1/configurations"],
    ["a `#` before a `?`", "/api/v1/organizations/o-1/fleets#q=CANARY-Q?x=1", undefined, "/api/v1/organizations/o-1/fleets"],
    ["a `?` before a `#`", "/api/v1/organizations/o-1/fleets?q=CANARY-Q#x", undefined, "/api/v1/organizations/o-1/fleets"],
  ])("drops the query of %s when a raw `#` starts it, as the router reads one", (_label, url, route, logged) => {
    expect(loggedRequestUrl(url, route)).toBe(logged);
  });

  it("keeps a single configuration's URL, and every other organization route's, whole", () => {
    expect(
      loggedRequestUrl(
        "/api/v1/organizations/o-1/configurations/c-1?x=1",
        "/api/v1/organizations/:organizationId/configurations/:configurationId",
      ),
    ).toBe("/api/v1/organizations/o-1/configurations/c-1?x=1");
    expect(
      loggedRequestUrl("/api/v1/organizations/o-1/members?x=1", "/api/v1/organizations/:organizationId/members"),
    ).toBe("/api/v1/organizations/o-1/members?x=1");
  });

  it("keeps every other URL whole", () => {
    expect(loggedRequestUrl("/api/v1/auth/oidc-providers?x=1", "/api/v1/auth/oidc-providers")).toBe(
      "/api/v1/auth/oidc-providers?x=1",
    );
    expect(loggedRequestUrl("/api/v1/auth/me?x=1", undefined)).toBe("/api/v1/auth/me?x=1");
    expect(loggedRequestUrl("//api/v1/auth//oidc-providers?x=1", undefined)).toBe("//api/v1/auth//oidc-providers?x=1");
    expect(loggedRequestUrl("/api/v1/auth/oidc/google/callback", undefined)).toBe("/api/v1/auth/oidc/google/callback");
    expect(loggedRequestUrl("/api/v1/auth/me#x=1", undefined)).toBe("/api/v1/auth/me#x=1");
  });

  describe("under an organization's fleets", () => {
    it.each([
      ["the fleet list", "/api/v1/organizations/o-1/fleets?cursor=abc&status=active", "/api/v1/organizations/:organizationId/fleets"],
      ["one fleet", "/api/v1/organizations/o-1/fleets/f-1?x=1", "/api/v1/organizations/:organizationId/fleets/:fleetId"],
      ["the token list", "/api/v1/organizations/o-1/fleets/f-1/tokens?x=1", "/api/v1/organizations/:organizationId/fleets/:fleetId/tokens"],
      [
        "the collector list",
        "/api/v1/organizations/o-1/fleets/f-1/collectors?q=edge-01&sort=name&cursor=AQIAZWRnZS0wMQ",
        "/api/v1/organizations/:organizationId/fleets/:fleetId/collectors",
      ],
    ])("drops %s's query, by its route", (_label, url, route) => {
      expect(loggedRequestUrl(url, route)).toBe(url.slice(0, url.indexOf("?")));
    });

    it.each([
      ["a trailing slash", "/api/v1/organizations/o-1/fleets/?q=edge-01"],
      ["no route at all", "/api/v1/organizations/o-1/fleets/f-1/collectors/?q=edge-01"],
      ["a percent-encoded segment", "/api/v1/organizations/o-1/%66leets/f-1/collectors/?q=edge-01"],
      ["an encoded slash", "/api/v1/organizations/o-1%2Ffleets?q=edge-01"],
      ["an encoded slash after it", "/api/v1/organizations/o-1/fleets%2Ff-1?q=edge-01"],
      ["a malformed escape elsewhere", "/api/v1/organizations/o-%ZZ/%66leets?q=edge-01"],
      // Runs of slashes, which match no route.
      ["a doubled slash before the organizations", "/api/v1//organizations/o-1/fleets/f-1/collectors?q=edge-01"],
      ["a doubled slash before the fleets", "/api/v1/organizations/o-1//fleets/f-1/collectors?q=edge-01"],
      ["a run of slashes after them", "/api/v1/organizations/o-1/fleets///f-1/collectors?q=edge-01"],
      ["a doubled slash at the start", "//api/v1/organizations/o-1/fleets?q=edge-01"],
      ["an encoded doubled slash", "/api/v1/organizations/o-1/%2F%2Ffleets/f-1/collectors?q=edge-01"],
      ["an encoded slash beside a literal one", "/api/v1/organizations/o-1/%2Ffleets?q=edge-01"],
      ["a doubled slash and a malformed escape elsewhere", "/api/v1//organizations/o-%ZZ//%66leets?q=edge-01"],
      // Decoded, the organization's segment is two: only the spelling as sent, its slashes collapsed, matches.
      ["a doubled slash and an encoded slash in the organization", "/api/v1/organizations/o-1%2Fx//fleets?q=edge-01"],
    ])("drops it with %s, by the path", (_label, url) => {
      expect(loggedRequestUrl(url, undefined)).toBe(url.slice(0, url.indexOf("?")));
    });

    it("keeps a URL that only looks like one whole", () => {
      expect(loggedRequestUrl("/api/v1/organizations/o-1/fleetsx?x=1", undefined)).toBe("/api/v1/organizations/o-1/fleetsx?x=1");
      expect(loggedRequestUrl("/api/v1//organizations/o-1//fleetsx?x=1", undefined)).toBe("/api/v1//organizations/o-1//fleetsx?x=1");
      expect(loggedRequestUrl("/api/v1//organizations/o-1//members?q=fleets", undefined)).toBe("/api/v1//organizations/o-1//members?q=fleets");
      expect(loggedRequestUrl("/api/v1/organizations/o-1/members?q=fleets", "/api/v1/organizations/:organizationId/members")).toBe(
        "/api/v1/organizations/o-1/members?q=fleets",
      );
    });
  });
  describe("under product administration", () => {
    it.each([
      ["the Users search", "/api/v1/product-admin/users?q=person%40example.com&cursor=abc", "/api/v1/product-admin/users"],
      ["a user's delete", "/api/v1/product-admin/users/u-1?q=person%40example.com", "/api/v1/product-admin/users/:userId"],
      ["the product admins' list", "/api/v1/product-admin/product-admins?q=Acme", "/api/v1/product-admin/product-admins"],
      ["the feedback list", "/api/v1/product-admin/feedback?cursor=abc&q=Acme", "/api/v1/product-admin/feedback"],
      ["the pending count", "/api/v1/product-admin/feedback/pending-count?q=Acme", "/api/v1/product-admin/feedback/pending-count"],
      ["an acknowledge", "/api/v1/product-admin/feedback/f-1/acknowledge?q=Acme", "/api/v1/product-admin/feedback/:id/acknowledge"],
    ])("drops %s's query, by its route", (_label, url, route) => {
      expect(loggedRequestUrl(url, route)).toBe(url.slice(0, url.indexOf("?")));
    });

    it.each([
      ["a trailing slash", "/api/v1/product-admin/users/?q=person%40example.com"],
      ["no route at all", "/api/v1/product-admin/nothing?q=person%40example.com"],
      ["the prefix alone", "/api/v1/product-admin?q=person%40example.com"],
      ["a percent-encoded segment", "/api/v1/%70roduct-admin/users?q=person%40example.com"],
      ["an encoded slash", "/api/v1%2Fproduct-admin/users?q=person%40example.com"],
      ["another case", "/API/V1/PRODUCT-ADMIN/users?q=person%40example.com"],
      ["a malformed escape elsewhere", "/api/v1/product-admin/u%ZZ?q=person%40example.com"],
      ["a doubled slash before it", "/api/v1//product-admin/users?q=person%40example.com"],
      ["a run of slashes after it", "/api/v1/product-admin///users?q=person%40example.com"],
      ["a doubled slash at the start", "//api/v1/product-admin/users?q=person%40example.com"],
      ["an encoded doubled slash", "/api/v1/%2F%2Fproduct-admin/users?q=person%40example.com"],
      ["a raw `#` before the query", "/api/v1/product-admin/users#q=person%40example.com"],
    ])("drops it with %s, by the path", (_label, url) => {
      const queryStart = Math.min(...["?", "#"].map((mark) => url.indexOf(mark)).filter((index) => index !== -1));
      expect(loggedRequestUrl(url, undefined)).toBe(url.slice(0, queryStart));
      // Nothing of the term survives (a boolean: the test prints no term).
      expect(loggedRequestUrl(url, undefined).includes("example.com")).toBe(false);
    });

    it("keeps a URL that only looks like one whole", () => {
      expect(loggedRequestUrl("/api/v1/product-adminx?x=1", undefined)).toBe("/api/v1/product-adminx?x=1");
      expect(loggedRequestUrl("/api/v1/feedback?x=1", "/api/v1/feedback")).toBe("/api/v1/feedback?x=1");
      expect(loggedRequestUrl("/api/v1/x/product-admin?x=1", undefined)).toBe("/api/v1/x/product-admin?x=1");
      expect(loggedRequestUrl("/api/v1/organizations/o-1/members?q=product-admin", "/api/v1/organizations/:organizationId/members")).toBe(
        "/api/v1/organizations/o-1/members?q=product-admin",
      );
    });
  });
});

/*
 * Under the public prefix, in any spelling http/public-path.ts reads, the
 * log holds the matched route's pattern or PUBLIC_UNMATCHED_URL: never the
 * path as sent (a pipeline's name) or the query. Booleans for the marker,
 * so a failure prints none.
 */
describe("loggedRequestUrl: the public surface, by allowlist", () => {
  const MARKER = "marker-pipeline-name";
  const VERSION = "/api/public/v1/configurations/c-1/versions/2";
  const PIPELINE_ROUTE = "/api/public/v1/configurations/:configurationId/versions/:versionNumber/validation-pipelines/*";

  it.each([
    ["a plugin route with a query", `/api/public/v1/configurations?q=${MARKER}&cursor=abc`, "/api/public/v1/configurations"],
    ["the pipeline route with a name", `${VERSION}/validation-pipelines/traces/${MARKER}?x=${MARKER}`, PIPELINE_ROUTE],
    ["the pipeline route with an encoded slash", `${VERSION}/validation-pipelines/traces%2F${MARKER}`, PIPELINE_ROUTE],
    ["the pipeline route's list", `${VERSION}/validation-pipelines?q=${MARKER}`, "/api/public/v1/configurations/:configurationId/versions/:versionNumber/validation-pipelines"],
    ["an open route", `/api/public/v1/health?x=${MARKER}`, "/api/public/v1/health"],
    ["the prefix itself", `/api/public/v1?x=${MARKER}`, "/api/public/v1"],
  ])("logs %s as its route's pattern", (_label, url, route) => {
    const logged = loggedRequestUrl(url, route);
    expect(logged.includes(MARKER)).toBe(false);
    expect(logged).toBe(route);
  });

  it.each([
    ["an unknown path", `/api/public/v1/nope?q=${MARKER}`],
    ["a trailing slash", `/api/public/v1/whoami/?q=${MARKER}`],
    ["the prefix with its slash", `/api/public/v1/?q=${MARKER}`],
    ["upper case", `/API/Public/V1/whoami?q=${MARKER}`],
    ["an encoded segment", `/api/%70ublic/v1/whoami?q=${MARKER}`],
    ["an encoded slash", `/api/public%2Fv1/whoami?q=${MARKER}`],
    ["a doubled slash", `/api//public/v1/whoami?q=${MARKER}`],
    ["a raw #", `/api/public/v1/whoami#q=${MARKER}`],
    ["a dot segment", `/api/./public/v1/whoami?q=${MARKER}`],
    ["a parent segment", `/api/x/../public/v1/whoami?q=${MARKER}`],
    ["a leading dot segment", `/./api/public/v1/nope?q=${MARKER}`],
    ["an encoded dot segment", `/api/%2E/public/v1/whoami?q=${MARKER}`],
    ["the pipeline route's name in mixed case", `/API/Public/V1/configurations/c-1/versions/2/Validation-Pipelines/${MARKER}`],
    ["the pipeline route's name after an encoded letter", `${VERSION}/validation%2Dpipelines/${MARKER}`],
    ["the pipeline route's name after a ;-parameter", `${VERSION}/validation-pipelines;x/traces/${MARKER}`],
    ["the pipeline route's name after an encoded slash", `${VERSION}%2Fvalidation-pipelines/${MARKER}`],
    // Three more: a character that grows in lower case, an absolute-form target, a double encoding.
    ["after characters that grow in lower case", `${VERSION}/${"%C4%B0".repeat(25)}validation%2Dpipelines/${MARKER}`],
    ["an absolute-form target", `http://x/api/public/v1/nope?name=${MARKER}`],
    ["an absolute-form target in upper case", `http://x/API/public/v1/nope?name=${MARKER}`],
    ["an absolute-form target to the pipeline route", `http://x${VERSION}/validation-pipelines;x/${MARKER}`],
    ["a double encoding", `${VERSION}/validation%252Dpipelines/${MARKER}`],
    ["a doubly encoded prefix", `/api/%2570ublic/v1/${MARKER}`],
  ])("logs %s, matched by no route, as the fixed unmatched URL", (_label, url) => {
    const logged = loggedRequestUrl(url, undefined);
    expect(logged.includes(MARKER)).toBe(false);
    expect(logged).toBe(PUBLIC_UNMATCHED_URL);
  });

  it("keeps every URL outside the prefix as before", () => {
    expect(loggedRequestUrl("/api/public/v10/x?q=1", undefined)).toBe("/api/public/v10/x?q=1");
    expect(loggedRequestUrl("/api/public/v1x?q=1", undefined)).toBe("/api/public/v1x?q=1");
    expect(loggedRequestUrl("/api/public/../v1/whoami?q=1", undefined)).toBe("/api/public/../v1/whoami?q=1");
    expect(loggedRequestUrl("/api/v1/auth/me?q=/api/public/v1/", "/api/v1/auth/me")).toBe("/api/v1/auth/me?q=/api/public/v1/");
    const browser = "/api/v1/organizations/o-1/configurations/c-1/versions/v-1/validation-pipelines/p-1";
    expect(loggedRequestUrl(browser, undefined)).toBe(browser);
  });
});

/*
 * The open flow read's request line holds its route's pattern only, never the
 * slug as sent nor a query, matched or not.
 */
describe("loggedRequestUrl: the open flow read, by its routes' patterns", () => {
  const MARKER = "marker-flow-slug";

  it.each([
    ["the list", "/api/v1/published-flows", PUBLISHED_FLOWS_ROUTE, PUBLISHED_FLOWS_ROUTE],
    ["the list with a query", `/api/v1/published-flows?q=${MARKER}`, PUBLISHED_FLOWS_ROUTE, PUBLISHED_FLOWS_ROUTE],
    ["a slug", `/api/v1/published-flows/${MARKER}`, PUBLISHED_FLOW_ROUTE, PUBLISHED_FLOW_ROUTE],
    ["a slug with a query", `/api/v1/published-flows/${MARKER}?x=${MARKER}`, PUBLISHED_FLOW_ROUTE, PUBLISHED_FLOW_ROUTE],
    ["a slug with an encoded character", `/api/v1/published-flows/${MARKER}%20x`, PUBLISHED_FLOW_ROUTE, PUBLISHED_FLOW_ROUTE],
    ["a slug after a raw #", `/api/v1/published-flows/x#${MARKER}`, PUBLISHED_FLOW_ROUTE, PUBLISHED_FLOW_ROUTE],
  ])("logs %s, matched, as its route's pattern", (_label, url, route, logged) => {
    expect(loggedRequestUrl(url, route).includes(MARKER)).toBe(false);
    expect(loggedRequestUrl(url, route)).toBe(logged);
  });

  it.each([
    ["the list with a trailing slash", `/api/v1/published-flows/?q=${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a second segment", `/api/v1/published-flows/${MARKER}/more`, PUBLISHED_FLOW_ROUTE],
    ["a slug with a trailing slash", `/api/v1/published-flows/${MARKER}/`, PUBLISHED_FLOW_ROUTE],
    ["an encoded slash", `/api/v1/published-flows%2F${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["upper case", `/API/V1/PUBLISHED-FLOWS/${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["the list in upper case", `/API/V1/Published-Flows?q=${MARKER}`, PUBLISHED_FLOWS_ROUTE],
    ["an encoded letter", `/api/v1/%70ublished-flows/${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a doubled slash", `/api/v1//published-flows/${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a doubled slash at the start", `//api/v1/published-flows?q=${MARKER}`, PUBLISHED_FLOWS_ROUTE],
    ["a dot segment", `/api/v1/./published-flows/${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a parent segment", `/api/v1/x/../published-flows/${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a malformed escape", `/api/v1/published-flows/${MARKER}%`, PUBLISHED_FLOW_ROUTE],
    ["another method's list (no route)", `/api/v1/published-flows?q=${MARKER}`, PUBLISHED_FLOWS_ROUTE],
    // A target that starts under the prefix, whatever its dot segments resolve to.
    ["a `..` resolving outside the prefix", `/api/v1/published-flows/${MARKER}/../../x?q=${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a `..` right after the prefix", `/api/v1/published-flows/../${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a `..` resolving outside, in upper case", `/API/V1/PUBLISHED-FLOWS/../../${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["an encoded `..` resolving outside", `/api/v1/published-flows%2F..%2F..%2F${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a `..` after a doubled slash", `/api/v1//published-flows/../../${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["an absolute-form target with a `..`", `http://x/api/v1/published-flows/../../${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a `;`-parameter", `/api/v1/published-flows;${MARKER}`, PUBLISHED_FLOW_ROUTE],
    ["a `;`-parameter and a `..`", `/api/v1/published-flows;${MARKER}/../../x`, PUBLISHED_FLOW_ROUTE],
  ])("logs %s, matched by no route, as the pattern it falls under", (_label, url, logged) => {
    expect(loggedRequestUrl(url, undefined).includes(MARKER)).toBe(false);
    expect(loggedRequestUrl(url, undefined)).toBe(logged);
  });

  it("keeps every other URL as before: the showcase, the signed-in flows, a lookalike, another route's", () => {
    expect(loggedRequestUrl("/api/v1/flow-showcase?x=1", "/api/v1/flow-showcase")).toBe("/api/v1/flow-showcase?x=1");
    expect(loggedRequestUrl("/api/v1/flows/x?y=1", "/api/v1/flows/:slug")).toBe("/api/v1/flows/x?y=1");
    expect(loggedRequestUrl("/api/v1/published-flowsx?x=1", undefined)).toBe("/api/v1/published-flowsx?x=1");
    expect(loggedRequestUrl("/api/v1/published-flowsx/../y?x=1", undefined)).toBe("/api/v1/published-flowsx/../y?x=1");
    expect(loggedRequestUrl("/api/v2/published-flows/x", undefined)).toBe("/api/v2/published-flows/x");
    expect(loggedRequestUrl("/api/v1/auth/me?q=/api/v1/published-flows/", "/api/v1/auth/me")).toBe(
      "/api/v1/auth/me?q=/api/v1/published-flows/",
    );
  });

  it("a slug holding tf_ is the token's redaction, holding neither", () => {
    const logged = loggedRequestUrl(`/api/v1/published-flows/tf_${MARKER}`, PUBLISHED_FLOW_ROUTE);
    expect(logged).toBe(REDACTED_API_TOKEN_URL);
  });
});

/*
 * The invariant, as a class: for a request no route matched, a path that
 * starts under `/api/v1/published-flows` (the end, `/` or `;` next) as sent
 * or after any round of decoding (up to public-path.ts's three), runs of
 * slashes made one, case aside, is logged by a pattern: every spelling of the
 * prefix crossed with every tail. Booleans for the marker, so a failure
 * prints none.
 */
describe("loggedRequestUrl: the open flow read's invariant, every spelling of the prefix with every tail", () => {
  const MARKER = "marker-flow-slug";
  const LETTERS = "published";
  /** `%XX` for a character, `%25XX` for it encoded twice, `%2525XX` three times. */
  const once = (character: string) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  const twice = (character: string) => `%25${once(character).slice(1)}`;
  const thrice = (character: string) => `%2525${once(character).slice(1)}`;

  const PREFIXES: readonly (readonly [string, string])[] = [
    ["plain", "/api/v1/published-flows"],
    ["upper case", "/API/V1/PUBLISHED-FLOWS"],
    ...[...LETTERS].flatMap((letter, index) => {
      const at = (encoded: string) => `/api/v1/${LETTERS.slice(0, index)}${encoded}${LETTERS.slice(index + 1)}-flows`;
      return [
        [`its ${letter} (${index + 1}) encoded once`, at(once(letter))],
        [`its ${letter} (${index + 1}) encoded twice`, at(twice(letter))],
      ] as const;
    }),
    ["its slashes encoded once", "/api%2Fv1%2Fpublished-flows"],
    ["its slashes encoded twice", "/api%252Fv1%252Fpublished-flows"],
    ["its slashes doubled", "//api//v1//published-flows"],
    ["its slashes doubled and encoded twice", "/api%252F%252Fv1/published-flows"],
    // The third round, pinned: DECODING_ROUNDS at 2 fails these.
    ["its p encoded three times", `/api/v1/${thrice("p")}ublished-flows`],
  ];
  const TAILS = [
    `/${MARKER}`,
    `/${MARKER}/../../x?q=${MARKER}`,
    `/../${MARKER}`,
    `;${MARKER}`,
    `%2F${MARKER}`,
    `%252F${MARKER}%252F..%252F..%252Fx`,
    // A decoded `?` or `#` is the path's, a boundary.
    `%3F${MARKER}`,
    `%23${MARKER}`,
    `%3F${MARKER}/../../x`,
    // The third round, pinned.
    `%25252F${MARKER}%25252F..%25252F..%25252Fx`,
  ];
  const TABLE = PREFIXES.flatMap(([label, prefix]) => TAILS.map((tail) => [label, tail, `${prefix}${tail}`] as const));

  it("crosses every prefix with every tail", () => {
    expect(TABLE.length).toBe(PREFIXES.length * TAILS.length);
    expect(PREFIXES.length).toBe(2 + 2 * LETTERS.length + 4 + 1);
    expect(TAILS.length).toBe(10);
  });

  it.each(TABLE)("logs the prefix %s with the tail %s by a pattern, never the target", (_label, _tail, url) => {
    const logged = loggedRequestUrl(url, undefined);
    expect(logged.includes(MARKER)).toBe(false);
    expect([PUBLISHED_FLOWS_ROUTE, PUBLISHED_FLOW_ROUTE].includes(logged)).toBe(true);
  });

  it.each([
    "/api/v1/published-flowsx",
    "/api/v1/published-flowsx/x",
    "/api/v1/published-flowsx%2F..%2Fy",
    "/api/v1/published-flowsx%252F..%252Fy",
    "/api/v1/published-flows%78/y",
    "/api/v1/published-flows%2578/y",
    "/api/v1/published-flows-old/y",
  ])("keeps the lookalike %s as sent", (url) => {
    expect(loggedRequestUrl(url, undefined)).toBe(url);
  });
});

describe("a real Fastify's log lines and the 404's reply for the open flow read", () => {
  const MARKER = "marker-flow-slug";
  const lines: string[] = [];
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify({
      logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
    });
    registerErrorHandling(server);
    server.get(PUBLISHED_FLOWS_ROUTE, async () => ({ flows: [] }));
    server.get(PUBLISHED_FLOW_ROUTE, async () => ({ flow: null }));
    server.get("/x", async () => ({ ok: true }));
    await server.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  const loggedUrls = () =>
    lines.flatMap((line) => {
      const { req } = JSON.parse(line) as { req?: { url?: string } };
      return req?.url === undefined ? [] : [req.url];
    });

  it.each([
    ["the list with a query", `/api/v1/published-flows?q=${MARKER}`, 200, PUBLISHED_FLOWS_ROUTE],
    ["a slug with a query", `/api/v1/published-flows/${MARKER}?x=${MARKER}`, 200, PUBLISHED_FLOW_ROUTE],
    ["a second segment", `/api/v1/published-flows/${MARKER}/more?x=1`, 404, PUBLISHED_FLOW_ROUTE],
    ["upper case", `/API/v1/published-flows/${MARKER}`, 404, PUBLISHED_FLOW_ROUTE],
  ])("logs and answers %s by the pattern only", async (_label, url, status, logged) => {
    const response = await server.inject({ method: "GET", url });
    expect(response.statusCode).toBe(status);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n").includes(MARKER)).toBe(false);
    expect(response.body.includes(MARKER)).toBe(false);
    expect(new Set(loggedUrls())).toEqual(new Set([logged]));
  });

  /** Sends `target` as the request line over a raw socket, exactly as written, and resolves with the reply. */
  const sendRaw = (target: string) =>
    new Promise<string>((resolve, reject) => {
      const address = server.server.address();
      if (address === null || typeof address === "string") throw new Error("a TCP address expected");
      const socket = connect(address.port, "127.0.0.1", () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let reply = "";
      socket.on("data", (chunk: Buffer) => (reply += chunk.toString("latin1")));
      socket.on("end", () => resolve(reply));
      socket.on("error", reject);
    });

  // Literal dot segments and `;`, which `inject` might resolve before Fastify sees them.
  it.each([
    `/api/v1/published-flows/${MARKER}/../../x?q=${MARKER}`,
    `/api/v1/published-flows/../${MARKER}`,
    `/api/v1/published-flows;${MARKER}`,
    // Encoded twice, then escaping.
    `/api/v1/published-flows%252F${MARKER}%252F..%252F..%252Fx`,
    `/api/v1/%2570ublished-flows/${MARKER}/../../x`,
    // A decoded `?` after the prefix.
    `/api/v1/published-flows%3F${MARKER}/../../x`,
  ])("logs and answers %s, sent over a raw socket, by the slug's pattern only", async (target) => {
    const reply = await sendRaw(target);
    expect(reply).toMatch(/^HTTP\/1\.1 404 /);
    expect(reply.includes(MARKER)).toBe(false);
    expect(lines.join("\n").includes(MARKER)).toBe(false);
    expect(new Set(loggedUrls())).toEqual(new Set([PUBLISHED_FLOW_ROUTE]));
  });
});

/*
 * The public download's path ends in a quick-deploy link's secret, a
 * credential. Whatever the spelling, the request's log lines (and the 404's
 * reply) hold a fixed redaction, never the secret.
 */
const SECRET = "tqd_CANARYCANARYCANARYCANARYCANARYCANARYCANARY0";
const SECRET_BODY = SECRET.slice("tqd_".length);

/** [label, url, the route it matches in the API (undefined: none)]. */
const SECRET_SPELLINGS: readonly (readonly [string, string, string | undefined])[] = [
  ["as the route matches it", `/api/v1/quick-deploy/${SECRET}`, QUICK_DEPLOY_ROUTE],
  ["as spelt with no route at hand (the check before the no-query return)", `/api/v1/quick-deploy/${SECRET}`, undefined],
  ["with a query", `/api/v1/quick-deploy/${SECRET}?x=1`, QUICK_DEPLOY_ROUTE],
  ["with a raw #", `/api/v1/quick-deploy/${SECRET}#frag`, QUICK_DEPLOY_ROUTE],
  ["with a trailing slash", `/api/v1/quick-deploy/${SECRET}/`, undefined],
  ["with a doubled slash at the start", `//api/v1/quick-deploy/${SECRET}`, undefined],
  ["with a doubled slash inside", `/api/v1//quick-deploy/${SECRET}`, undefined],
  ["with an encoded slash", `/api/v1/quick-deploy%2F${SECRET}`, undefined],
  ["in upper case", `/API/V1/QUICK-DEPLOY/${SECRET}`, undefined],
  ["with a dot segment before it", `/api/v1/x/../quick-deploy/${SECRET}`, undefined],
  ["with a dot segment after it", `/api/v1/quick-deploy/${SECRET}/../x`, undefined],
  ["with its prefix encoded", `/api/v1/quick-deploy/tqd%5F${SECRET_BODY}`, QUICK_DEPLOY_ROUTE],
  ["with encoded letters", `/api/v1/%71uick-deploy/%74qd_${SECRET_BODY}`, undefined],
  ["beside a malformed escape", `/api/v1/quick-deploy/${SECRET}%`, undefined],
  ["after a semicolon", `/api/v1/quick-deploy/${SECRET};jsessionid=1`, undefined],
  ["without the /api/v1 prefix", `/quick-deploy/${SECRET}`, undefined],
  ["in another route's query", `/api/v1/organizations/o-1/fleets?s=${SECRET}`, "/api/v1/organizations/:organizationId/fleets"],
  ["in an ordinary route's query", `/api/v1/auth/me?s=${SECRET}`, "/api/v1/auth/me"],
  ["after an ordinary route's raw #", `/api/v1/auth/me#${SECRET}`, "/api/v1/auth/me"],
  ["in a path that only names the secret", `/api/v1/x/${SECRET}`, undefined],
];

describe("loggedRequestUrl: a quick-deploy link's secret", () => {
  it.each(SECRET_SPELLINGS)("logs a URL %s as the fixed redaction", (_label, url, route) => {
    const logged = loggedRequestUrl(url, route);
    expect(logged).toBe(REDACTED_QUICK_DEPLOY_URL);
    expect(logged).not.toContain(SECRET_BODY);
  });

  it("redacts by the matched route alone, whatever the URL's spelling", () => {
    expect(loggedRequestUrl("/api/v1/quick-deploy/%74%71%64%5Fx", QUICK_DEPLOY_ROUTE)).toBe(REDACTED_QUICK_DEPLOY_URL);
  });

  it("keeps the links' own routes, which hold ids only, as before", () => {
    expect(
      loggedRequestUrl(
        "/api/v1/organizations/o-1/fleets/f-1/quick-deploy-links/l-1/extend",
        "/api/v1/organizations/:organizationId/fleets/:fleetId/quick-deploy-links/:linkId/extend",
      ),
    ).toBe("/api/v1/organizations/o-1/fleets/f-1/quick-deploy-links/l-1/extend");
    expect(loggedRequestUrl("/api/v1/organizations/o-1/fleets/f-1/quick-deploy-links?limit=5", undefined)).toBe(
      "/api/v1/organizations/o-1/fleets/f-1/quick-deploy-links",
    );
    expect(loggedRequestUrl("/api/v1/organizations/o-1/fleets/f-1/groups/g-1/quick-deploy-links", undefined)).toBe(
      "/api/v1/organizations/o-1/fleets/f-1/groups/g-1/quick-deploy-links",
    );
  });

  it("keeps an ordinary URL that only looks like one whole", () => {
    expect(loggedRequestUrl("/api/v1/quick-deployx/a?x=1", undefined)).toBe("/api/v1/quick-deployx/a?x=1");
    expect(loggedRequestUrl("/api/v1/auth/me?q=tqd", undefined)).toBe("/api/v1/auth/me?q=tqd");
  });
});

/**
 * The same through a real Fastify, with the API's serializer and error
 * handling and a stand-in for the download's route: neither the request's
 * log lines nor the 404's reply hold the secret, whichever way the request
 * spells it, by `inject` and over a raw socket (whose request line Fastify
 * reads as sent: no client resolves its dot segments first).
 */
describe("a real Fastify's log lines and the 404's reply", () => {
  const lines: string[] = [];
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify({
      logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
    });
    registerErrorHandling(server);
    server.get(QUICK_DEPLOY_ROUTE, async (_request, reply) => reply.type("text/plain").send("stand-in"));
    server.get("/register", async () => "ok");
    await server.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  const loggedUrls = () =>
    lines.flatMap((line) => {
      const { req } = JSON.parse(line) as { req?: { url?: string } };
      return req?.url === undefined ? [] : [req.url];
    });

  // `inject` drops a fragment before Fastify sees it (the raw socket's
  // cases below keep it), and a malformed escape has its own case.
  const injected = SECRET_SPELLINGS.filter(([, url]) => !url.includes("#") && !url.endsWith("%"));

  it.each(injected)("logs and answers a request %s without the secret", async (_label, url) => {
    const response = await server.inject({ method: "GET", url });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(SECRET_BODY);
    expect(loggedUrls()).toEqual([REDACTED_QUICK_DEPLOY_URL]);
    expect(response.body).not.toContain(SECRET_BODY);
  });

  it("logs nothing of a request whose path holds a malformed escape: Fastify answers it 400 before any hook or log line", async () => {
    // Fastify's own bad-URL reply (fastify.js onBadUrl, with no
    // `frameworkErrors`) quotes the path back to the caller, who sent it;
    // no log line is written.
    const response = await server.inject({ method: "GET", url: `/api/v1/quick-deploy/${SECRET}%` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "FST_ERR_BAD_URL" });
    expect(lines).toEqual([]);
  });

  /** Sends `target` as the request line over a raw socket, and resolves with the reply. */
  const sendRaw = (target: string) =>
    new Promise<string>((resolve, reject) => {
      const address = server.server.address();
      if (address === null || typeof address === "string") throw new Error("a TCP address expected");
      const socket = connect(address.port, "127.0.0.1", () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let reply = "";
      socket.on("data", (chunk: Buffer) => (reply += chunk.toString("latin1")));
      socket.on("end", () => resolve(reply));
      socket.on("error", reject);
    });

  it.each([
    `/api/v1/x/../quick-deploy/${SECRET}`,
    `/api/v1/./quick-deploy/${SECRET}`,
    `/api/v1/quick-deploy/${SECRET}#frag`,
    `/api/v1/auth/me#${SECRET}`,
    `/api/v1/quick-deploy/${SECRET}/../x`,
    `/api/v1/Quick-Deploy/${SECRET}`,
  ])("logs and answers %s, sent over a raw socket, without the secret", async (target) => {
    const reply = await sendRaw(target);
    expect(reply).toMatch(/^HTTP\/1\.1 (200|404) /);
    expect(reply).not.toContain(SECRET_BODY);
    expect(lines.join("\n")).not.toContain(SECRET_BODY);
    expect(loggedUrls()).toEqual([REDACTED_QUICK_DEPLOY_URL]);
  });

  it("logs an ordinary request's URL as before, query and all", async () => {
    await server.inject({ method: "GET", url: "/register?x=1" });
    expect(loggedUrls()).toEqual(["/register?x=1"]);
    const missing = await server.inject({ method: "GET", url: "/nowhere?x=1" });
    expect(missing.json()).toEqual({ error: { code: "not_found", message: "No route for GET /nowhere?x=1" } });
  });
});

/*
 * An API token never belongs in a URL, but one pasted there is cut from the
 * request's log lines and the 404's reply: a URL any spelling of which (as
 * sent, percent-decoded once, runs of slashes made one) holds `tf_`, case
 * aside, is logged as REDACTED_API_TOKEN_URL, its query and all. The canary is
 * built here, at run time, and every assertion compares booleans, so a failure
 * prints none of it.
 */
const API_TOKEN_BODY = `${"CANARYTF".repeat(5)}CAN`;
const API_TOKEN = `tf_${API_TOKEN_BODY}`;

/** [label, url, the route it matches in the API (undefined: none)]. */
const API_TOKEN_SPELLINGS: readonly (readonly [string, string, string | undefined])[] = [
  ["in the public surface's path", `/api/public/v1/whoami/${API_TOKEN}`, undefined],
  ["in /whoami's query", `/api/public/v1/whoami?token=${API_TOKEN}`, "/api/public/v1/whoami"],
  ["in an ordinary route's query", `/api/v1/auth/me?t=${API_TOKEN}`, "/api/v1/auth/me"],
  ["in upper case", `/API/PUBLIC/V1/TF_${API_TOKEN_BODY}`, undefined],
  ["in mixed case", `/api/v1/auth/me?t=Tf_${API_TOKEN_BODY}`, "/api/v1/auth/me"],
  ["with its t encoded", `/api/v1/auth/me?t=%74f_${API_TOKEN_BODY}`, "/api/v1/auth/me"],
  ["with its f encoded", `/api/v1/auth/me?t=t%66_${API_TOKEN_BODY}`, "/api/v1/auth/me"],
  ["with its _ encoded", `/api/v1/auth/me?t=tf%5F${API_TOKEN_BODY}`, "/api/v1/auth/me"],
  ["with every letter encoded, upper-case codes", `/register?t=%54%46%5F${API_TOKEN_BODY}`, undefined],
  ["with every letter encoded, lower-case codes", `/register?t=%74%66%5f${API_TOKEN_BODY}`, undefined],
  ["after a raw #", `/api/v1/auth/me#${API_TOKEN}`, "/api/v1/auth/me"],
  ["beside a malformed escape", `/api/v1/x/${API_TOKEN}%`, undefined],
  ["under an organization's fleets", `/api/v1/organizations/o-1/fleets/${API_TOKEN}`, undefined],
  ["in the configurations list's query", `/api/v1/organizations/o-1/configurations?q=${API_TOKEN}`, "/api/v1/organizations/:organizationId/configurations"],
  ["in the OIDC callback's path", `/api/v1/auth/oidc/${API_TOKEN}/callback`, undefined],
  ["with doubled slashes", `//api/public//v1/${API_TOKEN}`, undefined],
  ["after an encoded slash", `/api/public/v1%2F${API_TOKEN}`, undefined],
];

describe("loggedRequestUrl: an API token", () => {
  it.each(API_TOKEN_SPELLINGS)("logs a URL holding tf_ %s as the fixed redaction, query and all", (_label, url, route) => {
    const logged = loggedRequestUrl(url, route);
    expect(logged === REDACTED_API_TOKEN_URL).toBe(true);
    expect(logged.includes(API_TOKEN_BODY)).toBe(false);
  });

  it("keeps an ordinary URL that only looks like one whole: tf without the underscore, tf- and t_f", () => {
    expect(loggedRequestUrl("/api/v1/auth/me?q=tf", undefined)).toBe("/api/v1/auth/me?q=tf");
    expect(loggedRequestUrl("/api/v1/auth/me?q=tf-x&r=t_f", undefined)).toBe("/api/v1/auth/me?q=tf-x&r=t_f");
    expect(loggedRequestUrl("/api/public/v1/whoami", "/api/public/v1/whoami")).toBe("/api/public/v1/whoami");
  });

  it("a false positive, an opaque cursor holding tf_, only loses its URL", () => {
    expect(loggedRequestUrl("/api/v1/organizations/o-1/configurations/c-1/versions?cursor=AbTf_9x", undefined)).toBe(
      REDACTED_API_TOKEN_URL,
    );
  });

  it("a URL holding a quick-deploy secret and tf_ is the quick-deploy redaction, holding neither", () => {
    const logged = loggedRequestUrl(`/api/v1/quick-deploy/${SECRET}?t=${API_TOKEN}`, QUICK_DEPLOY_ROUTE);
    // A boolean: were both rules to fail, toBe's diff would print the built canary.
    expect(logged === REDACTED_QUICK_DEPLOY_URL).toBe(true);
  });
});

/**
 * The same through a real Fastify, with the API's serializer and error
 * handling and a stand-in for /whoami: neither the request's log lines nor
 * the 404's reply hold the token, by `inject` and over a raw socket.
 */
describe("a real Fastify's log lines and the 404's reply hold no API token", () => {
  const lines: string[] = [];
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify({
      logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
    });
    registerErrorHandling(server);
    server.get("/api/public/v1/whoami", async () => ({ ok: true }));
    server.get("/api/v1/auth/me", async () => ({ ok: true }));
    await server.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  const loggedUrls = () =>
    lines.flatMap((line) => {
      const { req } = JSON.parse(line) as { req?: { url?: string } };
      return req?.url === undefined ? [] : [req.url];
    });

  // `inject` drops a fragment, and a malformed escape is Fastify's own 400 before any log line.
  const injected = API_TOKEN_SPELLINGS.filter(([, url]) => !url.includes("#") && !url.endsWith("%"));

  it.each(injected)("logs and answers a request holding tf_ %s without the token", async (_label, url) => {
    const response = await server.inject({ method: "GET", url });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n").includes(API_TOKEN_BODY)).toBe(false);
    expect(loggedUrls().every((logged) => logged === REDACTED_API_TOKEN_URL)).toBe(true);
    expect(response.body.includes(API_TOKEN_BODY)).toBe(false);
  });

  it("the 404's reply for a path holding tf_ echoes the redaction; for /api/public/v1/nope, the fixed unmatched URL", async () => {
    const holding = await server.inject({ method: "GET", url: `/api/public/v1/${API_TOKEN}` });
    expect(holding.statusCode).toBe(404);
    expect(holding.body === JSON.stringify({ error: { code: "not_found", message: "No route for GET /[redacted]" } })).toBe(true);
    const nope = await server.inject({ method: "GET", url: "/api/public/v1/nope?x=1" });
    expect(nope.json()).toEqual({ error: { code: "not_found", message: "No route for GET /api/public/v1/[unmatched]" } });
  });

  /** Sends `target` as the request line over a raw socket, and resolves with the reply. */
  const sendRaw = (target: string) =>
    new Promise<string>((resolve, reject) => {
      const address = server.server.address();
      if (address === null || typeof address === "string") throw new Error("a TCP address expected");
      const socket = connect(address.port, "127.0.0.1", () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let reply = "";
      socket.on("data", (chunk: Buffer) => (reply += chunk.toString("latin1")));
      socket.on("end", () => resolve(reply));
      socket.on("error", reject);
    });

  it.each([
    ["after a raw #", `/api/v1/auth/me#${API_TOKEN}`],
    ["after a dot segment", `/api/public/v1/x/../${API_TOKEN}`],
    ["in mixed case", `/Api/Public/V1/Tf_${API_TOKEN_BODY}`],
  ])("logs and answers a request holding tf_ %s, sent over a raw socket, without the token", async (_label, target) => {
    const reply = await sendRaw(target);
    expect(/^HTTP\/1\.1 (200|404) /.test(reply)).toBe(true);
    expect(reply.includes(API_TOKEN_BODY)).toBe(false);
    expect(lines.join("\n").includes(API_TOKEN_BODY)).toBe(false);
    expect(loggedUrls().length).toBeGreaterThan(0);
    expect(loggedUrls().every((logged) => logged === REDACTED_API_TOKEN_URL)).toBe(true);
  });
});

/*
 * By the invariant "no logged field holding a client-supplied value carries
 * a tf_ token": beside the URL, the request log's fields a client writes,
 * the Accept-Version header, the host (Host, or X-Forwarded-Host once proxy
 * hops are trusted) and the address (X-Forwarded-For's once they are), are
 * REDACTED_FIELD when any spelling the URL's rule checks holds tf_.
 * Booleans only, so a failure prints no canary.
 */
/** [label, a field's value holding tf_]: as spelt, upper and mixed case, each letter encoded, all three, beside a malformed escape. */
const API_TOKEN_FIELD_SPELLINGS: readonly (readonly [string, string])[] = [
  ["as spelt", API_TOKEN],
  ["after other text", `x-${API_TOKEN}`],
  ["in upper case", `TF_${API_TOKEN_BODY}`],
  ["in mixed case", `tF_${API_TOKEN_BODY}`],
  ["with its t encoded", `%74f_${API_TOKEN_BODY}`],
  ["with its f encoded", `t%66_${API_TOKEN_BODY}`],
  ["with its _ encoded", `tf%5F${API_TOKEN_BODY}`],
  ["with every letter encoded", `%54%46%5f${API_TOKEN_BODY}`],
  ["beside a malformed escape", `${API_TOKEN}%`],
];

describe("loggedClientField: a client's text in a logged field", () => {
  it.each(API_TOKEN_FIELD_SPELLINGS)("is the fixed redaction for a value holding tf_ %s", (_label, value) => {
    expect(loggedClientField(value) === REDACTED_FIELD).toBe(true);
    expect(loggedClientField([`1.0`, value]) === REDACTED_FIELD).toBe(true);
  });

  it("keeps an ordinary value, and an absent one, as before: tf without the underscore, tf- and t_f included", () => {
    expect(loggedClientField("telflo.example")).toBe("telflo.example");
    expect(loggedClientField("tf-1.t_f.example")).toBe("tf-1.t_f.example");
    expect(loggedClientField(["1.0", "2.0"])).toEqual(["1.0", "2.0"]);
    expect(loggedClientField(undefined)).toBeUndefined();
  });
});

describe("a real Fastify's log lines hold no API token in a client-supplied field", () => {
  const lines: string[] = [];
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify({
      logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
      // One trusted hop, as the stack's gateway: X-Forwarded-For and X-Forwarded-Host are read.
      trustProxy: (_address: string, hop: number) => hop < 1,
    });
    registerErrorHandling(server);
    server.get("/api/public/v1/whoami", async () => ({ ok: true }));
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  type LoggedRequest = { version?: unknown; host?: unknown; remoteAddress?: unknown };
  const loggedRequests = () =>
    lines.flatMap((line) => {
      const { req } = JSON.parse(line) as { req?: LoggedRequest };
      return req === undefined ? [] : [req];
    });

  const send = (headers: Record<string, string>) =>
    server.inject({ method: "GET", url: "/api/public/v1/whoami", remoteAddress: "10.0.0.2", headers });

  it.each(API_TOKEN_FIELD_SPELLINGS)("logs an Accept-Version, a Host, an X-Forwarded-Host and an X-Forwarded-For holding tf_ %s as the fixed redaction", async (_label, value) => {
    for (const [header, field] of [
      ["accept-version", "version"],
      ["host", "host"],
      ["x-forwarded-host", "host"],
      ["x-forwarded-for", "remoteAddress"],
    ] as const) {
      lines.length = 0;
      expect((await send({ [header]: value })).statusCode).toBe(200);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n").includes(API_TOKEN_BODY)).toBe(false);
      const logged = loggedRequests();
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.every((request) => request[field] === REDACTED_FIELD)).toBe(true);
    }
  });

  it("logs ordinary values as before", async () => {
    await send({ "accept-version": "1.0", host: "telflo.example", "x-forwarded-for": "198.51.100.7" });
    expect(loggedRequests()).toEqual([
      expect.objectContaining({ version: "1.0", host: "telflo.example", remoteAddress: "198.51.100.7" }),
    ]);
    lines.length = 0;
    await send({});
    expect(loggedRequests()).toEqual([expect.objectContaining({ host: "localhost:80", remoteAddress: "10.0.0.2" })]);
    expect(loggedRequests()[0]?.version).toBeUndefined();
  });
});

/*
 * The library link's public route ends in a link, a credential. Whatever the
 * spelling, the request's log lines (and the 404's reply) hold a fixed
 * redaction, never the link; every client-supplied logged field holding `tll_`
 * is REDACTED_FIELD (the class rule). The canary is built here, at run time,
 * and is visibly fake (no key signed it); every assertion compares booleans,
 * so a failure prints none of it. A redaction test accepts any redacted form:
 * a real link's random part could hold `tqd_` or `tf_`.
 */
const LINK_BODY = `${"LLCANARY".repeat(8)}LLCANAR`;
const LINK = `tll_${LINK_BODY}`;
const REDACTIONS = [REDACTED_LIBRARY_LINK_URL, REDACTED_QUICK_DEPLOY_URL, REDACTED_API_TOKEN_URL];
const isRedacted = (logged: string) => REDACTIONS.includes(logged);

/** [label, url, the route it matches in the API (undefined: none)]. */
const LINK_SPELLINGS: readonly (readonly [string, string, string | undefined])[] = [
  ["as the route matches it", `/api/v1/library-links/${LINK}`, LIBRARY_LINK_ROUTE],
  ["as spelt with no route at hand", `/api/v1/library-links/${LINK}`, undefined],
  ["with a query", `/api/v1/library-links/${LINK}?x=1`, LIBRARY_LINK_ROUTE],
  ["with a raw #", `/api/v1/library-links/${LINK}#frag`, LIBRARY_LINK_ROUTE],
  ["with a trailing slash", `/api/v1/library-links/${LINK}/`, undefined],
  ["with a doubled slash at the start", `//api/v1/library-links/${LINK}`, undefined],
  ["with a doubled slash inside", `/api/v1//library-links/${LINK}`, undefined],
  ["with an encoded slash", `/api/v1/library-links%2F${LINK}`, undefined],
  ["in upper case", `/API/V1/LIBRARY-LINKS/${LINK.toUpperCase()}`, undefined],
  ["with a dot segment before it", `/api/v1/x/../library-links/${LINK}`, undefined],
  ["with a dot segment after it", `/api/v1/library-links/${LINK}/../x`, undefined],
  ["with its prefix's _ encoded", `/api/v1/library-links/tll%5F${LINK_BODY}`, LIBRARY_LINK_ROUTE],
  ["with its t encoded", `/api/v1/library-links/%74ll_${LINK_BODY}`, LIBRARY_LINK_ROUTE],
  ["with an l encoded", `/api/v1/library-links/t%6Cl_${LINK_BODY}`, LIBRARY_LINK_ROUTE],
  ["with every prefix letter encoded, upper-case codes", `/register?s=%54%4C%4C%5F${LINK_BODY}`, undefined],
  ["with encoded letters in the segment", `/api/v1/%6cibrary-links/%74ll_${LINK_BODY}`, undefined],
  ["beside a malformed escape", `/api/v1/library-links/${LINK}%`, undefined],
  ["after a semicolon", `/api/v1/library-links/${LINK};jsessionid=1`, undefined],
  ["without the /api/v1 prefix", `/library-links/${LINK}`, undefined],
  ["in another route's query", `/api/v1/organizations/o-1/fleets?s=${LINK}`, "/api/v1/organizations/:organizationId/fleets"],
  ["in an ordinary route's query", `/api/v1/auth/me?s=${LINK}`, "/api/v1/auth/me"],
  ["in mixed case in a query", `/api/v1/auth/me?s=TlL_${LINK_BODY}`, "/api/v1/auth/me"],
  ["after an ordinary route's raw #", `/api/v1/auth/me#${LINK}`, "/api/v1/auth/me"],
  ["in a path that only names the link", `/api/v1/x/${LINK}`, undefined],
  ["in a library file's path", `/api/v1/library-files/${LINK}/link`, "/api/v1/library-files/:fileId/link"],
  ["in an organization's path", `/api/v1/organizations/${LINK}`, "/api/v1/organizations/:organizationId"],
];

describe("loggedRequestUrl: a library link", () => {
  it.each(LINK_SPELLINGS)("logs a URL %s as the fixed redaction", (_label, url, route) => {
    const logged = loggedRequestUrl(url, route);
    expect(logged === REDACTED_LIBRARY_LINK_URL).toBe(true);
    expect(logged.includes(LINK_BODY)).toBe(false);
    expect(urlMayHoldPublicLinkSecret(url, route)).toBe(true);
  });

  it("redacts by the matched route alone, whatever the URL's spelling", () => {
    expect(loggedRequestUrl("/api/v1/library-links/x", LIBRARY_LINK_ROUTE)).toBe(REDACTED_LIBRARY_LINK_URL);
  });

  it("keeps the library's own routes, which hold ids only, as before", () => {
    const id = "0199e000-0000-7000-8000-00000000f001";
    expect(loggedRequestUrl("/api/v1/library-files", "/api/v1/library-files")).toBe("/api/v1/library-files");
    expect(loggedRequestUrl(`/api/v1/library-files/${id}/link`, "/api/v1/library-files/:fileId/link")).toBe(`/api/v1/library-files/${id}/link`);
    expect(loggedRequestUrl(`/api/v1/library-files/${id}/file?x=1`, "/api/v1/library-files/:fileId/file")).toBe(`/api/v1/library-files/${id}/file?x=1`);
    expect(loggedRequestUrl("/library?q=guide", undefined)).toBe("/library?q=guide");
    expect(urlMayHoldPublicLinkSecret(`/api/v1/library-files/${id}/link`, undefined)).toBe(false);
  });

  it("keeps an ordinary URL that only looks like one whole: tll without the underscore, tl_, t_ll and /library-linksx", () => {
    expect(loggedRequestUrl("/api/v1/auth/me?q=tll", undefined)).toBe("/api/v1/auth/me?q=tll");
    expect(loggedRequestUrl("/api/v1/auth/me?q=tl_x&r=t_ll", undefined)).toBe("/api/v1/auth/me?q=tl_x&r=t_ll");
    expect(loggedRequestUrl("/api/v1/library-linksx/a?x=1", undefined)).toBe("/api/v1/library-linksx/a?x=1");
  });

  it("a URL holding a quick-deploy secret and a library link is the quick-deploy redaction; one holding a link and tf_ the library's", () => {
    expect(loggedRequestUrl(`/api/v1/quick-deploy/${SECRET}?l=${LINK}`, QUICK_DEPLOY_ROUTE) === REDACTED_QUICK_DEPLOY_URL).toBe(true);
    expect(loggedRequestUrl(`/api/v1/library-links/${LINK}?t=${API_TOKEN}`, LIBRARY_LINK_ROUTE) === REDACTED_LIBRARY_LINK_URL).toBe(true);
  });
});

/**
 * The same through a real Fastify, with the API's serializer and error
 * handling and a stand-in for the link's route: neither the request's log
 * lines nor the 404's reply hold the link, by `inject` and over a raw socket.
 */
describe("a real Fastify's log lines and the 404's reply hold no library link", () => {
  const lines: string[] = [];
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify({
      logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
    });
    registerErrorHandling(server);
    server.get(LIBRARY_LINK_ROUTE, async (_request, reply) => reply.type("text/plain").send("stand-in"));
    server.get("/api/v1/auth/me", async () => ({ ok: true }));
    server.get("/register", async () => "ok");
    await server.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  const loggedUrls = () =>
    lines.flatMap((line) => {
      const { req } = JSON.parse(line) as { req?: { url?: string } };
      return req?.url === undefined ? [] : [req.url];
    });

  // `inject` drops a fragment, and a malformed escape is Fastify's own 400 before any log line.
  const injected = LINK_SPELLINGS.filter(([, url]) => !url.includes("#") && !url.endsWith("%"));

  it.each(injected)("logs and answers a request %s without the link", async (_label, url) => {
    const response = await server.inject({ method: "GET", url });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n").includes(LINK_BODY)).toBe(false);
    expect(loggedUrls().length).toBeGreaterThan(0);
    expect(loggedUrls().every(isRedacted)).toBe(true);
    expect(response.body.includes(LINK_BODY)).toBe(false);
  });

  it("the 404's reply for a path holding a link echoes the redaction", async () => {
    const missing = await server.inject({ method: "GET", url: `/api/v1/x/${LINK}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.body === JSON.stringify({ error: { code: "not_found", message: `No route for GET ${REDACTED_LIBRARY_LINK_URL}` } })).toBe(true);
  });

  /** Sends `target` as the request line over a raw socket, and resolves with the reply. */
  const sendRaw = (target: string) =>
    new Promise<string>((resolve, reject) => {
      const address = server.server.address();
      if (address === null || typeof address === "string") throw new Error("a TCP address expected");
      const socket = connect(address.port, "127.0.0.1", () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let reply = "";
      socket.on("data", (chunk: Buffer) => (reply += chunk.toString("latin1")));
      socket.on("end", () => resolve(reply));
      socket.on("error", reject);
    });

  // Named by labels, so no test's title prints the canary.
  it.each([
    ["after a dot segment", `/api/v1/x/../library-links/${LINK}`],
    ["after a ./ segment", `/api/v1/./library-links/${LINK}`],
    ["before a raw #", `/api/v1/library-links/${LINK}#frag`],
    ["after an ordinary route's raw #", `/api/v1/auth/me#${LINK}`],
    ["before a dot segment", `/api/v1/library-links/${LINK}/../x`],
    ["in mixed case", `/api/v1/Library-Links/${LINK}`],
  ])("logs and answers a link %s, sent over a raw socket, without it", async (_label, target) => {
    const reply = await sendRaw(target);
    expect(/^HTTP\/1\.1 (200|404) /.test(reply)).toBe(true);
    expect(reply.includes(LINK_BODY)).toBe(false);
    expect(lines.join("\n").includes(LINK_BODY)).toBe(false);
    expect(loggedUrls().length).toBeGreaterThan(0);
    expect(loggedUrls().every(isRedacted)).toBe(true);
  });
});

/** [label, a field's value holding tll_]: as spelt, upper and mixed case, each letter encoded, all of them, beside a malformed escape. */
const LINK_FIELD_SPELLINGS: readonly (readonly [string, string])[] = [
  ["as spelt", LINK],
  ["after other text", `x-${LINK}`],
  ["in upper case", `TLL_${LINK_BODY}`],
  ["in mixed case", `tLl_${LINK_BODY}`],
  ["with its t encoded", `%74ll_${LINK_BODY}`],
  ["with an l encoded", `t%6cl_${LINK_BODY}`],
  ["with its _ encoded", `tll%5F${LINK_BODY}`],
  ["with every letter encoded", `%54%4C%4c%5f${LINK_BODY}`],
  ["beside a malformed escape", `${LINK}%`],
];

describe("loggedClientField: a library link in a logged field", () => {
  it.each(LINK_FIELD_SPELLINGS)("is the fixed redaction for a value holding tll_ %s", (_label, value) => {
    expect(loggedClientField(value) === REDACTED_FIELD).toBe(true);
    expect(loggedClientField(["1.0", value]) === REDACTED_FIELD).toBe(true);
  });

  it("keeps an ordinary value as before: tll without the underscore, tl_ and t_ll", () => {
    expect(loggedClientField("tll.example")).toBe("tll.example");
    expect(loggedClientField("tl_1.t_ll.example")).toBe("tl_1.t_ll.example");
  });
});

describe("a real Fastify's log lines hold no library link in a client-supplied field", () => {
  const lines: string[] = [];
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify({
      logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
      // One trusted hop, as the stack's gateway: X-Forwarded-For and X-Forwarded-Host are read.
      trustProxy: (_address: string, hop: number) => hop < 1,
    });
    registerErrorHandling(server);
    server.get("/api/v1/auth/me", async () => ({ ok: true }));
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  type LoggedRequest = { version?: unknown; host?: unknown; remoteAddress?: unknown };
  const loggedRequests = () =>
    lines.flatMap((line) => {
      const { req } = JSON.parse(line) as { req?: LoggedRequest };
      return req === undefined ? [] : [req];
    });

  it.each(LINK_FIELD_SPELLINGS)("logs an Accept-Version, a Host, an X-Forwarded-Host and an X-Forwarded-For holding tll_ %s as the fixed redaction", async (_label, value) => {
    for (const [header, field] of [
      ["accept-version", "version"],
      ["host", "host"],
      ["x-forwarded-host", "host"],
      ["x-forwarded-for", "remoteAddress"],
    ] as const) {
      lines.length = 0;
      const response = await server.inject({ method: "GET", url: "/api/v1/auth/me", remoteAddress: "10.0.0.2", headers: { [header]: value } });
      expect(response.statusCode).toBe(200);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n").includes(LINK_BODY)).toBe(false);
      const logged = loggedRequests();
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.every((request) => request[field] === REDACTED_FIELD)).toBe(true);
    }
  });
});
