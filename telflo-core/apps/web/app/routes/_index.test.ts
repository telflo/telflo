import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type CurrentUserResponse } from "@telflo/contracts";
import { ApiError } from "~/lib/api-client.js";
import { fetchCurrentUser } from "~/lib/api-client.server.js";
import routes from "../routes.js";
import { loader } from "./_index.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

const SIGNED_IN_USER: CurrentUserResponse = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
  organization: { id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" },
  organizations: [{ id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" }],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

type LoaderArgs = Parameters<typeof loader>[0];

function loaderArgs(): LoaderArgs {
  return { request: new Request("http://web.example/"), params: {}, context: {} } as unknown as LoaderArgs;
}

/** What the loader threw: it never returns. */
async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => {
      throw new Error("the loader returned instead of throwing");
    },
    (caught: unknown) => caught,
  );
}

describe("/", () => {
  beforeEach(() => {
    vi.mocked(fetchCurrentUser).mockReset();
  });

  it("is routes.ts' index, no marketing page", () => {
    expect(routes.find((route) => route.index === true && route.path === undefined)?.file).toBe("routes/_index.tsx");
  });

  it.each([
    ["signed in", { status: "signed_in", currentUser: SIGNED_IN_USER } as const, "/app"],
    ["with an expired access token", { status: "refresh_needed" } as const, "/app"],
    ["signed out", { status: "signed_out" } as const, "/login"],
  ])("%s: 302 to the right page", async (_case, lookup, target) => {
    vi.mocked(fetchCurrentUser).mockResolvedValue(lookup);

    const thrown = await thrownBy(loader(loaderArgs()));

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("location")).toBe(target);
    expect(vi.mocked(fetchCurrentUser)).toHaveBeenCalledTimes(1);
  });

  it("an unreachable API throws its error for the boundary, never reading as signed out", async () => {
    const outage = new ApiError("network_error", "Could not reach the API.");
    vi.mocked(fetchCurrentUser).mockRejectedValue(outage);

    expect(await thrownBy(loader(loaderArgs()))).toBe(outage);
  });
});
