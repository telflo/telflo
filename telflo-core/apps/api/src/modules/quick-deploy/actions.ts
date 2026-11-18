/*
 * The quick-deploy links' audit actions (D17c-2 decision 9, Preflight
 * ruling 13). Each row names ids (the link's, the fleet's, the group's),
 * the method, the arch, the systemd choice, the preset or the requester's
 * address and user agent: never the secret, its hash, a path, a variable's
 * name or a value.
 */

/**
 * A member made a link (the create's transaction): a Linux link's `{linkId,
 * fleetId, groupId, method, arch, systemd}`, a Helm values link's `{linkId,
 * fleetId, groupId, kind: "helm"}` (D17d-2: never its release or namespace).
 */
export const QUICK_DEPLOY_LINK_CREATED = "quick_deploy_link.created";
/** A member extended a link: `{linkId, fleetId, by, expiresAt}`. */
export const QUICK_DEPLOY_LINK_EXTENDED = "quick_deploy_link.extended";
/** A member revoked a link, every revoke asked (a repeat's too): `{linkId, fleetId}`. */
export const QUICK_DEPLOY_LINK_REVOKED = "quick_deploy_link.revoked";
/**
 * Whoever held the link downloaded it (no actor; the counter's transaction,
 * after the build): a Linux link's `{linkId, fleetId, groupId, method,
 * arch}`, a Helm values link's `{linkId, fleetId, groupId, kind: "helm"}`.
 */
export const QUICK_DEPLOY_LINK_DOWNLOADED = "quick_deploy_link.downloaded";

/** The audit rows' subject type. */
export const QUICK_DEPLOY_LINK_SUBJECT = "quick_deploy_link";
