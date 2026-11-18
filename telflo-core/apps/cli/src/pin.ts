/*
 * The collector a stored configuration's version is pinned to
 * (routes 5 and 8): so a local file is validated
 * or tested on exactly what the configuration runs (`validate --config`,
 * `config push`, `test --config`). Without a version number, the latest
 * version's pin (route 5's `collectorVersion`); with one, that version's
 * (route 8's list). The platform's versions always carry both fields.
 */

import type { PublicConfigurationDetail, PublicConfigurationVersions } from "@telflo/contracts";
import { segment, type ApiClient } from "./api.js";
import { requireId } from "./ids.js";
import { EXIT, ExitError, terminalText } from "./output.js";

export interface CollectorPin {
  collectorVersion: string;
  distribution: string;
  /** Which stored version the pin came from. */
  versionNumber: number;
}

export const NO_SUCH_VERSION_MESSAGE = (configurationId: string, versionNumber: number): string =>
  `Configuration ${configurationId} has no version ${versionNumber}.`;

/** The pin of a configuration's latest version, or of `versionNumber`. The id is canonicalized first (exit 2 if malformed). */
export async function resolvePin(client: ApiClient, configurationId: string, versionNumber?: number): Promise<CollectorPin> {
  const id = requireId(configurationId, "configuration");
  if (versionNumber === undefined) {
    const configuration = await client.request<PublicConfigurationDetail>("GET", `/configurations/${segment(id)}`);
    return {
      collectorVersion: configuration.collectorVersion,
      distribution: configuration.distribution,
      versionNumber: configuration.versionNumber,
    };
  }
  const versions = await client.request<PublicConfigurationVersions>("GET", `/configurations/${segment(id)}/versions`);
  const version = versions.items.find((item) => item.versionNumber === versionNumber);
  if (version === undefined) throw new ExitError(NO_SUCH_VERSION_MESSAGE(id, versionNumber), EXIT.API);
  return { collectorVersion: version.collectorVersion, distribution: version.distribution, versionNumber };
}

/** The human words: "otelcol-contrib 0.120.0" (both the server's strings, through terminalText). */
export function describePin(pin: Pick<CollectorPin, "collectorVersion" | "distribution">): string {
  return `${terminalText(pin.distribution)} ${terminalText(pin.collectorVersion)}`;
}
