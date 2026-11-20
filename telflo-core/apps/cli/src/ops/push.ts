/*
 * What `telflo config push` does with a configuration's versions (this
 * file keeps `decidePushAction` only, `resolveDeployTarget` is
 * `ops/deploy.ts`'). The latest version decides: a draft is edited in
 * place (a published version never changes), a published latest means the
 * text becomes a new version.
 */

import type { PublicConfigurationVersionSummary } from "@telflo/contracts";

export type VersionRef = Pick<PublicConfigurationVersionSummary, "versionNumber" | "status">;

export type PushAction = { kind: "patch-draft"; versionNumber: number } | { kind: "append" };

/** The latest version: the highest number (route 8 lists them highest first; the number decides, not the order). */
export function latestVersion<T extends VersionRef>(versions: readonly T[]): T | undefined {
  let latest: T | undefined;
  for (const version of versions) if (latest === undefined || version.versionNumber > latest.versionNumber) latest = version;
  return latest;
}

/** A draft latest is patched; a published latest (or none) appends a new version. */
export function decidePushAction(versions: readonly VersionRef[]): PushAction {
  const latest = latestVersion(versions);
  if (latest !== undefined && latest.status === "draft") return { kind: "patch-draft", versionNumber: latest.versionNumber };
  return { kind: "append" };
}
