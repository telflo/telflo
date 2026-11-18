import { configure, getConfig, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import type { ComponentType } from "react";
import { Outlet, createRoutesStub, useLocation, useNavigationType } from "react-router";
import type { ApiToken, CurrentUserResponse, ServiceAccount } from "@telflo/contracts";
import { useUserStore } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";
import SettingsServiceAccountRoute from "~/routes/settings/service-accounts.$serviceAccountId.js";
import SettingsServiceAccountsRoute from "~/routes/settings/service-accounts.js";
import { GROUP_ID, MEMBER_ID, signedInMember } from "~/test/configurations.js";
import { attributesHolding } from "~/test/fleets.js";

/*
 * Settings › Service Accounts' test fixtures (D22 Task 8). A `tf_` token is
 * a secret like a bearer (decision 48): tests build it at run time (never a
 * literal: Preflight ruling 32) and never print it (Rulings 99 and 102): no
 * `getByText(token)`, no matcher whose failure prints a structure holding
 * it, no element, node or container that could hold one handed to a
 * matcher that prints it (`toBeNull`, `toBeInTheDocument`,
 * `toHaveTextContent`, `toBe(element)`…: booleans with fixed labels
 * instead, `waitUntilGone`, `showsText`), and, while one is on the page,
 * queries whose failure would print the DOM are quieted (`quietQueries`).
 */

export const ORGANIZATION_ID = GROUP_ID;
export const ACCOUNT_ID = "5a000000-0000-4000-8000-000000000001";
export const SECOND_ACCOUNT_ID = "5a000000-0000-4000-8000-000000000002";
export const TOKEN_ID = "5b000000-0000-4000-8000-000000000001";
export const SECOND_TOKEN_ID = "5b000000-0000-4000-8000-000000000002";
export const ADMIN_EMAIL = "admin@example.com";

/** A token's first three characters, kept apart so no committed text matches decision 48's redaction pattern. */
export const TOKEN_START = "tf_";

/** The signed-in member in the group organization, an admin unless `role` says. */
export function viewer(role: "admin" | "contributor" = "admin"): CurrentUserResponse {
  const member = signedInMember(GROUP_ID);
  const group = { ...member.organization, role };
  return { ...member, user: { id: MEMBER_ID, email: ADMIN_EMAIL }, organization: group, organizations: [member.organizations[0]!, group] };
}

export function serviceAccount(over: Partial<ServiceAccount> = {}): ServiceAccount {
  return {
    id: ACCOUNT_ID,
    name: "ci-pipeline",
    email: "ci-pipeline-a3f9c1e2@service-accounts.telflo.invalid",
    createdAt: "2026-09-01T12:00:00.000Z",
    createdBy: { userId: MEMBER_ID, email: ADMIN_EMAIL },
    tokenCount: 2,
    ...over,
  };
}

export function apiToken(over: Partial<ApiToken> = {}): ApiToken {
  return {
    id: TOKEN_ID,
    name: "deploy",
    prefix: `${TOKEN_START}abc12345`,
    access: "read",
    expiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-09-02T12:00:00.000Z",
    isExpired: false,
    ...over,
  };
}

/** A token as the API mints one (decision 7): `tf_` and the base64url of 32 random bytes, made now. */
export function buildApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64url = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${TOKEN_START}${base64url}`;
}

/** Whether `text` is anywhere in `value` as JSON: a boolean for a canary, never the value printed. */
export function holdsText(value: unknown, text: string): boolean {
  return JSON.stringify(value).includes(text);
}

/**
 * Waits until `find()` answers null (a dialog closed, a row gone), failing
 * with `label` alone: a matcher handed the element would print it, and it
 * may hold a token (Ruling 102).
 */
export async function waitUntilGone(find: () => Element | null, label: string): Promise<void> {
  await waitFor(() => expect(find() === null, label).toBe(true));
}

/** Whether an element holding exactly `text` is on the page: for a boolean with a fixed label (Ruling 102). */
export function showsText(text: string, root: Element = document.body): boolean {
  return [...root.querySelectorAll("*")].some((element) => element.children.length === 0 && element.textContent === text);
}

/**
 * Quiets Testing Library's failed queries: their error says what was looked
 * for and leaves out the DOM, which may hold a token (Ruling 99). Returns
 * the undo.
 */
export function quietQueries(): () => void {
  const before = getConfig().getElementError;
  configure({
    getElementError: (message) => {
      const error = new Error(message ?? "No element matched.");
      error.name = "TestingLibraryElementError";
      return error;
    },
  });
  return () => configure({ getElementError: before });
}

/**
 * The token-safe twin of `expectTextOnlyInsideNoCapture` (Preflight ruling
 * 25): fails, with fixed words and booleans only, unless `token` is shown in
 * a text node inside `ph-no-capture` and nowhere else: no text node outside
 * one, not split across nodes outside, no attribute, not the title.
 */
export function expectTokenOnlyInsideNoCapture(token: string, root: Element = document.body): void {
  let inside = 0;
  let outside = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node.textContent ?? "").includes(token)) continue;
    if (node.parentElement?.closest(".ph-no-capture")) inside += 1;
    else outside += 1;
  }
  expect(outside, "text nodes outside ph-no-capture holding the token").toBe(0);
  const clone = root.cloneNode(true) as Element;
  for (const each of clone.querySelectorAll(".ph-no-capture")) each.remove();
  expect((clone.textContent ?? "").includes(token), "the token in the text outside ph-no-capture").toBe(false);
  expect(attributesHolding(token, root).length, "attributes holding the token").toBe(0);
  expect(document.title.includes(token), "the token in the title").toBe(false);
  expect(inside, "text nodes inside ph-no-capture holding the token").toBeGreaterThan(0);
}

/** Where the router is, and how it got there. */
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

/** The router's path, search and last navigation's type ("PUSH", "REPLACE", "POP"). */
export function where(): string {
  return screen.getByTestId("where").textContent ?? "";
}

/**
 * The two Service Accounts pages at `path` under the signed-in layout, the
 * user store seeded with the viewer as the layout's effect does, `/settings`
 * and `/app` beside them.
 */
export function renderServiceAccountPages(path: string, role: "admin" | "contributor" = "admin") {
  const member = viewer(role);
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
        { path: "/settings", Component: () => <p>landed on /settings</p> },
        { path: "/settings/service-accounts", Component: SettingsServiceAccountsRoute },
        { path: "/settings/service-accounts/:serviceAccountId", Component: SettingsServiceAccountRoute },
        { path: "/app", Component: () => <p>landed on /app</p> },
      ],
    },
  ]);
  render(<Stub initialEntries={[path]} />);
  return userEvent.setup();
}

/** `Component` at `/` in a router, `/app` beside it, for a dialog's test. */
export function renderInRouter(Component: ComponentType) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <>
          <Outlet />
          <Where />
        </>
      ),
      HydrateFallback: () => null,
      children: [
        { index: true, Component },
        { path: "app", Component: () => <p>landed on /app</p> },
      ],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}
