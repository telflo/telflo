import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUserResponse } from "@telflo/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Outlet, createRoutesStub, useLocation } from "react-router";
import routes from "../routes.js";
import ProductAdminRoute, { clientLoader, loader, shouldRevalidate, type ProductAdminData } from "./product-admin.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { fetchCurrentUser, fetchPendingFeedbackCount } from "~/lib/api-client.server.js";
import { signedInMember } from "~/test/configurations.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn(), fetchPendingFeedbackCount: vi.fn() }));

/*
 * Product admin's gate: the flag is checked on the server before anything
 * renders, so a non-admin is sent to /app by a 302 and never sees the
 * page, not even before a redirect.
 */

const MEMBER = signedInMember();
const PRODUCT_ADMIN: CurrentUserResponse = { ...MEMBER, isProductAdmin: true };

function loaderArgs(url: string): Parameters<typeof loader>[0] {
  return { request: new Request(url), params: {}, context: {} } as unknown as Parameters<typeof loader>[0];
}

function clientLoaderArgs(url: string, serverLoader: () => Promise<ProductAdminData>): Parameters<typeof clientLoader>[0] {
  return { request: new Request(url), params: {}, context: {}, serverLoader } as unknown as Parameters<
    typeof clientLoader
  >[0];
}

/** What `run` threw, or a failure if it resolved. */
async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => {
      throw new Error("resolved instead of throwing");
    },
    (caught: unknown) => caught,
  );
}

/** The redirect `run` threw: its status and where it goes. */
async function redirectOf(run: Promise<unknown>): Promise<{ status: number; location: string | null }> {
  const thrown = await rejectionOf(run);
  if (!(thrown instanceof Response)) throw thrown;
  return { status: thrown.status, location: thrown.headers.get("location") };
}

function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

/** The app's product-admin routes, the real loader answering from the mocked `/me`. */
function renderGate(path: string) {
  const Stub = createRoutesStub([
    {
      path: "/product-admin",
      Component: ProductAdminRoute as unknown as React.ComponentType,
      loader,
      shouldRevalidate,
      HydrateFallback: () => null,
      children: [
        { path: "user-feedback", Component: () => <p>the user feedback admin page</p> },
        { path: "test-templates", Component: () => <p>the test templates admin page</p> },
        { path: "test-regex", Component: () => <p>the test regex admin page</p> },
        { path: "library", Component: () => <p>the library admin page</p> },
        { path: "flows", Component: () => <p>the flows admin page</p> },
        { path: "users", Component: () => <p>the users admin page</p> },
        { path: "product-admins", Component: () => <p>the product admins admin page</p> },
      ],
    },
    { path: "/app", Component: Landed },
    { path: "/login", Component: Landed },
  ]);
  render(<Stub initialEntries={[path]} />);
}

describe("product admin's routes", () => {
  it("are /product-admin and its User Feedback, Test Templates, Test Regex, Library, Flows, Users and Product admins pages, under the signed-in layout", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    const productAdmin = layout?.children?.find((route) => route.path === "product-admin");
    expect(productAdmin?.file).toBe("routes/product-admin.tsx");
    expect(productAdmin?.children?.map((route) => [route.path, route.file])).toEqual([
      ["user-feedback", "routes/product-admin/user-feedback.tsx"],
      ["test-templates", "routes/product-admin/test-templates.tsx"],
      ["test-regex", "routes/product-admin/test-regex.tsx"],
      ["library", "routes/product-admin/library.tsx"],
      ["flows", "routes/product-admin/flows.tsx"],
      ["users", "routes/product-admin/users.tsx"],
      ["product-admins", "routes/product-admin/product-admins.tsx"],
    ]);
  });
});

describe("product admin's server gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchCurrentUser).mockReset();
    vi.mocked(fetchPendingFeedbackCount).mockReset();
    vi.mocked(fetchPendingFeedbackCount).mockResolvedValue({ status: "loaded", data: 0 });
  });

  it("sends a signed-in user without the flag to /app with a 302", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: MEMBER });
    const args = loaderArgs("http://localhost/product-admin/flows");

    expect(await redirectOf(loader(args))).toEqual({ status: 302, location: "/app" });
    expect(fetchCurrentUser).toHaveBeenCalledWith(args.request);
  });

  it("sends a non-admin at /product-admin itself to /app, not to Flows: the flag is checked first", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: MEMBER });

    expect(await redirectOf(loader(loaderArgs("http://localhost/product-admin")))).toEqual({
      status: 302,
      location: "/app",
    });
  });

  it("lets a product admin through, with the pending feedback's count read after the gate", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    vi.mocked(fetchPendingFeedbackCount).mockResolvedValue({ status: "loaded", data: 3 });
    const args = loaderArgs("http://localhost/product-admin/flows");

    await expect(loader(args)).resolves.toEqual({ status: "product_admin", pendingFeedback: 3 });
    expect(fetchPendingFeedbackCount).toHaveBeenCalledWith(args.request);
  });

  it("reads no count for a non-admin: the gate answers first", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: MEMBER });

    await redirectOf(loader(loaderArgs("http://localhost/product-admin/flows")));
    expect(fetchPendingFeedbackCount).not.toHaveBeenCalled();
  });

  it.each([
    ["the API's refusal", () => Promise.reject(new ApiError("product_admin_required", "Only a product admin can do that."))],
    ["an outage", () => Promise.reject(new ApiError("network_error", "Could not reach the API."))],
    ["an expired token", () => Promise.resolve({ status: "refresh_needed" as const })],
    ["a session that is over", () => Promise.resolve({ status: "signed_out" as const })],
  ])("answers a count it can't read (%s) as null, no badge, never the error boundary", async (_label, read) => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    vi.mocked(fetchPendingFeedbackCount).mockImplementation(read);

    await expect(loader(loaderArgs("http://localhost/product-admin/flows"))).resolves.toEqual({
      status: "product_admin",
      pendingFeedback: null,
    });
  });

  it("sends a product admin at /product-admin (or /product-admin/) to Flows", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });

    for (const url of ["http://localhost/product-admin", "http://localhost/product-admin/"]) {
      expect(await redirectOf(loader(loaderArgs(url)))).toEqual({ status: 302, location: "/product-admin/flows" });
    }
  });

  it("sends a visitor without a session to sign in, and back, as the signed-in layout does", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_out" });

    expect(await redirectOf(loader(loaderArgs("http://localhost/product-admin/flows?x=1")))).toEqual({
      status: 302,
      location: "/login?redirectTo=%2Fproduct-admin%2Fflows%3Fx%3D1",
    });
  });

  it("says a refresh is needed when the access token has expired", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "refresh_needed" });

    await expect(loader(loaderArgs("http://localhost/product-admin/flows"))).resolves.toEqual({
      status: "refresh_needed",
    });
  });

  it("lets an API failure reach the error boundary", async () => {
    const outage = new ApiError("network_error", "Could not reach the API.");
    vi.mocked(fetchCurrentUser).mockRejectedValue(outage);

    await expect(loader(loaderArgs("http://localhost/product-admin/flows"))).rejects.toBe(outage);
  });

  it.each([
    ["/product-admin/flows"],
    ["/product-admin/test-templates"],
    ["/product-admin/test-regex"],
    ["/product-admin/library"],
    ["/product-admin/user-feedback"],
    ["/product-admin/users"],
    ["/product-admin/product-admins"],
  ])(
    "never renders the page for a non-admin at %s: the 302 lands on /app",
    async (path) => {
      vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: MEMBER });
      renderGate(path);

      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
      expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
      expect(screen.queryByText("the flows admin page")).not.toBeInTheDocument();
      expect(screen.queryByText("the test templates admin page")).not.toBeInTheDocument();
      expect(screen.queryByText("the test regex admin page")).not.toBeInTheDocument();
      expect(screen.queryByText("the library admin page")).not.toBeInTheDocument();
      expect(screen.queryByText("the user feedback admin page")).not.toBeInTheDocument();
      expect(screen.queryByText("the users admin page")).not.toBeInTheDocument();
      expect(screen.queryByText("the product admins admin page")).not.toBeInTheDocument();
      expect(fetchPendingFeedbackCount).not.toHaveBeenCalled();
    },
  );

  it("renders the Admin Dashboard shell, with its User Feedback (and its count), Test Templates, Test Regex, Library, Flows, Users and Product admins items in that order, and the page for a product admin", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    vi.mocked(fetchPendingFeedbackCount).mockResolvedValue({ status: "loaded", data: 7 });
    renderGate("/product-admin/flows");

    expect(await screen.findByText("the flows admin page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Admin Dashboard" })).toBeInTheDocument();
    // The User Feedback item's text is its label and its badge.
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "User Feedback7",
      "Test Templates",
      "Test Regex",
      "Library",
      "Flows",
      "Users",
      "Product admins",
    ]);
  });

  it("shows a pending count of 0, and hides the badge only when the count couldn't be read", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    renderGate("/product-admin/flows");
    await screen.findByText("the flows admin page");
    const userFeedback = screen.getByRole("button", { name: /^User Feedback/ });
    expect(userFeedback.textContent).toBe("User Feedback0");
    expect(userFeedback.querySelectorAll("span:not([aria-hidden])")).toHaveLength(1);
    cleanup();

    vi.mocked(fetchPendingFeedbackCount).mockRejectedValue(new ApiError("network_error", "Could not reach the API."));
    renderGate("/product-admin/flows");
    await screen.findByText("the flows admin page");
    expect(screen.getByRole("button", { name: /^User Feedback/ }).textContent).toBe("User Feedback");
    expect(screen.getByRole("button", { name: /^User Feedback/ }).querySelector("span")).toBeNull();
  });

  it.each([
    ["User Feedback", /^User Feedback/, "the user feedback admin page"],
    ["Users", "Users", "the users admin page"],
    ["Product admins", "Product admins", "the product admins admin page"],
  ])("goes to the %s page from its nav item, marking it as the one shown", async (_label, name, page) => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    renderGate("/product-admin/flows");
    await screen.findByText("the flows admin page");

    fireEvent.click(screen.getByRole("button", { name }));

    expect(await screen.findByText(page)).toBeInTheDocument();
    expect(screen.queryByText("the flows admin page")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name }).querySelector("span[aria-hidden]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Flows" }).querySelector("span[aria-hidden]")).toBeNull();
  });

  it("goes to the Test Templates page from its nav item, marking it as the one shown", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    renderGate("/product-admin/flows");
    await screen.findByText("the flows admin page");

    fireEvent.click(screen.getByRole("button", { name: "Test Templates" }));

    expect(await screen.findByText("the test templates admin page")).toBeInTheDocument();
    expect(screen.queryByText("the flows admin page")).not.toBeInTheDocument();
    // The active item's bar.
    expect(screen.getByRole("button", { name: "Test Templates" }).querySelector("span[aria-hidden]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Flows" }).querySelector("span[aria-hidden]")).toBeNull();
  });

  it("goes to the Test Regex page from its nav item, marking it as the one shown", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    renderGate("/product-admin/flows");
    await screen.findByText("the flows admin page");

    fireEvent.click(screen.getByRole("button", { name: "Test Regex" }));

    expect(await screen.findByText("the test regex admin page")).toBeInTheDocument();
    expect(screen.queryByText("the flows admin page")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test Regex" }).querySelector("span[aria-hidden]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Test Templates" }).querySelector("span[aria-hidden]")).toBeNull();
    expect(screen.getByRole("button", { name: "Flows" }).querySelector("span[aria-hidden]")).toBeNull();
  });

  it("goes to the Library page from its nav item, marking it as the one shown", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    renderGate("/product-admin/flows");
    await screen.findByText("the flows admin page");

    fireEvent.click(screen.getByRole("button", { name: "Library" }));

    expect(await screen.findByText("the library admin page")).toBeInTheDocument();
    expect(screen.queryByText("the flows admin page")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Library" }).querySelector("span[aria-hidden]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Test Regex" }).querySelector("span[aria-hidden]")).toBeNull();
    expect(screen.getByRole("button", { name: "Flows" }).querySelector("span[aria-hidden]")).toBeNull();
  });

  it("runs again on a move to Library too: a flag cleared on Flows sends the nav to Library to /app, that page never shown", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    renderGate("/product-admin/flows");
    await screen.findByText("the flows admin page");
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: MEMBER });

    fireEvent.click(screen.getByRole("button", { name: "Library" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(screen.queryByText("the library admin page")).not.toBeInTheDocument();
    expect(fetchCurrentUser).toHaveBeenCalledTimes(2);
  });

  it("runs again on a move to Test Regex too: a flag cleared on Test Templates sends the nav to Test Regex to /app, that page never shown", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    renderGate("/product-admin/test-templates");
    await screen.findByText("the test templates admin page");
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: MEMBER });

    fireEvent.click(screen.getByRole("button", { name: "Test Regex" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(screen.queryByText("the test regex admin page")).not.toBeInTheDocument();
    expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
    expect(fetchCurrentUser).toHaveBeenCalledTimes(2);
  });

  it("runs again on every move between its pages: a flag cleared on Flows sends the nav to Test Templates to /app, that page never shown", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: PRODUCT_ADMIN });
    renderGate("/product-admin/flows");
    await screen.findByText("the flows admin page");
    // Another admin clears the flag while this one is on Flows.
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: MEMBER });

    fireEvent.click(screen.getByRole("button", { name: "Test Templates" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(screen.queryByText("the test templates admin page")).not.toBeInTheDocument();
    expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
    expect(fetchCurrentUser).toHaveBeenCalledTimes(2);
  });

  it("renders nothing while the browser refreshes an expired access token", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "refresh_needed" });
    const Stub = createRoutesStub([
      {
        // The signed-in layout's place: rendered once every loader has answered.
        Component: () => (
          <>
            <p>the shell</p>
            <Outlet />
          </>
        ),
        HydrateFallback: () => null,
        children: [
          {
            path: "/product-admin",
            Component: ProductAdminRoute as unknown as React.ComponentType,
            loader,
            children: [{ path: "flows", Component: () => <p>the flows admin page</p> }],
          },
        ],
      },
    ]);
    render(<Stub initialEntries={["/product-admin/flows"]} />);

    expect(await screen.findByText("the shell")).toBeInTheDocument();
    expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText("the flows admin page")).not.toBeInTheDocument();
  });
});

describe("product admin's client gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("runs on hydration", () => {
    expect(clientLoader.hydrate).toBe(true);
  });

  it("takes the server's yes, and its count, without asking again", async () => {
    const getCurrentUser = vi.spyOn(apiClient, "getCurrentUser");
    const getPendingFeedbackCount = vi.spyOn(apiClient, "getPendingFeedbackCount");

    await expect(
      clientLoader(
        clientLoaderArgs("http://localhost/product-admin/flows", async () => ({ status: "product_admin", pendingFeedback: 2 })),
      ),
    ).resolves.toEqual({ status: "product_admin", pendingFeedback: 2 });
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(getPendingFeedbackCount).not.toHaveBeenCalled();
  });

  it("lets the server's redirect through untouched", async () => {
    const toApp = new Response(null, { status: 302, headers: { location: "/app" } });
    const getCurrentUser = vi.spyOn(apiClient, "getCurrentUser");

    await expect(
      clientLoader(
        clientLoaderArgs("http://localhost/product-admin/flows", () => Promise.reject(toApp)),
      ),
    ).rejects.toBe(toApp);
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("after a refresh, lets a product admin through, with the count the browser client reads", async () => {
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue(PRODUCT_ADMIN);
    vi.spyOn(apiClient, "getPendingFeedbackCount").mockResolvedValue(0);

    await expect(
      clientLoader(clientLoaderArgs("http://localhost/product-admin/flows", async () => ({ status: "refresh_needed" }))),
    ).resolves.toEqual({ status: "product_admin", pendingFeedback: 0 });
  });

  it("after a refresh, answers a count it can't read as null, never the error boundary, and reads none for a non-admin", async () => {
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue(PRODUCT_ADMIN);
    const getPendingFeedbackCount = vi
      .spyOn(apiClient, "getPendingFeedbackCount")
      .mockRejectedValue(new ApiError("network_error", "Could not reach the server."));

    await expect(
      clientLoader(clientLoaderArgs("http://localhost/product-admin/flows", async () => ({ status: "refresh_needed" }))),
    ).resolves.toEqual({ status: "product_admin", pendingFeedback: null });

    getPendingFeedbackCount.mockClear();
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue(MEMBER);
    await redirectOf(
      clientLoader(clientLoaderArgs("http://localhost/product-admin/flows", async () => ({ status: "refresh_needed" }))),
    );
    expect(getPendingFeedbackCount).not.toHaveBeenCalled();
  });

  it("after a refresh, sends a user without the flag to /app", async () => {
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue(MEMBER);

    expect(
      await redirectOf(
        clientLoader(clientLoaderArgs("http://localhost/product-admin/flows", async () => ({ status: "refresh_needed" }))),
      ),
    ).toEqual({ status: 302, location: "/app" });
  });

  it("after a refresh, sends a product admin at /product-admin to Flows", async () => {
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue(PRODUCT_ADMIN);

    expect(
      await redirectOf(
        clientLoader(clientLoaderArgs("http://localhost/product-admin", async () => ({ status: "refresh_needed" }))),
      ),
    ).toEqual({ status: 302, location: "/product-admin/flows" });
  });

  it("sends a session that is over to sign in, and back", async () => {
    vi.spyOn(apiClient, "getCurrentUser").mockRejectedValue(new ApiError("unauthenticated", "Your session has ended."));

    expect(
      await redirectOf(
        clientLoader(
          clientLoaderArgs("http://localhost/product-admin/flows?x=1", async () => ({ status: "refresh_needed" })),
        ),
      ),
    ).toEqual({ status: 302, location: "/login?redirectTo=%2Fproduct-admin%2Fflows%3Fx%3D1" });
  });

  it("lets any other failure reach the error boundary", async () => {
    const outage = new ApiError("network_error", "Could not reach the server.");
    vi.spyOn(apiClient, "getCurrentUser").mockRejectedValue(outage);

    await expect(
      clientLoader(clientLoaderArgs("http://localhost/product-admin/flows", async () => ({ status: "refresh_needed" }))),
    ).rejects.toBe(outage);
  });
});
