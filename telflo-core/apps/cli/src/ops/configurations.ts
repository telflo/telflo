/*
 * The configurations' calls, on routes 4-12 with the public API's field names:
 * `versionNumber`, `publishedVersionNumber` (the highest published),
 * `distribution`, `collectorVersion`, and a version's `label`. Ids are
 * canonicalized before they're sent (exit 2 when malformed). Nothing here
 * prints; the YAML is configuration text and never reaches an error's
 * message.
 */

import { InvalidArgumentError } from "commander";
import type {
  PublicConfiguration,
  PublicConfigurationDetail,
  PublicConfigurationVersion,
  PublicConfigurationVersions,
  PublicConfigurationVersionSummary,
  PublicValidateRequest,
} from "@telflo/contracts";
import { ApiError, segment, type ApiClient } from "../api.js";
import { requireId } from "../ids.js";
import { ExitError } from "../output.js";
import { decidePushAction, latestVersion } from "./push.js";
import { rewordedError, validateConfiguration, validationErrorsOf, type ValidationErrorLine } from "./validate.js";

/** A version's number as the routes take it (the contract's `PublicVersionNumberSchema`): 1 to 999,999,999, written plainly. */
const VERSION_NUMBER = /^[1-9][0-9]{0,8}$/;

export const VERSION_NUMBER_REFUSED_MESSAGE = "expected a version number (a positive integer).";
export const PUSH_CHANGED_MESSAGE =
  "The configuration's latest version changed while it was being pushed: nothing was saved. Run telflo config push again.";
export const PUSH_UNAVAILABLE_MESSAGE = (message: string): string => `Couldn't validate the configuration, so nothing was saved: ${message}`;
export const PUSH_NOT_PUBLISHED_MESSAGE = (versionNumber: number, message: string): string =>
  `Saved v${versionNumber}, but couldn't publish it: ${message}`;

/** The 409s a push answers when another save got there first. */
const PUSH_RACE_CODES: ReadonlySet<string> = new Set(["configuration_version_changed", "configuration_version_published"]);

/** Commander's parser for `--version <n>`: a refusal is a usage error (exit 2). */
export function parseVersionNumber(value: string): number {
  if (!VERSION_NUMBER.test(value)) throw new InvalidArgumentError(VERSION_NUMBER_REFUSED_MESSAGE);
  return Number(value);
}

function configurationPath(id: string): string {
  return `/configurations/${segment(requireId(id, "configuration"))}`;
}

/** Route 4, every page (`listAll`): what the token's user can see, most recently updated first. */
export async function listConfigurations(client: ApiClient): Promise<PublicConfiguration[]> {
  return client.listAll<PublicConfiguration>("/configurations");
}

/** Route 5: one configuration with its latest version's YAML. */
export async function getConfiguration(client: ApiClient, id: string): Promise<PublicConfigurationDetail> {
  return client.request<PublicConfigurationDetail>("GET", configurationPath(id));
}

/** Route 8: every version, highest first. */
export async function listVersions(client: ApiClient, id: string): Promise<PublicConfigurationVersionSummary[]> {
  return (await client.request<PublicConfigurationVersions>("GET", `${configurationPath(id)}/versions`)).items;
}

/** Routes 5 and 8. */
export async function getConfigurationWithVersions(
  client: ApiClient,
  id: string,
): Promise<{ configuration: PublicConfigurationDetail; versions: PublicConfigurationVersionSummary[] }> {
  const configuration = await getConfiguration(client, id);
  return { configuration, versions: await listVersions(client, id) };
}

export interface PulledConfiguration {
  id: string;
  versionNumber: number;
  yaml: string;
  distribution: string;
  collectorVersion: string;
}

/** The latest version's YAML and pin (route 5), or a version's (route 10): each version carries its own pin. */
export async function pullConfiguration(client: ApiClient, id: string, versionNumber?: number): Promise<PulledConfiguration> {
  const source =
    versionNumber === undefined
      ? await getConfiguration(client, id)
      : await client.request<PublicConfigurationVersion>("GET", `${configurationPath(id)}/versions/${versionNumber}`);
  return {
    id: requireId(id, "configuration"),
    versionNumber: source.versionNumber,
    yaml: source.yaml,
    distribution: source.distribution,
    collectorVersion: source.collectorVersion,
  };
}

/** Route 6: the configuration and its draft version 1, at the catalog's default distribution. */
export async function createConfiguration(client: ApiClient, name: string, yaml: string): Promise<PublicConfigurationDetail> {
  return client.request<PublicConfigurationDetail>("POST", "/configurations", { body: { name, yaml } });
}

/** Route 12: publishes a version; answers the configuration. */
export async function publishVersion(client: ApiClient, id: string, versionNumber: number): Promise<PublicConfigurationDetail> {
  return client.request<PublicConfigurationDetail>("POST", `${configurationPath(id)}/versions/${versionNumber}/publish`);
}

export type PushResult =
  | { status: "saved"; action: "patched" | "appended"; versionNumber: number; published: boolean }
  | { status: "invalid"; errors: ValidationErrorLine[] };

/**
 * `config push`: a draft latest is patched with `?validate=true` (route
 * 11); a published latest has the text validated on its pin (route 15),
 * then appended as the next version (route 9, with `label`). Invalid YAML
 * (the validator's verdict, or a 422 `configuration_invalid`) is a returned
 * result, nothing saved; a 409 (another save first) and a 503 (nothing
 * checked) are ExitErrors, exit 1. `publish` then publishes the saved
 * version (route 12); a refusal there says the version was saved but not
 * published (exit 1).
 */
export async function pushConfiguration(
  client: ApiClient,
  id: string,
  yaml: string,
  options: { publish?: boolean; label?: string } = {},
): Promise<PushResult> {
  const versions = await listVersions(client, id);
  const action = decidePushAction(versions);
  let saved: PublicConfigurationVersion;
  try {
    if (action.kind === "patch-draft") {
      saved = await client.request<PublicConfigurationVersion>("PATCH", `${configurationPath(id)}/versions/${action.versionNumber}`, {
        query: { validate: "true" },
        body: { yaml },
      });
    } else {
      const latest = latestVersion(versions);
      const body: PublicValidateRequest =
        latest === undefined ? { yaml } : { yaml, distribution: latest.distribution, collectorVersion: latest.collectorVersion };
      const verdict = await validateConfiguration(client, body);
      if (!verdict.valid) return { status: "invalid", errors: verdict.errors };
      saved = await client.request<PublicConfigurationVersion>("POST", `${configurationPath(id)}/versions`, {
        body: { yaml, ...(options.label !== undefined && { label: options.label }) },
      });
    }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 422 && error.code === "configuration_invalid") {
        return { status: "invalid", errors: validationErrorsOf(error.details) };
      }
      if (error.status === 409 && PUSH_RACE_CODES.has(error.code ?? "")) throw rewordedError(error, () => PUSH_CHANGED_MESSAGE);
      if (error.status === 503) throw rewordedError(error, PUSH_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
  const performed = action.kind === "patch-draft" ? "patched" : "appended";
  if (options.publish === true) {
    try {
      await publishVersion(client, id, saved.versionNumber);
    } catch (error) {
      // The version is saved: say so, with the ending's own words: a 401 still exits 3 with "Run telflo login.",
      // a network failure or a timeout keeps its exit code.
      if (error instanceof ApiError || error instanceof ExitError) {
        throw rewordedError(error, (message) => PUSH_NOT_PUBLISHED_MESSAGE(saved.versionNumber, message));
      }
      // Anything else is never shown (endingOf's fixed words).
      throw error;
    }
  }
  return { status: "saved", action: performed, versionNumber: saved.versionNumber, published: options.publish === true };
}
