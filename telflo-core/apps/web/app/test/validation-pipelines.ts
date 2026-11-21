import type { ValidationPipeline, ValidationRule } from "@telflo/contracts";
import { MEMBER_ID, MINE, VERSION_ID } from "./configurations.js";

/*
 * Validation pipelines and rules as the API answers them, for the
 * Validation subtab's tests. Names, descriptions, patterns and OTTL
 * carrying `zq` are the private-text markers the attribute scans look for.
 */

/** The logs pipeline's validation pipeline on MINE's version 1, created by the member at noon UTC; any field overridden. */
export function validationPipelineFixture(overrides: Partial<ValidationPipeline> = {}): ValidationPipeline {
  return {
    id: "0199f300-0000-7000-8000-000000000001",
    configurationId: MINE.id,
    versionId: VERSION_ID,
    pipeline: "logs",
    signal: "logs",
    createdByUserId: MEMBER_ID,
    createdAt: "2026-10-11T12:00:00.000Z",
    ...overrides,
  };
}

/** A "Does not contain" text rule, first in that pipeline, named; any field overridden. */
export function validationRuleFixture(overrides: Partial<ValidationRule> = {}): ValidationRule {
  return {
    id: "0199f400-0000-7000-8000-000000000001",
    validationPipelineId: "0199f300-0000-7000-8000-000000000001",
    position: 1,
    kind: "not_contains_text",
    target: "output",
    pattern: "zq-secret-token",
    ottl: null,
    name: "zq-no-secrets",
    description: "zq-rule-description",
    createdByUserId: MEMBER_ID,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    ...overrides,
  };
}
