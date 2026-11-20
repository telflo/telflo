import { render, screen } from "@testing-library/react";
import { Outlet, createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountCard } from "./AccountCard.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";
import { signedInMember } from "~/test/configurations.js";
import { expectNoAttributeHolds } from "~/test/fleets.js";

/*
 * Settings › Account's first card: its words; the email is visible text,
 * never an attribute.
 */

const EMAIL = "canary-person-5f1e@example.com";

describe("AccountCard", () => {
  beforeEach(() => {
    useUserStore.getState().clear();
  });

  it("shows the email as text, and in no attribute", async () => {
    const member = { ...signedInMember(), user: { ...signedInMember().user, email: EMAIL } };
    useUserStore.getState().setCurrent(member);
    const Stub = createRoutesStub([
      {
        id: "routes/app-layout",
        Component: Outlet,
        loader: (): AppLayoutData => ({ status: "signed_in", currentUser: member }),
        HydrateFallback: () => null,
        children: [{ path: "/settings/account", Component: AccountCard }],
      },
    ]);
    render(<Stub initialEntries={["/settings/account"]} />);

    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByText("Manage your account settings")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.getByText("Your email address cannot be changed")).toBeInTheDocument();
    // Text, not a disabled input: no control holds it.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expectNoAttributeHolds(EMAIL);
    expectNoAttributeHolds("canary-person-5f1e");
  });
});
