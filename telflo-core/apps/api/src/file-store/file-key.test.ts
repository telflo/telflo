import { describe, expect, it } from "vitest";
import { fileKeyName, keyPath } from "./file-key.js";
import { InvalidFileKeyError, type FileKey } from "./file-store.js";

const ORGANIZATION = "0190f5c2-7d1a-7c4e-8a3b-1f2e3d4c5b6a";
const USER = "0190f5c2-7d1a-7c4e-8a3b-2f2e3d4c5b6a";
const FILE = "0190f5c2-7d1a-7c4e-8a3b-3f2e3d4c5b6a";
const RUN = "0190f5c2-7d1a-7c4e-8a3b-4f2e3d4c5b6a";
const TEMPLATE = "0190f5c2-7d1a-7c4e-8a3b-5f2e3d4c5b6a";
const DEFINITION_INPUT = "0190f5c2-7d1a-7c4e-8a3b-6f2e3d4c5b6a";
const LOGO = "0190f5c2-7d1a-7c4e-8a3b-7f2e3d4c5b6a";
const LIBRARY_FILE = "0190f5c2-7d1a-7c4e-8a3b-8f2e3d4c5b6a";

describe("fileKeyName (D23-1 decision 17)", () => {
  const cases: [string, FileKey, string][] = [
    [
      "a person's test input",
      { kind: "test-input", organizationId: ORGANIZATION, userId: USER, fileId: FILE },
      `organizations/${ORGANIZATION}/users/${USER}/test-inputs/${FILE}`,
    ],
    [
      "a run's input",
      { kind: "test-run", organizationId: ORGANIZATION, runId: RUN, name: "input" },
      `organizations/${ORGANIZATION}/test-runs/${RUN}/input`,
    ],
    [
      "a run's output",
      { kind: "test-run", organizationId: ORGANIZATION, runId: RUN, name: "output" },
      `organizations/${ORGANIZATION}/test-runs/${RUN}/output`,
    ],
    [
      "a run's decoded input",
      { kind: "test-run", organizationId: ORGANIZATION, runId: RUN, name: "decoded-input" },
      `organizations/${ORGANIZATION}/test-runs/${RUN}/decoded-input`,
    ],
    ["a test template", { kind: "test-template", templateId: TEMPLATE }, `global/test-templates/${TEMPLATE}`],
    [
      "a test definition's input",
      { kind: "test-definition-input", organizationId: ORGANIZATION, inputId: DEFINITION_INPUT },
      `organizations/${ORGANIZATION}/test-definition-inputs/${DEFINITION_INPUT}`,
    ],
    [
      "an organization's logo (D23-2 decision 30)",
      { kind: "organization-logo", organizationId: ORGANIZATION, logoId: LOGO },
      `organizations/${ORGANIZATION}/logos/${LOGO}`,
    ],
    [
      "a library file (D23-2 decision 30)",
      { kind: "library-file", fileId: LIBRARY_FILE },
      `global/library-files/${LIBRARY_FILE}`,
    ],
  ];

  it.each(cases)("names %s by its segments and file name, joined by /", (_name, key, name) => {
    expect(fileKeyName(key)).toBe(name);
    const { directorySegments, fileName } = keyPath(key);
    expect(name).toBe([...directorySegments, fileName].join("/"));
  });

  it("refuses a key keyPath refuses, with the same error", () => {
    const bad: FileKey = { kind: "test-input", organizationId: ORGANIZATION, userId: USER, fileId: "../x" };
    expect(() => fileKeyName(bad)).toThrow(InvalidFileKeyError);
    expect(() => fileKeyName(bad)).toThrow("The file key's fileId is not a canonical lower-case UUID.");
    expect(() => fileKeyName({ kind: "unplanned-kind" } as unknown as FileKey)).toThrow(InvalidFileKeyError);
  });

  it("refuses a logo or a library file whose id isn't a canonical lower-case UUID (D23-2 decision 30)", () => {
    const badLogo: FileKey = { kind: "organization-logo", organizationId: ORGANIZATION, logoId: LOGO.toUpperCase() };
    expect(() => fileKeyName(badLogo)).toThrow("The file key's logoId is not a canonical lower-case UUID.");
    const badOrganization: FileKey = { kind: "organization-logo", organizationId: "../x", logoId: LOGO };
    expect(() => fileKeyName(badOrganization)).toThrow(
      "The file key's organizationId is not a canonical lower-case UUID.",
    );
    const badFile: FileKey = { kind: "library-file", fileId: `${LIBRARY_FILE}/x` };
    expect(() => fileKeyName(badFile)).toThrow("The file key's fileId is not a canonical lower-case UUID.");
  });
});
