import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type CurrentUserResponse, type Theme } from "@telflo/contracts";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, Outlet, createRoutesStub } from "react-router";
import {
  pageTheme,
  rememberTheme,
  themeClassName,
  useAppTheme,
  usePageTheme,
  useRememberedTheme,
  useSignedInTheme,
  type PageThemeInputs,
} from "./theme.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import AppLayoutRoute, { type AppLayoutData } from "~/routes/app-layout.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION = { id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" } as const;

function signedIn(theme: Theme, userId = USER_ID): CurrentUserResponse {
  return {
    user: { id: userId, email: "person@example.com" },
    organization: ORGANIZATION,
    organizations: [ORGANIZATION],
    termsAcceptanceRequired: false,
    isProductAdmin: false,
    mayCreateOrganizations: true,
    preferences: { ...DEFAULT_USER_PREFERENCES, theme },
  };
}

/** Every input at its "nothing" value; each case sets what its row reads. */
const NOTHING: PageThemeInputs = { layout: undefined, signedIn: null, remembers: false, cookie: undefined, remembered: null };

describe("themeClassName", () => {
  it("maps light, dark and navy to no class, dark and dark navy", () => {
    expect(themeClassName("light")).toBe("");
    expect(themeClassName("dark")).toBe("dark");
    expect(themeClassName("navy")).toBe("dark navy");
  });
});

describe("pageTheme's table, row by row", () => {
  it("under the signed-in layout, signed_in: the signed-in theme, whatever the cookie and the remembered value", () => {
    // On the server (nothing remembered) and on the client alike.
    expect(pageTheme({ ...NOTHING, layout: "signed_in", signedIn: "navy", cookie: "light" })).toBe("navy");
    expect(pageTheme({ ...NOTHING, layout: "signed_in", signedIn: "light", cookie: "navy", remembered: "dark" })).toBe("light");
  });

  it("under the signed-in layout, refresh_needed: the cookie's, then the stored theme once /me answers", () => {
    // The server, and the client until the client loader's /me answers.
    expect(pageTheme({ ...NOTHING, layout: "refresh_needed", cookie: "light" })).toBe("light");
    expect(pageTheme({ ...NOTHING, layout: "refresh_needed", cookie: "light", remembered: "navy" })).toBe("light");
    expect(pageTheme({ ...NOTHING, layout: "refresh_needed" })).toBe(DEFAULT_USER_PREFERENCES.theme);
    // The answer makes the layout signed_in.
    expect(pageTheme({ ...NOTHING, layout: "signed_in", signedIn: "navy", cookie: "light" })).toBe("navy");
  });

  it("an auth screen: the remembered value if set, else the cookie's", () => {
    // The server, and hydration: nothing remembered.
    expect(pageTheme({ ...NOTHING, remembers: true, cookie: "navy" })).toBe("navy");
    // The client after a navigation.
    expect(pageTheme({ ...NOTHING, remembers: true, cookie: "navy", remembered: "light" })).toBe("light");
    // Root's loader didn't answer.
    expect(pageTheme({ ...NOTHING, remembers: true })).toBe(DEFAULT_USER_PREFERENCES.theme);
  });

  it("anything else: dark, whatever the cookie and the remembered value", () => {
    expect(pageTheme({ ...NOTHING, cookie: "light", remembered: "navy" })).toBe("dark");
    expect(pageTheme(NOTHING)).toBe("dark");
  });
});

describe("useSignedInTheme", () => {
  beforeEach(() => {
    useUserStore.getState().clear();
  });

  it("is the stored theme until the store holds this user, then the store's", () => {
    const { result, rerender } = renderHook(({ user }) => useSignedInTheme(user), {
      initialProps: { user: signedIn("navy") as CurrentUserResponse | null },
    });
    expect(result.current).toBe("navy");

    // Another user's store (a sign-out and a sign-in without a reload) isn't read.
    act(() => useUserStore.getState().setCurrent(signedIn("light", "00000000-0000-4000-8000-000000000009")));
    expect(result.current).toBe("navy");

    // This user's store, with an optimistic choice in it.
    act(() => useUserStore.getState().setCurrent(signedIn("light")));
    expect(result.current).toBe("light");

    rerender({ user: null });
    expect(result.current).toBeNull();
  });
});

describe("useAppTheme (no router)", () => {
  beforeEach(() => {
    useUserStore.getState().clear();
  });

  it("is contracts' default before the store is seeded, then the store's", () => {
    const { result } = renderHook(() => useAppTheme());
    expect(result.current).toBe(DEFAULT_USER_PREFERENCES.theme);

    act(() => useUserStore.getState().setCurrent(signedIn("navy")));
    expect(result.current).toBe("navy");
  });
});

describe("usePageTheme in a router", () => {
  beforeEach(() => {
    useUserStore.getState().clear();
  });

  function PageTheme() {
    return <p>theme: {usePageTheme()}</p>;
  }

  it("reads the matches, root's cookie theme and the layout's stored theme", async () => {
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => ({ theme: "light" }),
        HydrateFallback: () => null,
        Component: () => (
          <>
            <PageTheme />
            <Link to="/login">Login</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/app">App</Link>
            <Outlet />
          </>
        ),
        children: [
          { path: "/login", handle: { theme: "remembered" }, Component: () => <h1>login</h1> },
          { path: "/pricing", Component: () => <h1>pricing</h1> },
          {
            id: "routes/app-layout",
            loader: (): AppLayoutData => ({ status: "signed_in", currentUser: signedIn("navy") }),
            Component: Outlet,
            children: [{ path: "/app", Component: () => <h1>app</h1> }],
          },
        ],
      },
    ]);
    render(<Stub initialEntries={["/login"]} />);
    const user = userEvent.setup();

    // Nothing remembered yet in this file: the cookie's.
    expect(await screen.findByRole("heading", { name: "login" })).toBeInTheDocument();
    expect(screen.getByText(/^theme:/)).toHaveTextContent("theme: light");

    await user.click(screen.getByRole("link", { name: "Pricing" }));
    expect(await screen.findByRole("heading", { name: "pricing" })).toBeInTheDocument();
    expect(screen.getByText(/^theme:/)).toHaveTextContent("theme: dark");

    await user.click(screen.getByRole("link", { name: "App" }));
    expect(await screen.findByRole("heading", { name: "app" })).toBeInTheDocument();
    expect(screen.getByText(/^theme:/)).toHaveTextContent("theme: navy");

    // The signed-in layout remembers (routes/app-layout.tsx's effect); here it is done by hand.
    act(() => rememberTheme("navy"));
    await user.click(screen.getByRole("link", { name: "Login" }));
    expect(await screen.findByRole("heading", { name: "login" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/^theme:/)).toHaveTextContent("theme: navy"));
  });
});

describe("the remembered value", () => {
  function Remembered({ seen }: { seen: Array<Theme | null> }) {
    const remembered = useRememberedTheme();
    seen.push(remembered);
    return <p>remembered: {remembered ?? "none"}</p>;
  }

  it("is null during a server render and hydration, then the remembered theme", async () => {
    act(() => rememberTheme("light"));
    act(() => rememberTheme("navy"));

    const html = renderToString(<Remembered seen={[]} />);
    expect(html).toContain("remembered: <!-- -->none");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const seen: Array<Theme | null> = [];
    const recoverable: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, <Remembered seen={seen} />, { onRecoverableError: (error) => recoverable.push(error) });
    });

    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toBe("navy");
    expect(container).toHaveTextContent("remembered: navy");
    expect(recoverable).toEqual([]);
    container.remove();
  });
});

describe("browser storage", () => {
  it("the remembered value is never put in browser storage", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      act(() => rememberTheme("light"));
      act(() => rememberTheme("navy"));

      // The signed-in layout's remembering path: its effect remembers the stored theme.
      const Stub = createRoutesStub([
        {
          id: "routes/app-layout",
          Component: AppLayoutRoute as unknown as React.ComponentType,
          loader: (): AppLayoutData => ({ status: "signed_in", currentUser: signedIn("light") }),
          HydrateFallback: () => null,
          children: [{ path: "/app", Component: () => <p>remembered: {useRememberedTheme() ?? "none"}</p> }],
        },
      ]);
      render(<Stub initialEntries={["/app"]} />);
      expect(await screen.findByText("remembered: light")).toBeInTheDocument();

      expect(setItem).not.toHaveBeenCalled();
      expect(localStorage).toHaveLength(0);
      expect(sessionStorage).toHaveLength(0);
    } finally {
      setItem.mockRestore();
    }
  });
});
