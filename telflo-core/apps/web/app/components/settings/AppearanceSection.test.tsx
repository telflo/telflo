import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { Outlet, createRoutesStub } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type Theme, type UserPreferences } from "@telflo/contracts";
import { AppearanceSection } from "./AppearanceSection.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { PREFERENCES_FAILED_MESSAGE } from "~/lib/preferences.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { themeClassName, usePageTheme } from "~/lib/theme.js";
import type { AppLayoutData } from "~/routes/app-layout.js";
import { signedInMember } from "~/test/configurations.js";

/*
 * Settings › Appearance (D21 decisions 24, 30 and 33; Preflight rulings 35,
 * 36 and 48): its words and swatches; a choice shows at once, is
 * saved on its own, and revalidates the signed-in layout; a failure restores
 * the previous theme.
 */

/** A promise answered by hand. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function member(theme: Theme) {
  const signedIn = signedInMember();
  return { ...signedIn, preferences: { ...signedIn.preferences, theme } };
}

/** `<html>`'s class from the page's theme, as root's `Layout` puts it there. */
function HtmlClass() {
  const theme = usePageTheme();
  useLayoutEffect(() => {
    document.documentElement.className = themeClassName(theme);
  }, [theme]);
  return <Outlet />;
}

const layoutLoader = vi.fn((): AppLayoutData => ({ status: "signed_in", currentUser: member("dark") }));

/** Appearance under root and the signed-in layout, the store seeded from it as the layout's effect does. */
async function renderAppearance(theme: Theme = "dark") {
  layoutLoader.mockImplementation(() => ({ status: "signed_in", currentUser: member(theme) }));
  useUserStore.getState().setCurrent(member(theme));
  const Stub = createRoutesStub([
    {
      id: "root",
      Component: HtmlClass,
      loader: () => ({ theme: "dark" }),
      HydrateFallback: () => null,
      children: [
        {
          id: "routes/app-layout",
          Component: Outlet,
          loader: layoutLoader,
          children: [{ path: "/settings/appearance", Component: AppearanceSection }],
        },
      ],
    },
  ]);
  render(<Stub initialEntries={["/settings/appearance"]} />);
  await screen.findByRole("button", { name: "Light" });
  return userEvent.setup();
}

function answer(theme: Theme): UserPreferences {
  return { ...DEFAULT_USER_PREFERENCES, theme };
}

function pressed(): string[] {
  return screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent ?? "");
}

describe("AppearanceSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    layoutLoader.mockClear();
    document.documentElement.className = "";
  });

  afterEach(() => {
    document.documentElement.className = "";
  });

  it("shows its words and the three swatches", async () => {
    await renderAppearance();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByText("Choose between the light, dark, and navy themes")).toBeInTheDocument();
    const swatches = ["Light", "Dark", "Navy"].map((name) => screen.getByRole("button", { name }));
    expect(swatches.map((swatch) => swatch.querySelector("div")?.className)).toEqual([
      expect.stringContaining("bg-[#f5f6f8]"),
      expect.stringContaining("bg-[#101317]"),
      expect.stringContaining("bg-[#0c1524]"),
    ]);
  });

  it("the current theme's swatch is pressed", async () => {
    await renderAppearance("navy");
    expect(pressed()).toEqual(["Navy"]);
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.className).toBe("dark navy");
  });

  it("a choice changes html's class at once and saves", async () => {
    const save = held<UserPreferences>();
    const updatePreferences = vi.spyOn(apiClient, "updatePreferences").mockReturnValue(save.promise);
    const success = vi.spyOn(toast, "success");
    const user = await renderAppearance("dark");
    expect(document.documentElement.className).toBe("dark");
    const loadsBefore = layoutLoader.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Light" }));
    // Before the API answers: the page is Light, its swatch pressed.
    expect(document.documentElement.className).toBe("");
    expect(pressed()).toEqual(["Light"]);
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).toHaveBeenCalledWith({ theme: "light" }, { signal: expect.any(AbortSignal) });
    expect(layoutLoader.mock.calls.length).toBe(loadsBefore);

    layoutLoader.mockImplementation(() => ({ status: "signed_in", currentUser: member("light") }));
    save.resolve(answer("light"));
    // The answer taken, the signed-in layout is revalidated (Preflight ruling 36).
    await waitFor(() => expect(layoutLoader.mock.calls.length).toBeGreaterThan(loadsBefore));
    expect(useUserStore.getState().confirmedPreferences?.theme).toBe("light");
    expect(document.documentElement.className).toBe("");
    expect(success).not.toHaveBeenCalled();
  });

  it("a refusal restores the previous theme and toasts the fixed words", async () => {
    const save = held<UserPreferences>();
    vi.spyOn(apiClient, "updatePreferences").mockReturnValue(save.promise);
    const error = vi.spyOn(toast, "error");
    const user = await renderAppearance("navy");
    const loadsBefore = layoutLoader.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.className).toBe("dark");

    save.reject(new ApiError("invalid_request", "The request is invalid."));
    await waitFor(() => expect(document.documentElement.className).toBe("dark navy"));
    expect(pressed()).toEqual(["Navy"]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(PREFERENCES_FAILED_MESSAGE);
    expect(PREFERENCES_FAILED_MESSAGE).toBe("Failed to update preferences");
    expect(layoutLoader.mock.calls.length).toBe(loadsBefore);
  });

  it("a network failure restores it too", async () => {
    vi.spyOn(apiClient, "updatePreferences").mockRejectedValue(new ApiError("network_error", "The network failed."));
    const error = vi.spyOn(toast, "error");
    const user = await renderAppearance("light");

    await user.click(screen.getByRole("button", { name: "Navy" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(PREFERENCES_FAILED_MESSAGE));
    expect(document.documentElement.className).toBe("");
    expect(pressed()).toEqual(["Light"]);
  });

  it("the pressed swatch saves nothing", async () => {
    const updatePreferences = vi.spyOn(apiClient, "updatePreferences");
    const user = await renderAppearance("dark");
    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(updatePreferences).not.toHaveBeenCalled();
  });
});
