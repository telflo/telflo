/*
 * A version's validation pipelines (D27 decision 27): route 13's list
 * (`config rules`, `test --saved`'s rule names) and route 14's replace
 * (`test --save`). Route 14's pipeline keeps its `/` (`pipelineSegment`);
 * its body is strict: `{ signal, rules }`, no pipeline `name`
 * (the older CLI's is dropped). Rules and names are configuration text: they
 * travel in these bodies only, never a URL or a message.
 */

import type {
  PublicConfigurationDetail,
  PublicReplacedValidationRules,
  PublicReplaceValidationRulesRequest,
  PublicValidationPipeline,
  PublicValidationPipelines,
} from "@telflo/contracts";
import { pipelineSegment, segment, type ApiClient } from "../api.js";

/** The configuration's latest version's number (route 5). */
export async function latestVersionNumber(client: ApiClient, configurationId: string): Promise<number> {
  const configuration = await client.request<PublicConfigurationDetail>("GET", `/configurations/${segment(configurationId)}`);
  return configuration.versionNumber;
}

function versionPath(configurationId: string, versionNumber: number): string {
  return `/configurations/${segment(configurationId)}/versions/${versionNumber}/validation-pipelines`;
}

/** Route 13: every validation pipeline on the version, oldest first, each with its rules in position order. */
export async function listValidationPipelines(
  client: ApiClient,
  configurationId: string,
  versionNumber: number,
): Promise<PublicValidationPipeline[]> {
  const reply = await client.request<PublicValidationPipelines>("GET", versionPath(configurationId, versionNumber));
  return reply.items;
}

/** Route 14: the API-owned rules on the version's `pipeline`, replaced (a person's are kept). */
export async function replaceApiOwnedRules(
  client: ApiClient,
  configurationId: string,
  versionNumber: number,
  pipeline: string,
  body: PublicReplaceValidationRulesRequest,
): Promise<PublicReplacedValidationRules> {
  return await client.request<PublicReplacedValidationRules>("PUT", `${versionPath(configurationId, versionNumber)}/${pipelineSegment(pipeline)}`, {
    body,
  });
}
