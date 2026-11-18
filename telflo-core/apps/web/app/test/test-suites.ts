import type { TestDefinition, TestSuite } from "@telflo/contracts";
import { MEMBER_ID, MINE, VERSION_ID } from "./configurations.js";

/*
 * Test suites and definitions as the API answers them (D14b detail 19), for
 * the Suites subtab's tests. Names and descriptions carrying `zq-` are the
 * private-text markers the attribute scans look for (ADR 0024).
 */

/** A suite of MINE's version 1, created by the member at noon UTC; any field overridden. */
export function testSuiteFixture(overrides: Partial<TestSuite> = {}): TestSuite {
  return {
    id: "0199f000-0000-7000-8000-000000000001",
    configurationId: MINE.id,
    versionId: VERSION_ID,
    name: "zq-smoke-tests",
    description: "zq-suite-description",
    createdByUserId: MEMBER_ID,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
}

/** A definition in that suite, of the logs pipeline, 7 s; any field overridden. */
export function testDefinitionFixture(overrides: Partial<TestDefinition> = {}): TestDefinition {
  return {
    id: "0199f100-0000-7000-8000-000000000001",
    suiteId: "0199f000-0000-7000-8000-000000000001",
    name: "zq-logs-only",
    description: "zq-definition-description",
    pipeline: "logs",
    signal: "logs",
    durationSeconds: 7,
    inputName: "zq-app-logs.json",
    createdByUserId: MEMBER_ID,
    createdAt: "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
}
