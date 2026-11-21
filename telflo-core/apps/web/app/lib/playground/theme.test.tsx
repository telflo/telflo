import { createRoutesStub } from "react-router";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES, type Theme } from "@telflo/contracts";
import { PlaygroundThemeToggle } from "~/components/playground/PlaygroundThemeToggle.js";
import { useEditorPreferences } from "~/lib/editor/use-editor-preferences.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { rememberTheme, useAppTheme, usePageTheme } from "~/lib/theme.js";
import { PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { PLAYGROUND_HANDLE } from "./meta.js";
import { PlaygroundProvider } from "./provider.js";
import { PLAYGROUND_THEME_KEY, readPlaygroundTheme } from "./theme.js";

/*
 * The playground's theme: Light, Dark and Navy, Navy shown as Navy; the choice
 * shows at once, is kept as one word in the playground's own key and read on
 * arrival; the `telflo_theme` cookie is never written; Monaco follows it (the
 * visitor's preferences come first in `useAppTheme` and
 * `useEditorPreferences`), never a signed-in visitor's own.
 */

let seen: { page: Theme; app: Theme; monaco: string; fontSize: number } | null = null;
function Probe() {
  const page = usePageTheme();
  const app = useAppTheme();
  const { theme: monaco, options } = useEditorPreferences();
  seen = { page, app, monaco, fontSize: options.fontSize };
  return null;
}

function renderPlayground() {
  const Stub = createRoutesStub([
    {
      path: "/playground",
      handle: PLAYGROUND_HANDLE,
      Component: () => (
        <PlaygroundProvider>
          <PlaygroundThemeToggle />
          <Probe />
        </PlaygroundProvider>
      ),
    },
  ]);
  return render(<Stub initialEntries={["/playground"]} />);
}

const themeGroup = () => screen.getByRole("group", { name: "Theme" });

beforeEach(() => {
  window.localStorage.clear();
  act(() => rememberTheme("dark"));
  seen = null;
});
afterEach(() => {
  window.localStorage.clear();
  useUserStore.getState().clear();
});

describe("the toggle", () => {
  it("offers Light, Dark and Navy, the theme on screen pressed", () => {
    renderPlayground();
    const buttons = within(themeGroup()).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Light", "Dark", "Navy"]);
    expect(within(themeGroup()).getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows Navy as Navy at once, keeps one word in the playground's key, and writes no cookie", async () => {
    const user = userEvent.setup();
    const cookieBefore = document.cookie;
    renderPlayground();
    await user.click(within(themeGroup()).getByRole("button", { name: "Navy" }));
    expect(seen?.page).toBe("navy");
    expect(within(themeGroup()).getByRole("button", { name: "Navy" })).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem(PLAYGROUND_THEME_KEY)).toBe("navy");
    expect(window.localStorage.length).toBe(1);
    expect(document.cookie).toBe(cookieBefore);

    await user.click(within(themeGroup()).getByRole("button", { name: "Light" }));
    expect(seen?.page).toBe("light");
    expect(readPlaygroundTheme()).toBe("light");
  });

  it("is read on the next visit", () => {
    window.localStorage.setItem(PLAYGROUND_THEME_KEY, "navy");
    renderPlayground();
    expect(seen?.page).toBe("navy");
    expect(within(themeGroup()).getByRole("button", { name: "Navy" })).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores a stored value that isn't one of the three", () => {
    window.localStorage.setItem(PLAYGROUND_THEME_KEY, "system");
    expect(readPlaygroundTheme()).toBeNull();
    renderPlayground();
    expect(seen?.page).toBe("dark");
  });
});

describe("Monaco's theme and preferences inside the playground", () => {
  it("follow the visitor's, never a signed-in visitor's own", async () => {
    const user = userEvent.setup();
    const member = signedInMember(PERSONAL_ID);
    useUserStore.getState().setCurrent({
      ...member,
      preferences: { ...member.preferences, theme: "light", editor: { ...member.preferences.editor, fontSize: 20 } },
    });
    renderPlayground();
    expect(seen?.app).toBe("dark");
    expect(seen?.fontSize).toBe(DEFAULT_USER_PREFERENCES.editor.fontSize);
    const darkMonaco = seen?.monaco;
    await user.click(within(themeGroup()).getByRole("button", { name: "Navy" }));
    expect(seen?.app).toBe("navy");
    expect(seen?.monaco).not.toBe(darkMonaco);
  });

  it("outside the playground stay the signed-in person's", () => {
    const member = signedInMember(PERSONAL_ID);
    useUserStore.getState().setCurrent({
      ...member,
      preferences: { ...member.preferences, theme: "light", editor: { ...member.preferences.editor, fontSize: 20 } },
    });
    const { result } = renderHook(() => ({ app: useAppTheme(), preferences: useEditorPreferences() }));
    expect(result.current.app).toBe("light");
    expect(result.current.preferences.options.fontSize).toBe(20);
  });
});
