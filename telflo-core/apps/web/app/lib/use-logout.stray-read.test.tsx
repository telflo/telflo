import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Logout with the configurations list's read in flight, on a real router.
 * The client is the real one, with axios answering through a fake API, as
 * use-logout.test.tsx does; the page is the real list hook and the real
 * Logout. Logout navigates to `/login`, whose data is held, so the `/app`
 * page is still mounted when the read's stray 401 arrives, as in a browser
 * where the 401 beats `/login.data`. The list must not toast "Failed to
 * load configuration": that toast would follow the browser onto `/login`,
 * under "Logged out successfully".
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
// PostHog's reset, watched at the analytics module's boundary; the mock outlives resetModules.
const analytics = vi.hoisted(() => ({ signedOutLocally: vi.fn() }));
vi.mock("~/lib/analytics.js", () => analytics);

type Reply = { status: number; body?: unknown };
type Route = () => Reply | Promise<Reply>;

const ORGANIZATION_ID = "0190a8b0-0000-7000-8000-0000000000aa";
const CONFIGURATIONS = `GET /api/v1/organizations/${ORGANIZATION_ID}/configurations`;
const LOGOUT = "DELETE /api/v1/auth/sessions/current";

const UNAUTHENTICATED: Reply = { status: 401, body: { error: { code: "unauthenticated", message: "You need to sign in." } } };

const ORGANIZATION = { id: ORGANIZATION_ID, name: "Personal", type: "personal", logoId: null, role: "admin" } as const;
const CURRENT_USER = {
  user: { id: "0190a8b0-0000-7000-8000-0000000000bb", email: "member@example.com" },
  organization: ORGANIZATION,
  organizations: [ORGANIZATION],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
};

let routes: Record<string, Route> = {};

/** A fresh client, with axios answering through `routes` (a request's query left out of its key). */
async function loadClient() {
  vi.resetModules();
  const { default: axios, AxiosError, AxiosHeaders } = await import("axios");
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const key = `${(config.method ?? "get").toUpperCase()} ${config.baseURL ?? ""}${(config.url ?? "").split("?")[0]}`;
    const route = routes[key];
    const reply = route ? await route() : { status: 404, body: { error: { code: "not_found", message: key } } };
    const response = {
      data: reply.body === undefined ? "" : JSON.stringify(reply.body),
      status: reply.status,
      statusText: "",
      headers: new AxiosHeaders({ "content-type": "application/json" }),
      config,
      request: {},
    };
    if (config.validateStatus ? config.validateStatus(reply.status) : true) return response;
    throw new AxiosError(`Request failed with status code ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, {}, response);
  };
  axios.defaults.adapter = adapter;
  await import("./api-client.js");
}

/** A reply the test sends when it chooses. */
function held(): { route: Route; answer: (reply: Reply) => void; reached: Promise<void> } {
  let answer!: (reply: Reply) => void;
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const reply = new Promise<Reply>((resolve) => {
    answer = resolve;
  });
  return {
    route: () => {
      arrived();
      return reply;
    },
    answer,
    reached,
  };
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {};
  toast.success.mockReset();
  toast.error.mockReset();
  analytics.signedOutLocally.mockReset();
  assign = vi.fn();
  vi.stubGlobal("location", { pathname: "/app", search: "", assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Logout with the configurations list's read in flight", () => {
  it("the read's stray 401, arriving before /login's data, toasts nothing: only 'Logged out successfully', then /login", async () => {
    const read = held();
    routes[CONFIGURATIONS] = read.route;
    routes[LOGOUT] = () => ({ status: 204 });
    await loadClient();
    const { useConfigurationsList } = await import("./configurations.js");
    const { useLogout } = await import("./use-logout.js");

    let logout!: () => Promise<boolean>;
    function AppPage() {
      const list = useConfigurationsList({ search: "", filter: "all" });
      logout = useLogout();
      return <p>{list.items === null ? "app page, list loading" : `app page, ${list.items.length} configurations`}</p>;
    }
    let releaseLoginData!: () => void;
    const loginData = new Promise<void>((resolve) => {
      releaseLoginData = resolve;
    });
    const router = createMemoryRouter(
      [
        {
          id: "routes/app-layout",
          path: "/",
          loader: () => ({ status: "signed_in", currentUser: CURRENT_USER }),
          HydrateFallback: () => null,
          children: [{ path: "app", Component: AppPage }],
        },
        {
          path: "/login",
          loader: async () => {
            await loginData;
            return null;
          },
          Component: () => <p>login page</p>,
        },
      ],
      { initialEntries: ["/app"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText("app page, list loading");
    await read.reached;

    await act(async () => {
      expect(await logout()).toBe(true);
    });
    expect(toast.success).toHaveBeenCalledWith("Logged out successfully");
    expect(router.state.navigation.location?.pathname).toBe("/login");

    // The stray 401, while /login's data is still on its way: the list has handled it once it shows the empty list.
    read.answer(UNAUTHENTICATED);
    expect(await screen.findByText("app page, 0 configurations")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();

    releaseLoginData();
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledTimes(1);
    // Logout's /login, not the session-ended handler's hard load of /login?redirectTo=….
    expect(assign).not.toHaveBeenCalled();
  });
});
