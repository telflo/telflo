import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AccountSession, CurrentUserResponse, SignInMethodsResponse } from "@telflo/contracts";
import type { ComponentType } from "react";
import { Outlet, createRoutesStub, useLocation, useNavigationType } from "react-router";
import { useUserStore } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";
import { signedInMember } from "~/test/configurations.js";

/*
 * Settings › Account's test fixtures. The personal data are canaries: a test
 * looks for them in every attribute, the URL, the toasts and browser storage.
 */

export const ACCOUNT_EMAIL = "canary-owner-3b7d@example.com";
export const IDENTITY_EMAIL = "canary-google-9c4a@example.com";
export const SESSION_IP = "203.0.113.77";
export const OTHER_SESSION_IP = "2001:db8::4c1";
export const CURRENT_SESSION_ID = "00000000-0000-4000-8000-0000000000a1";
export const OTHER_SESSION_ID = "00000000-0000-4000-8000-0000000000a2";

export const GOOGLE = { id: "google", name: "Google" } as const;

/** The member, with the canary email. */
export function accountMember(): CurrentUserResponse {
  const member = signedInMember();
  return { ...member, user: { ...member.user, email: ACCOUNT_EMAIL } };
}

/** Sign-in methods: a password and Google configured, nothing linked, unless `over` says. */
export function signInMethods(over: Partial<SignInMethodsResponse> = {}): SignInMethodsResponse {
  return { hasPassword: true, identities: [], providers: [GOOGLE], ...over };
}

/** Google linked as the canary identity email; Google re-links by email. */
export const LINKED_GOOGLE = {
  provider: "google",
  email: IDENTITY_EMAIL,
  linkedAt: "2026-10-09T12:00:00.000Z",
  relinksByEmail: true,
};

/** This browser's session (Firefox on macOS) and another (Chrome on Windows). */
export function sessions(): AccountSession[] {
  return [
    {
      id: CURRENT_SESSION_ID,
      isCurrent: true,
      signedInAt: "2026-10-20T09:15:05.000Z",
      lastActiveAt: "2026-10-22T10:00:00.000Z",
      ipAddress: SESSION_IP,
      browser: "firefox",
      os: "macos",
    },
    {
      id: OTHER_SESSION_ID,
      isCurrent: false,
      signedInAt: "2026-10-18T14:30:45.000Z",
      lastActiveAt: "2026-10-21T08:00:00.000Z",
      ipAddress: OTHER_SESSION_IP,
      browser: "chrome",
      os: "windows",
    },
  ];
}

/** A promise answered by hand. */
export function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Where the router is, and how it got there: for `replace` checks. */
function Where() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <p data-testid="where">
      {location.pathname}
      {location.search} {type}
    </p>
  );
}

/**
 * `Page` at `path` under the signed-in layout (as the app routes it), the
 * user store seeded with the canary member as the layout's effect does, and
 * `/login` beside it.
 */
export function renderUnderLayout(Page: ComponentType, path = "/settings/account") {
  const member = accountMember();
  useUserStore.getState().setCurrent(member);
  const Stub = createRoutesStub([
    {
      id: "routes/app-layout",
      Component: () => (
        <>
          <Outlet />
          <Where />
        </>
      ),
      loader: (): AppLayoutData => ({ status: "signed_in", currentUser: member }),
      HydrateFallback: () => null,
      children: [
        { path: "/settings/account", Component: Page },
        { path: "/login", Component: () => <p>landed on /login</p> },
      ],
    },
  ]);
  render(<Stub initialEntries={[path]} />);
  return userEvent.setup();
}

/** The router's path, search and last navigation's type ("PUSH", "REPLACE", "POP"). */
export function where(): string {
  return screen.getByTestId("where").textContent ?? "";
}
