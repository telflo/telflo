import { useEffect, useState } from "react";
import { useRouteLoaderData } from "react-router";
import type { CaptureResult, CapturedNetworkRequest, PostHog, PostHogConfig } from "posthog-js";
import { isCliAuthDocument } from "~/lib/cli-auth.js";
import { CONSENT_CHANGED_EVENT, getConsentStatus } from "~/lib/cookie-consent.js";

/*
 * Product analytics: PostHog, switched on by a setting (D4 decision 8; ADR 0024).
 *
 * No key is built into the bundle, and no host name turns it on: the web
 * server reads TELFLO_POSTHOG_KEY at request time and root's loader passes
 * it on (analytics.server.ts). Without
 * it, root never calls useAnalytics's start, posthog-js is never imported,
 * and nothing here does anything: every call below waits on a client that
 * never arrives.
 *
 * With it, posthog-js is imported in the browser only, from an effect, and
 * everything waits on the one client its init produces (Preflight ruling 2):
 * the signed-in layout's effects run before root's, so an identify can come
 * before the init has even started.
 *
 * The consent calls (Preflight ruling 3), and what posthog-js really does
 * with them: with `cookieless_mode: 'on_reject'` and no choice yet, it
 * captures nothing at all, not even cookielessly. Init still loads its flags and remote
 * configuration (PostHog's config.js runs on this origin), sending a random
 * id made for this page load and never stored, the timezone and the origin:
 * no email, no URL, no storage, no capture (Ruling 14). Accepting opts in:
 * capture starts, with its cookies and storage, and so does session replay,
 * except on a local host. Rejecting clears the opt-in, back to capturing
 * nothing.
 *
 * Whatever is captured after accepting carries no emailed link's token
 * (Ruling 14): the reset and verification pages take theirs out of the
 * address bar before this starts, and stripTokens drops any fragment and any
 * `token` parameter from the URLs an event or a recording carries. On the
 * flows library's page (`/flows`), they lose `q` too, what the visitor typed
 * into its search (D12 Ruling 35): every URL-valued property (the page's
 * address, the referrers, `$set`'s and `$set_once`'s), heatmaps' keys, and
 * replay's page addresses and recorded requests; its `signals` and `tags`
 * stay. A URL or path that may hold a quick-deploy link's secret is
 * replaced whole by `/quick-deploy/[redacted]` (D17c-2 decision 32; behind
 * the gateway a link typed without `/api/` is nginx's own 404, never the
 * web app's, Ruling 44; on the dev server it renders root's ErrorBoundary,
 * where PostHog is never imported: the check is a backstop), and so is a clicked
 * element's description that may hold one (`$elements_chain`); PostHog
 * never starts at all in a page whose own address or referrer may hold
 * one (startAnalytics). A URL or path whose path or query holds an API
 * token's prefix, `tf_` (D22 decision 40; Ruling 106), is replaced whole by
 * `/[redacted]` after its origin, as the API's request log replaces it, and
 * PostHog never starts in a page whose address (its fragment too) or
 * referrer holds it either, nor on the CLI's sign-in page (`/cli-auth`, or
 * `/login` on the way to it: D27 Preflight ruling 14). A
 * request replay records to the API (`/api/` in its path) loses its whole
 * query, which can hold a search, and a request for an organization's logo
 * its whole path, which names the organization (withoutTokensInRequest;
 * D23-2 Ruling 145). Replay masks every input,
 * and all text inside the signed-in app and the auth screens (their roots
 * carry `ph-mask`); it never records a request's
 * headers or body, or the console, whatever PostHog's project settings say.
 * While one of those shells is shown,
 * autocapture sends no element's text or attributes, except a clicked link's
 * `href` (setAnalyticsMasked,
 * Ruling 16).
 */

/** What root's loader passes on when TELFLO_POSTHOG_KEY is set. */
export interface AnalyticsSettings {
  /** The PostHog project's key. */
  key: string;
  /** TELFLO_POSTHOG_HOST, or null for posthog-js's own default host. */
  host: string | null;
}

let resolveClient!: (client: PostHog) => void;
/** The one client, once posthog-js is imported and initialised. */
const clientReady = new Promise<PostHog>((resolve) => {
  resolveClient = resolve;
});
let started = false;

/** Runs `use` once the client is ready; never, without the setting. */
function withClient(use: (client: PostHog) => void): void {
  void clientReady.then(use);
}

/**
 * How many of the surfaces that show private data are on the page: the
 * signed-in app's shell and the auth screens'. Replay masks their text by `ph-mask`, but autocapture
 * ignores it everywhere (Radix's portals sit outside the shells, in `<body>`), and never
 * masks an attribute. So while any of them is shown, autocapture (and dead
 * clicks) send no element's text and no attributes, except a clicked link's
 * `href`, which posthog-js always sends (Ruling 16).
 */
let maskedSurfaces = 0;

/** posthog-js's options for autocapture's masking, which it reads at each event. */
function autocaptureMasking(): Pick<PostHogConfig, "mask_all_text" | "mask_all_element_attributes"> {
  const masked = maskedSurfaces > 0;
  return { mask_all_text: masked, mask_all_element_attributes: masked };
}

/**
 * Masks autocapture while `on`: each surface that shows private data calls
 * it as it is shown, and calls the release it gets back when it goes (an
 * effect's cleanup); autocapture unmasks once every one has. Releasing
 * twice changes nothing. `false` masks nothing, and its release does
 * nothing, so an effect can pass whether its surface is open.
 */
export function setAnalyticsMasked(on: boolean): () => void {
  if (!on) return () => {};
  maskedSurfaces += 1;
  if (maskedSurfaces === 1) applyAutocaptureMasking();
  let isReleased = false;
  return () => {
    if (isReleased) return;
    isReleased = true;
    maskedSurfaces -= 1;
    if (maskedSurfaces === 0) applyAutocaptureMasking();
  };
}

/**
 * Tells the client the masking as it is when the client is ready. Before
 * root has started PostHog there is nothing to tell: its init reads the
 * count (initOptions), and without the setting it never starts.
 */
function applyAutocaptureMasking(): void {
  if (!started) return;
  withClient((client) => client.set_config(autocaptureMasking()));
}

/**
 * Where session replay never runs: a developer's machine (the loopback
 * addresses too, not only `localhost` and `telflo.test`). A browser gives an
 * IPv6 host with its brackets.
 */
export function isLocalHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "telflo.test"].includes(hostname);
}

/** The signed-in user, and whom PostHog was last told about. */
let signedInUser: { id: string; email: string } | null = null;
let identifiedId: string | null = null;
/** A sign-out came before PostHog started: its init is followed by the reset. */
let resetPending = false;

/**
 * Tells PostHog who the signed-in user is, once the visitor has accepted.
 * posthog-js sends an identify's id and email even when nothing else is
 * captured, so none is sent before the choice (Preflight ruling 2).
 */
function identifyIfAccepted(client: PostHog): void {
  if (signedInUser === null || identifiedId === signedInUser.id) return;
  if (getConsentStatus() !== "accepted") return;
  client.identify(signedInUser.id, { email: signedInUser.email });
  identifiedId = signedInUser.id;
}

function syncConsent(client: PostHog): void {
  if (getConsentStatus() === "accepted") {
    // Explicit opt-in: capture and session replay.
    client.opt_in_capturing();
    if (!isLocalHost(window.location.hostname)) client.startSessionRecording();
    identifyIfAccepted(client);
  } else {
    // 'rejected' or null (undecided): clearing any earlier opt-in returns to
    // the undecided state, which captures nothing. Replay is stopped in case
    // an earlier accept started it.
    client.clear_opt_in_out_capturing();
    client.stopSessionRecording();
    // PostHog drops its storage, and with it whom it was told about, so an
    // accept after this identifies the user again. Its session storage
    // outlives the clear (Ruling 14).
    identifiedId = null;
    removePostHogSessionStorage();
  }
}

/** PostHog's own keys in `sessionStorage`, which all start `ph_`. */
function removePostHogSessionStorage(): void {
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index));
    for (const key of keys) if (key?.startsWith("ph_")) sessionStorage.removeItem(key);
  } catch {
    // Storage disabled: nothing was kept.
  }
}

/** The URL properties' names: `$current_url`, `$initial_referrer`, `$pathname` and the like. */
const URL_PROPERTY = /url|referrer|href|pathname/i;

/**
 * A quick-deploy link's secret's prefix, `tqd_`, in any case and with any of
 * its characters percent-encoded (`%74qd_`, `t%71d_`, `tqd%5F`). The
 * gateway's access log (docker/gateway/default.conf) matches these
 * spellings in the raw request line and Referer, but decodes neither
 * (its once-decoded path, `$uri`, is searched only for `tqd_` and a
 * `/quick-deploy/` segment as spelt), where
 * mayHoldQuickDeploySecret also tests each spelling percent-decoded once:
 * nginx logs as sent a prefix encoded twice (`%2574qd_`), in the request
 * line or a Referer, and a hand-encoded `quick-deploy` (`/%71uick-deploy/…`,
 * `%2Fquick-deploy%2F…`) in a Referer, residues recorded in the review of
 * D17c-2 decision 32.
 */
const QUICK_DEPLOY_SECRET_PREFIX = /(t|%74|%54)(q|%71|%51)(d|%64|%44)(_|%5f)/i;

/** A `/quick-deploy/` segment, or a path that ends in `/quick-deploy`: the link's own path. */
const QUICK_DEPLOY_SEGMENT = /\/quick-deploy(\/|$)/i;

/** What stands for a URL or path that may hold a link's secret. */
const REDACTED_QUICK_DEPLOY_PATH = "/quick-deploy/[redacted]";

/**
 * Whether `url` (absolute or relative, up to its fragment, which is dropped
 * anyway) may hold a quick-deploy link's secret (D17c-2 decision 32): `tqd_`
 * in its path or its query, as spelt or percent-decoded once, or a
 * `/quick-deploy/` segment in its path, as the browser resolves it (dot
 * segments) and percent-decoded, runs of `/` made one. A link typed without
 * `/api/` (`/quick-deploy/tqd_…`) never reaches the web app behind the
 * gateway (nginx answers its own 404, Ruling 44); on the dev server it
 * renders root's ErrorBoundary, where PostHog is never imported. This is
 * the backstop for any page that would hold one anyway, whose address
 * posthog-js would otherwise send whole. The links' own routes
 * (`/quick-deploy-links`) don't count.
 */
function mayHoldQuickDeploySecret(url: string): boolean {
  const beforeHash = url.split("#", 1)[0] ?? "";
  const beforeQuery = beforeHash.split("?", 1)[0] ?? "";
  const paths = [beforeQuery];
  try {
    paths.push(new URL(beforeQuery, REQUEST_BASE).pathname);
  } catch {
    // Not a URL: its path is read as spelt.
  }
  const spellings = [beforeHash, ...paths].flatMap((spelling) => [spelling, decodedOrAsSpelt(spelling)]);
  if (spellings.some((spelling) => QUICK_DEPLOY_SECRET_PREFIX.test(spelling))) return true;
  return paths
    .flatMap((path) => [path, decodedOrAsSpelt(path)])
    .some((path) => QUICK_DEPLOY_SEGMENT.test(path.replace(/\/{2,}/g, "/")));
}

function decodedOrAsSpelt(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The fixed form of a URL that may hold a link's secret: its origin, if it
 * has one, and `/quick-deploy/[redacted]`; nothing of its path, query or
 * fragment.
 */
function redactedQuickDeployUrl(url: string): string {
  return redactedUrl(url, REDACTED_QUICK_DEPLOY_PATH);
}

/** `url`'s origin, if it has one, and `path`: nothing of its own path, query or fragment. */
function redactedUrl(url: string, path: string): string {
  try {
    const { origin, protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:") return `${origin}${path}`;
  } catch {
    // Relative: the path alone.
  }
  return path;
}

/**
 * A library link's prefix, `tll_` (D23-2 decisions 4 and 55; Preflight
 * ruling 23), in any case and with any of its characters percent-encoded
 * (`%74ll_`, `t%6cl_`, `tll%5F`): the gateway's spellings (decision 50).
 * mayHoldLibraryLink also tests each spelling percent-decoded once, so a
 * prefix encoded twice counts too.
 */
const LIBRARY_LINK_PREFIX = /(t|%74|%54)(l|%6c|%4c)(l|%6c|%4c)(_|%5f)/i;

/** A `/library-links/` segment, or a path that ends in `/library-links`: the link's own route. */
const LIBRARY_LINK_SEGMENT = /\/library-links(\/|$)/i;

/** What stands for a URL or path that may hold a library link: the API's request log's form, less `/api/v1`. */
const REDACTED_LIBRARY_LINK_PATH = "/library-links/[redacted]";

/**
 * Whether `url` (absolute or relative, up to its fragment, which is dropped
 * anyway) may hold a library link (D23-2 decision 55): `tll_` in its path
 * or its query, as spelt or percent-decoded once, or a `/library-links/`
 * segment in its path, as the browser resolves it (dot segments) and
 * percent-decoded, runs of `/` made one, as mayHoldQuickDeploySecret reads
 * a quick-deploy link. The link is only ever on the clipboard and in its
 * `201`'s body; this is the backstop for a page whose address would hold one
 * anyway (a link opened in the browser, `/library-links/…` typed without
 * `/api/`), whose address posthog-js would otherwise send whole. The
 * library's own routes (`/library`, `/api/v1/library-files/…`) don't count.
 */
function mayHoldLibraryLink(url: string): boolean {
  const beforeHash = url.split("#", 1)[0] ?? "";
  const beforeQuery = beforeHash.split("?", 1)[0] ?? "";
  const paths = [beforeQuery];
  try {
    paths.push(new URL(beforeQuery, REQUEST_BASE).pathname);
  } catch {
    // Not a URL: its path is read as spelt.
  }
  const spellings = [beforeHash, ...paths].flatMap((spelling) => [spelling, decodedOnce(spelling)]);
  if (spellings.some((spelling) => LIBRARY_LINK_PREFIX.test(spelling))) return true;
  return paths
    .flatMap((path) => [path, decodedOnce(path)])
    .some((path) => LIBRARY_LINK_SEGMENT.test(path.replace(/\/{2,}/g, "/")));
}

/**
 * An API token's prefix, `tf_` (D22 decisions 7 and 40), in any case and
 * with any of its characters percent-encoded once (`%74f_`, `t%66_`,
 * `tf%5F`). mayHoldApiToken also tests the URL percent-decoded once, so a
 * prefix encoded twice counts too.
 */
const API_TOKEN_PREFIX = /(t|%74|%54)(f|%66|%46)(_|%5f)/i;

/** What stands for a URL or path that may hold an API token: the API's request log's form (http/request-log.ts). */
const REDACTED_API_TOKEN_PATH = "/[redacted]";

/**
 * Whether `url` (absolute or relative, or anything else) may hold an API
 * token (D22 decision 40; Ruling 106): `tf_`, case aside, in its path or its
 * query, as spelt or percent-decoded once. A token never belongs in a URL
 * (it travels in the `Authorization` header); this covers one pasted into
 * the address bar. The fragment, which every URL sent loses anyway, is left
 * out unless `withFragment` (startAnalytics: posthog-js stores the page's
 * address before any before_send sees it). False positives (a search for
 * `tf_`; an emailed link's token holding it, though those pages take their
 * token out of the address bar before the root starts analytics) only lose
 * a URL.
 */
function mayHoldApiToken(url: string, { withFragment = false } = {}): boolean {
  const spelt = withFragment ? url : (url.split("#", 1)[0] ?? "");
  return API_TOKEN_PREFIX.test(spelt) || API_TOKEN_PREFIX.test(decodedOnce(spelt));
}

/**
 * `text` percent-decoded once, as the API's request log decodes a URL: with
 * a malformed escape elsewhere (a lone `%`), each valid escape decoded on its
 * own, which spells every ASCII character right.
 */
function decodedOnce(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/%([0-9a-fA-F]{2})/g, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
}

/**
 * `url` without its fragment and without any `token` query parameter, the
 * two places an emailed link carries its token (`/reset-password#token=…`,
 * `/verify-email?token=…`, `/accept-invitation#token=…`), and, on the flows
 * library's own path, without its `q`: what the visitor typed into its
 * search (D12 Ruling 35). The library's other parameters, its `signals` and
 * `tags` chips, stay. Anything that is not a URL (`$direct`, a path) comes
 * back as it was, less the same parts. A URL or path that may hold a
 * quick-deploy link's secret comes back as `/quick-deploy/[redacted]`, after
 * its origin if it has one (mayHoldQuickDeploySecret), one that may hold a
 * library link as `/library-links/[redacted]` (mayHoldLibraryLink, D23-2
 * decision 55), and one that may hold an API token as `/[redacted]`, the
 * same way (mayHoldApiToken).
 */
export function withoutTokens(url: string): string {
  if (mayHoldQuickDeploySecret(url)) return redactedQuickDeployUrl(url);
  if (mayHoldLibraryLink(url)) return redactedUrl(url, REDACTED_LIBRARY_LINK_PATH);
  if (mayHoldApiToken(url)) return redactedUrl(url, REDACTED_API_TOKEN_PATH);
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt < 0) return beforeHash;
  const beforeQuery = beforeHash.slice(0, queryAt);
  const dropsSearch = isFlowsLibraryPath(beforeQuery);
  const kept = beforeHash
    .slice(queryAt + 1)
    .split("&")
    .filter((pair) => {
      if (pair === "") return false;
      const name = parameterName(pair).toLowerCase();
      return name !== "token" && !(dropsSearch && name === "q");
    });
  return beforeQuery + (kept.length > 0 ? `?${kept.join("&")}` : "");
}

/**
 * Whether `beforeQuery` (a URL, absolute or relative, up to its query) is the
 * flows library's page, `/flows`, which holds its search in `q` (D12
 * decision 1). React Router matches a path case-insensitively, with a
 * trailing slash or without, and percent-decoded, so those all count. Only
 * the library: a flow's page, `/flows/<slug>`, has no search.
 *
 * If `/flows` ever gets a loader, the browser will fetch `/flows.data?q=…`
 * itself: withoutTokensInRequest would then need that path too, since a
 * recorded request outside the API keeps its query but for `token`.
 */
function isFlowsLibraryPath(beforeQuery: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(beforeQuery, REQUEST_BASE).pathname;
  } catch {
    return false;
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Not percent-encoded as a path would be: read as it is.
  }
  return pathname.replace(/\/+$/, "").toLowerCase() === FLOWS_LIBRARY_PATH;
}

/** The flows library's path (routes.ts), where `q` is the visitor's search. */
const FLOWS_LIBRARY_PATH = "/flows";

function parameterName(pair: string): string {
  const name = pair.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/** A key that is a URL: `$heatmap_data`'s, one per page address. */
const URL_KEY = /^https?:\/\//i;

/**
 * `properties` with every URL property's value without tokens, at any depth
 * of plain objects: `$set` and `$set_once`, and posthog-js's own nested
 * events, such as a `$web_vitals_…_event`'s `$current_url`. A key that is a
 * URL (`$heatmap_data`'s) loses them too; two keys that become one keep
 * both lists. Arrays are left as they are here: a recording's are cleaned
 * on their own (withoutTokensInRecording), and every string at any depth,
 * arrays included, is read for a library link or a logo's address after
 * (withoutLibraryLinksOrLogosIn).
 */
function withoutTokensIn(properties: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    const key = URL_KEY.test(name) ? withoutTokens(name) : name;
    let kept: unknown = value;
    if (typeof value === "string" && URL_PROPERTY.test(name)) kept = withoutTokens(value);
    else if (isRecord(value)) kept = withoutTokensIn(value);
    const earlier = cleaned[key];
    cleaned[key] = Array.isArray(earlier) && Array.isArray(kept) ? [...earlier, ...kept] : kept;
  }
  return cleaned;
}

/** A plain object: not an array, a date or anything else with a prototype of its own. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** rrweb's event types that carry the page's address: Meta's `href`, and PostHog's own `$url_changed`/`$pageview` custom events. */
const RRWEB_META = 4;
const RRWEB_CUSTOM = 5;

/** A replay event with the page's address, if it has one, without tokens. */
function withoutTokensInRecording(recorded: unknown): unknown {
  if (!isRecord(recorded) || !isRecord(recorded.data)) return recorded;
  const { data } = recorded;
  if (recorded.type === RRWEB_META && typeof data.href === "string") {
    return { ...recorded, data: { ...data, href: withoutTokens(data.href) } };
  }
  if (recorded.type === RRWEB_CUSTOM && isRecord(data.payload) && typeof data.payload.href === "string") {
    return { ...recorded, data: { ...data, payload: { ...data.payload, href: withoutTokens(data.payload.href) } } };
  }
  return recorded;
}

/** What stands for a clicked element's description that may hold a link's secret. */
const REDACTED_QUICK_DEPLOY_ELEMENTS_CHAIN = `a:href="${REDACTED_QUICK_DEPLOY_PATH}"`;

/** What stands for a clicked element's description that may hold a library link (D23-2 decision 55). */
const REDACTED_LIBRARY_LINK_ELEMENTS_CHAIN = `a:href="${REDACTED_LIBRARY_LINK_PATH}"`;

/**
 * Whether one of an element's values (its text, an attribute's value) may
 * hold a quick-deploy link's secret: the prefix anywhere in it, in any of
 * its spellings, or the value read as a URL would be
 * (mayHoldQuickDeploySecret).
 */
function elementValueMayHoldSecret(value: string): boolean {
  return QUICK_DEPLOY_SECRET_PREFIX.test(value) || mayHoldQuickDeploySecret(value);
}

/** Whether one of an element's values may hold a library link: as elementValueMayHoldSecret, with `tll_` (mayHoldLibraryLink). */
function elementValueMayHoldLibraryLink(value: string): boolean {
  return LIBRARY_LINK_PREFIX.test(value) || mayHoldLibraryLink(value);
}

/**
 * Whether autocapture's `$elements_chain` may hold a quick-deploy link's
 * secret: the clicked element and its ancestors as one string
 * (`a.button:attr__href="/quick-deploy/tqd_…"href="…"nth-child="1";div…`),
 * which carries a clicked link's `href` even while the attributes are
 * masked (Ruling 16), and the elements' text when they aren't. It may if
 * the prefix is anywhere in it, in any of its spellings, or if any of its
 * quoted values may hold one as a URL would (mayHoldQuickDeploySecret).
 * Each value is read on its own: read whole, the string would be cut at
 * its first `#` or `?`, which an earlier value may hold (a class such as
 * `bg-[#fff]`).
 */
function elementsChainMayHoldSecret(chain: string): boolean {
  return QUICK_DEPLOY_SECRET_PREFIX.test(chain) || chain.split('"').some(mayHoldQuickDeploySecret);
}

/** Whether `$elements_chain` may hold a library link: as elementsChainMayHoldSecret, with `tll_` (mayHoldLibraryLink). */
function elementsChainMayHoldLibraryLink(chain: string): boolean {
  return LIBRARY_LINK_PREFIX.test(chain) || chain.split('"').some(mayHoldLibraryLink);
}

/**
 * Whether autocapture's other forms of the same elements may hold a link's
 * secret where the chain doesn't show it: the clicked element's text
 * (`$el_text`, sent whole, where the chain keeps only its first 400
 * characters), and, in `$elements`, each element's `$el_text` and every
 * `attr__…` value (posthog-js 1.376.0: autocapture.ts, autocapture-utils.ts).
 */
function elementsMayHoldSecret(
  properties: Record<string, unknown>,
  mayHold: (value: string) => boolean = elementValueMayHoldSecret,
): boolean {
  const text = properties.$el_text;
  if (typeof text === "string" && mayHold(text)) return true;
  const elements = properties.$elements;
  if (!Array.isArray(elements)) return false;
  return elements.some(
    (element) =>
      isRecord(element) &&
      Object.entries(element).some(
        ([name, value]) => (name === "$el_text" || name.startsWith("attr__")) && typeof value === "string" && mayHold(value),
      ),
  );
}

/**
 * An autocapture event's properties with the clicked element's description
 * replaced by a fixed one when any of its forms may hold a link's secret:
 * `$elements_chain`, when it is sent, becomes
 * REDACTED_QUICK_DEPLOY_ELEMENTS_CHAIN, and the same elements' other
 * forms, `$elements` (posthog-js's older array, sent until PostHog's remote
 * configuration says otherwise) and `$el_text`, are dropped. Any one of the
 * three holding it is enough (elementsMayHoldSecret). One that may hold a
 * library link instead (`tll_`, however spelt, or a `/library-links/` path;
 * D23-2 decision 55) goes the same way, its chain
 * REDACTED_LIBRARY_LINK_ELEMENTS_CHAIN.
 */
function withoutSecretInElements(properties: Record<string, unknown>): Record<string, unknown> {
  const chain = properties.$elements_chain;
  const chainHoldsIt = typeof chain === "string" && elementsChainMayHoldSecret(chain);
  let redactedChain: string;
  if (chainHoldsIt || elementsMayHoldSecret(properties)) {
    redactedChain = REDACTED_QUICK_DEPLOY_ELEMENTS_CHAIN;
  } else if (
    (typeof chain === "string" && elementsChainMayHoldLibraryLink(chain)) ||
    elementsMayHoldSecret(properties, elementValueMayHoldLibraryLink)
  ) {
    // A library link (D23-2 decision 55), the same way.
    redactedChain = REDACTED_LIBRARY_LINK_ELEMENTS_CHAIN;
  } else {
    return properties;
  }
  const cleaned: Record<string, unknown> = { ...properties };
  if (chain !== undefined) cleaned.$elements_chain = redactedChain;
  delete cleaned.$elements;
  delete cleaned.$el_text;
  return cleaned;
}

/**
 * posthog-js's `before_send`: the last look at every event and every batch
 * of replay before it leaves the page (Ruling 14). posthog-js records
 * `location.href` whole, fragment and query included, as `$current_url`,
 * in the initial URL it keeps for the person, in replay's Meta event, as
 * `$heatmap_data`'s keys and inside nested events (web vitals). Every URL
 * property, at any depth of the event's plain objects (its `$set` and
 * `$set_once` among them), every URL key, and every page address in a
 * `$snapshot`'s recording, loses its fragment and any `token` parameter
 * (Rulings 14 and 16), and, on the flows library's path, its `q` (D12
 * Ruling 35). One that may hold a quick-deploy link's secret (`tqd_`,
 * however spelt, or a `/quick-deploy/` path) is replaced whole by
 * `/quick-deploy/[redacted]` (D17c-2 decision 32), and so is a clicked
 * element's description that may hold one (withoutSecretInElements); one
 * that may hold a library link (`tll_`, however spelt, or a
 * `/library-links/` path) by `/library-links/[redacted]` (D23-2 decision
 * 55), the same way. Last, every string value anywhere in the event, arrays
 * included, that may hold a library link or names an organization's logo is
 * replaced whole (withoutLibraryLinksOrLogosIn, D23-2 Ruling 148).
 */
export function stripTokens(event: CaptureResult | null): CaptureResult | null {
  if (event === null) return null;
  try {
    const properties = withoutSecretInElements(withoutTokensIn(event.properties));
    if (event.event === "$snapshot" && Array.isArray(properties.$snapshot_data)) {
      properties.$snapshot_data = properties.$snapshot_data.map(withoutTokensInRecording);
    }
    const cleaned: CaptureResult = {
      ...event,
      properties: withoutLibraryLinksOrLogosIn(properties) as CaptureResult["properties"],
    };
    if (event.$set) cleaned.$set = withoutLibraryLinksOrLogosIn(withoutTokensIn(event.$set)) as CaptureResult["properties"];
    if (event.$set_once) {
      cleaned.$set_once = withoutLibraryLinksOrLogosIn(withoutTokensIn(event.$set_once)) as CaptureResult["properties"];
    }
    return cleaned;
  } catch {
    // Anything that can't be cleaned (a cycle, a toJSON that throws) is dropped, never sent as it was:
    // posthog-js (1.376) calls before_send with no try/catch of its own (D23-2 Ruling 153).
    return null;
  }
}

/**
 * `value` with every string in it, at any depth of plain objects AND arrays,
 * that may hold a library link or names an organization's logo replaced
 * whole (D23-2 Ruling 148, the invariant of Rulings 137 and 145 for every
 * event property): a link by `/library-links/[redacted]`, a logo's address
 * by `/api/v1/organization-logos/[redacted]`, each after the string's origin
 * if it is an absolute URL (valueMayHoldLibraryLink, valueNamesOrganizationLogo).
 * Not only URL properties: a `$web_vitals_LCP_event`'s `entries[].url` (and
 * its attribution's, with posthog-js's attribution build) is the largest
 * image's address, which may be a logo once the PostHog project turns web
 * vitals on. Those entries are the browser's PerformanceEntry objects, not
 * plain ones: an object with a `toJSON` (plain or not) is read by what it
 * returns, what posthog-js will send, and kept as it is unless that
 * changes; a `toJSON` that returns the object itself is read by its own
 * properties, as JSON.stringify then reads it (Ruling 153). Anything
 * unchanged keeps its identity. A cycle (an object met again inside
 * itself, which JSON can't send anyway) throws, and stripTokens drops the
 * event; an object shared by two places is read in each.
 */
function withoutLibraryLinksOrLogosIn(value: unknown, open: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return withoutLibraryLinkOrLogo(value);
  if (typeof value !== "object" || value === null) return value;
  if (open.has(value)) throw new Error("A cycle in an event's properties.");
  open.add(value);
  try {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      const json = (value as { toJSON: () => unknown }).toJSON();
      const cleaned = json === value ? withoutLibraryLinksOrLogosInEntries(value, open) : withoutLibraryLinksOrLogosIn(json, open);
      return cleaned === json ? value : cleaned;
    }
    if (Array.isArray(value)) {
      const cleaned = value.map((item: unknown) => withoutLibraryLinksOrLogosIn(item, open));
      return cleaned.some((item, index) => item !== value[index]) ? cleaned : value;
    }
    if (isRecord(value)) return withoutLibraryLinksOrLogosInEntries(value, open);
    return value;
  } finally {
    open.delete(value);
  }
}

/** `value`'s own enumerable properties cleaned into a plain object, or `value` itself when none changes. */
function withoutLibraryLinksOrLogosInEntries(value: object, open: WeakSet<object>): unknown {
  let changed = false;
  const cleaned: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    cleaned[name] = withoutLibraryLinksOrLogosIn(item, open);
    if (cleaned[name] !== item) changed = true;
  }
  return changed ? cleaned : value;
}

/** The words the cheap check looks for, as spelt or decoded once (`tll_` in any spelling: LIBRARY_LINK_PREFIX). */
const LINK_OR_LOGO_WORD = /library-links|organization-logos/i;

/** `text` with each `%XX` escape decoded on its own: cheap, linear, and spelling every ASCII character right. */
function escapesDecoded(text: string): string {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The cheap check before the full one (Ruling 153): whether `text` holds
 * `tll_` (in any spelling) or one of the words, as spelt or with its `%XX`
 * escapes decoded once. A string with no hit (a stylesheet's percentages,
 * rrweb's inlined `_cssText`) never reaches decodeURIComponent or a URL
 * parse. Every string the full checks would find passes it: they look for
 * the same prefix and words, as spelt or decoded once.
 */
function mayNameLinkOrLogo(text: string): boolean {
  if (LIBRARY_LINK_PREFIX.test(text) || LINK_OR_LOGO_WORD.test(text)) return true;
  if (!text.includes("%")) return false;
  const decoded = escapesDecoded(text);
  return LIBRARY_LINK_PREFIX.test(decoded) || LINK_OR_LOGO_WORD.test(decoded);
}

/** A `/library-links` segment anywhere in a string (not only a URL's path), followed by no more of a name. */
const LIBRARY_LINK_WORD = /\/library-links(?![a-z0-9_-])/i;

/** An `/organization-logos` segment anywhere in a string, followed by no more of a name. */
const ORGANIZATION_LOGO_WORD = /\/organization-logos(?![a-z0-9_-])/i;

/** `text` less the redacted forms themselves, so cleaning a cleaned value changes nothing. */
function withoutRedactedForms(text: string): string {
  return text.split(REDACTED_LIBRARY_LINK_PATH).join("").split(REDACTED_ORGANIZATION_LOGO_PATH).join("");
}

/**
 * Whether any string value may hold a library link: `tll_` (however spelt)
 * or a `/library-links` segment anywhere in it, as spelt or percent-decoded
 * once, or the string read as a URL would be (mayHoldLibraryLink).
 */
function valueMayHoldLibraryLink(text: string): boolean {
  return (
    [text, decodedOnce(text)].some((spelling) => LIBRARY_LINK_PREFIX.test(spelling) || LIBRARY_LINK_WORD.test(spelling)) ||
    mayHoldLibraryLink(text)
  );
}

/**
 * Whether any string value names an organization's logo: an
 * `/organization-logos` segment anywhere in it, as spelt or percent-decoded
 * once, or the string read as a request's URL would be
 * (isOrganizationLogoRequest).
 */
function valueNamesOrganizationLogo(text: string): boolean {
  return [text, decodedOnce(text)].some((spelling) => ORGANIZATION_LOGO_WORD.test(spelling)) || isOrganizationLogoRequest(text);
}

/** `text`, or its redacted form if it may hold a library link or names a logo (withoutLibraryLinksOrLogosIn). */
function withoutLibraryLinkOrLogo(text: string): string {
  if (!mayNameLinkOrLogo(text)) return text;
  const residue = withoutRedactedForms(text);
  if (valueMayHoldLibraryLink(residue)) return redactedUrl(text, REDACTED_LIBRARY_LINK_PATH);
  if (valueNamesOrganizationLogo(residue)) return redactedUrl(text, REDACTED_ORGANIZATION_LOGO_PATH);
  return text;
}

/** Resolves a relative request URL, only to read its path; never requested. */
const REQUEST_BASE = "https://relative.invalid";

/**
 * Whether a request's URL, absolute or relative, has an `/api/` segment
 * anywhere in its path, so an API base URL with a path prefix
 * (`https://host/telflo/api/v1/…`) counts too. Only the path counts: a query
 * that mentions `/api/` doesn't make a page an API request.
 */
function isApiRequest(url: string): boolean {
  try {
    return new URL(url, REQUEST_BASE).pathname.includes("/api/");
  } catch {
    return false;
  }
}

/** An `/organization-logos/` segment, or a path that ends in `/organization-logos`: a logo's public route (D23-2 decision 3). */
const ORGANIZATION_LOGO_SEGMENT = /\/organization-logos(\/|$)/i;

/** What stands for a recorded request for an organization's logo: its route, never the ids. */
const REDACTED_ORGANIZATION_LOGO_PATH = "/api/v1/organization-logos/[redacted]";

/**
 * Whether `url` (absolute or relative) is a request for an organization's
 * logo (D23-2 Ruling 145): an `/organization-logos/` segment in its path, as
 * spelt or percent-decoded once, as the browser resolves it (dot segments),
 * runs of `/` made one, as mayHoldLibraryLink reads `/library-links/`. A
 * logo's address names the organization and its logo by id, and appears
 * only as the `src` of an `<img>` inside `ph-no-capture` (Ruling 137); the
 * image's load is a request replay records once the PostHog project turns
 * network capture on, which the client doesn't pin.
 */
function isOrganizationLogoRequest(url: string): boolean {
  const beforeQuery = (url.split("#", 1)[0] ?? "").split("?", 1)[0] ?? "";
  const paths = [beforeQuery];
  try {
    paths.push(new URL(beforeQuery, REQUEST_BASE).pathname);
  } catch {
    // Not a URL: its path is read as spelt.
  }
  return paths
    .flatMap((path) => [path, decodedOnce(path)])
    .some((path) => ORGANIZATION_LOGO_SEGMENT.test(path.replace(/\/{2,}/g, "/")));
}

/**
 * Replay's addresses outside events: each recorded request's URL, and the
 * page addresses the recorder adds itself (`$url_changed`, `$pageview`).
 * A request to the API (an `/api/` segment in its path, whether the URL is
 * absolute or relative) loses its whole query and its fragment: the query
 * can hold what a member typed, such as the configurations list's search
 * (`q`, ADR 0024; D7). Any other URL loses its fragment and any `token`
 * parameter, and the flows library's address its `q`, as stripTokens does
 * (withoutTokens; a `/flows` loader would add `/flows.data?q=…`, which it
 * would then have to cover). A URL that may hold a quick-deploy link's
 * secret, a library link (D23-2 decision 55) or an API token is replaced
 * whole, as stripTokens replaces it; a request for an organization's logo
 * keeps its entry, named `/api/v1/organization-logos/[redacted]` after its
 * origin (isOrganizationLogoRequest, D23-2 Ruling 145).
 */
function withoutTokensInRequest(request: CapturedNetworkRequest): CapturedNetworkRequest {
  const { name } = request;
  if (mayHoldQuickDeploySecret(name)) return { ...request, name: redactedQuickDeployUrl(name) };
  if (mayHoldLibraryLink(name)) return { ...request, name: redactedUrl(name, REDACTED_LIBRARY_LINK_PATH) };
  if (mayHoldApiToken(name)) return { ...request, name: redactedUrl(name, REDACTED_API_TOKEN_PATH) };
  if (isOrganizationLogoRequest(name)) return { ...request, name: redactedUrl(name, REDACTED_ORGANIZATION_LOGO_PATH) };
  if (isApiRequest(name)) return { ...request, name: name.split(/[?#]/, 1)[0] ?? "" };
  return { ...request, name: withoutTokens(name) };
}

/**
 * posthog-js's options. Replay's are pinned here, since a client-side value
 * wins over the PostHog project's (Ruling 14): every input masked, all text
 * masked inside an element with `ph-mask` (the signed-in app's root and the
 * auth screens'), no request
 * headers or bodies, and no console, even if the project turns them on.
 * Each recorded request's URL loses its fragment and `token`, and, for a
 * request to the API, its whole query (withoutTokensInRequest).
 * Autocapture's masking starts as the surfaces shown so far want it
 * (setAnalyticsMasked).
 */
export function initOptions(settings: AnalyticsSettings): Partial<PostHogConfig> {
  const options: Partial<PostHogConfig> = {
    defaults: "2026-01-30",
    cookieless_mode: "on_reject",
    // Session replay must never run without explicit consent. It is
    // started on accept (and never on a local host), not here.
    disable_session_recording: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: ".ph-mask, .ph-mask *",
      recordBody: false,
      recordHeaders: false,
      maskCapturedNetworkRequestFn: withoutTokensInRequest,
    },
    enable_recording_console_log: false,
    // posthog-js's own masking of the URLs it stores for the person, with
    // `token` among the parameters it masks; stripTokens then removes them.
    // `q` too (D12 Ruling 39): posthog-js keeps the page's address, `q`
    // and all, in its own storage (`$initial_person_info`'s and
    // `$client_session_props`' `u`, in localStorage and its `ph_…` cookie),
    // which no before_send sees. Masked here, a shared `/flows?q=…` link's
    // search is never stored; it is masked on every path, and only the
    // flows library's page holds a `q` in its address. The masking matches
    // a parameter's name exactly, and leaves the stored referrer (`r`) as
    // it is.
    mask_personal_data_properties: true,
    custom_personal_data_properties: ["token", "q"],
    before_send: stripTokens,
    ...autocaptureMasking(),
  };
  if (settings.host) options.api_host = settings.host;
  return options;
}

/**
 * Whether this document's address or referrer may hold a quick-deploy
 * link's secret, a library link or an API token, or is the CLI's sign-in
 * page's, decided by its first startAnalytics;
 * undefined until then.
 */
let blocked: boolean | undefined;

/**
 * Imports and initialises posthog-js, once, and keeps capture in step with
 * the visitor's choice. Returns the cleanup for the effect that calls it.
 *
 * Never in a document whose address or referrer may hold a quick-deploy
 * link's secret (a link typed without `/api/`, `?s=tqd_…` on any page, a
 * page opened from one), a library link (`tll_` or a `/library-links/` path,
 * D23-2 decision 55), or an API token (`tf_` pasted anywhere in the
 * address, its fragment too, or in the referrer: mayHoldApiToken; D22
 * Ruling 106), nor on the CLI's sign-in page, `/cli-auth`, or `/login` with
 * a `redirectTo` naming it (isCliAuthDocument; D27 Preflight ruling 14: its
 * fragment holds the CLI's listener's state and the machine's name, and
 * replay records the sign-in buttons' links): posthog-js stores the page's address and
 * `document.referrer` in its own storage (`$initial_person_info` and
 * `$client_session_props`, in localStorage and its `ph_…` cookie) before
 * any before_send sees them. Decided once per document, at the first
 * start: a later accept, a client-side navigation to a clean page or App
 * mounted again (after a root error) never starts it. What that leaves
 * undone in such a document: a sign-out's reset (Ruling 16) isn't applied
 * (it waits for a client that never arrives, and is gone with the
 * document), and useFeatureFlag reads false (useFeatureFlagWithLoading
 * undefined, once its wait is over).
 *
 * So `/cli-auth` must stay unlinked inside the app (D27 Ruling 240): a
 * client-side navigation to it, in a document where PostHog already runs,
 * would send its path and the listener's loopback URL (never the state, the
 * host or the token: those are in the fragment of the address `telflo
 * login` opens, a new document, which this rule blocks).
 */
function startAnalytics(settings: AnalyticsSettings): () => void {
  blocked ??=
    mayHoldQuickDeploySecret(window.location.href) ||
    mayHoldQuickDeploySecret(document.referrer) ||
    mayHoldLibraryLink(window.location.href) ||
    mayHoldLibraryLink(document.referrer) ||
    mayHoldApiToken(window.location.href, { withFragment: true }) ||
    mayHoldApiToken(document.referrer, { withFragment: true }) ||
    isCliAuthDocument(window.location.href);
  if (blocked) return () => {};
  if (!started) {
    started = true;
    void import("posthog-js").then(({ default: client }) => {
      client.init(settings.key, initOptions(settings));
      // A sign-out or an ended session before the client was ready: reset
      // before anything else reaches it.
      if (resetPending) {
        resetPending = false;
        client.reset(true);
      }
      resolveClient(client);
    });
  }

  const onConsentChanged = () => withClient(syncConsent);
  onConsentChanged();
  window.addEventListener(CONSENT_CHANGED_EVENT, onConsentChanged);
  return () => window.removeEventListener(CONSENT_CHANGED_EVENT, onConsentChanged);
}

/** Root's: starts PostHog when the server passed its settings, and only then. */
export function useAnalytics(settings: AnalyticsSettings | null): void {
  const key = settings?.key;
  const host = settings?.host ?? null;
  useEffect(() => {
    if (!key) return;
    return startAnalytics({ key, host });
  }, [key, host]);
}

/** The signed-in layout's: identifies the user now if the visitor has accepted, or when they do. */
export function identifyUser(id: string, email: string): void {
  signedInUser = { id, email };
  withClient(identifyIfAccepted);
}

/**
 * This browser is signed out: the sidebar's and the terms dialog's Logout
 * (use-logout.ts), a session that ends (api-client.ts), and the invitation
 * page's Sign out. PostHog is reset, so one user's identity never carries
 * into the next person's session on a shared browser.
 *
 * `reset(true)` also gives the browser a new device id, so the next person
 * isn't linked to this one (Ruling 14). posthog-js's reset forgets the
 * opt-in too, so the stored choice is applied again: it wins. Whoever signs
 * in next is identified afresh, once the visitor has accepted.
 *
 * Before root has started PostHog, the reset waits for its init, however
 * many sign-outs come first (a page's client loader runs before root's
 * effect); without the setting it never happens, and nothing waits for a
 * client that never arrives (Ruling 16).
 */
export function signedOutLocally(): void {
  signedInUser = null;
  identifiedId = null;
  if (!started) {
    resetPending = true;
    return;
  }
  withClient((client) => {
    client.reset(true);
    syncConsent(client);
  });
}

/** Captures an event; posthog-js drops it unless the visitor has accepted. */
export function captureEvent(event: string, properties?: Record<string, unknown>): void {
  withClient((client) => client.capture(event, properties));
}

function useAnalyticsEnabled(): boolean {
  const rootData = useRouteLoaderData<{ analytics?: AnalyticsSettings | null }>("root");
  return Boolean(rootData?.analytics);
}

/**
 * A feature flag's value (ported; nothing uses it yet, D4 decision 8). Without
 * analytics every flag is on.
 * Whether analytics is on comes from root's loader, so the server and the
 * browser render the same first value.
 */
export function useFeatureFlag(flag: string): boolean {
  const enabled = useAnalyticsEnabled();
  const [flagValue, setFlagValue] = useState(!enabled);

  useEffect(() => {
    if (!enabled) return;
    withClient((posthog) => {
      // Wait for flags to load from the server before evaluating.
      // isFeatureEnabled() returns false if called before flags arrive.
      posthog.onFeatureFlags(() => {
        const value = posthog.isFeatureEnabled(flag);
        setFlagValue(value ?? false);
      });
    });
  }, [enabled, flag]);

  return flagValue;
}

export function useFeatureFlagWithLoading(flag: string): { value: string | boolean | undefined; isLoaded: boolean } {
  const enabled = useAnalyticsEnabled();
  const [state, setState] = useState<{ value: string | boolean | undefined; isLoaded: boolean }>({ value: undefined, isLoaded: false });
  useEffect(() => {
    if (!enabled) { setState({ value: undefined, isLoaded: true }); return; }
    // Timeout fallback if PostHog is blocked (e.g., ad blocker)
    const timeout = setTimeout(() => {
      setState((prev) => prev.isLoaded ? prev : { value: undefined, isLoaded: true });
    }, 3000);
    withClient((posthog) => {
      posthog.onFeatureFlags(() => {
        clearTimeout(timeout);
        setState({ value: posthog.getFeatureFlag(flag), isLoaded: true });
      });
    });
    return () => clearTimeout(timeout);
  }, [enabled, flag]);
  return state;
}
