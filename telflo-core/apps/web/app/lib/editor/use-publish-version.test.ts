import { describe, expect, it } from "vitest";
import { VARIABLE_REFERENCE_TOO_LONG_MESSAGE } from "@telflo/contracts";
import { ApiError } from "~/lib/api-client.js";
import { PUBLISH_FAILED_MESSAGE } from "~/lib/editor/publishing.js";
import { refusalMessage } from "./use-publish-version.js";

/*
 * The API refuses a publish whose text references an organization variable
 * name over 128 characters with 400 `invalid_request`, its details naming
 * `yaml`; the editor says why, in the contracts' fixed words. Any other 400
 * keeps the generic words.
 */

/** A detail as the API's 400s give one. */
const detailAt = (instancePath: string) => ({
  keyword: "custom",
  instancePath,
  schemaPath: `#${instancePath}/custom`,
  params: { issue: { code: "custom", path: [instancePath.slice(1)], message: "m" } },
  message: "m",
});

const invalid = (details: unknown) => new ApiError("invalid_request", "The server's words.", { status: 400, details });

describe("a publish's refusal message", () => {
  it("names the over-128 reference for a 400 invalid_request whose details name /yaml", () => {
    expect(refusalMessage(invalid([detailAt("/yaml")]), 3)).toBe(VARIABLE_REFERENCE_TOO_LONG_MESSAGE);
    expect(refusalMessage(invalid([detailAt("/label"), detailAt("/yaml")]), 3)).toBe(VARIABLE_REFERENCE_TOO_LONG_MESSAGE);
  });

  it("keeps the generic words for any other 400, and never the server's message", () => {
    for (const details of [undefined, null, [], [detailAt("/label")], [{ instancePath: 7 }], "yaml", { instancePath: "/yaml" }]) {
      expect(refusalMessage(invalid(details), 3)).toBe(PUBLISH_FAILED_MESSAGE);
    }
    expect(refusalMessage(new ApiError("internal_error", "The server's words.", { status: 500, details: [detailAt("/yaml")] }), 3)).toBe(
      PUBLISH_FAILED_MESSAGE,
    );
  });
});
