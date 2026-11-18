import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES, type CurrentUserResponse, type UserPreferences } from "@telflo/contracts";
import { PREFERENCE_KEYS, numberPreferenceRead, readPreference, useUserStore, withPreference } from "./user-store.js";

const currentUser: CurrentUserResponse = {
  user: { id: "0b9f4e0e-6f55-4a8e-9d1c-2f3a4b5c6d7e", email: "person@example.com" },
  organization: { id: "5d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d", name: "Acme", type: "personal", logoId: null, role: "admin" },
  organizations: [{ id: "5d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d", name: "Acme", type: "personal", logoId: null, role: "admin" }],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

beforeEach(() => {
  useUserStore.getState().clear();
});

describe("useUserStore", () => {
  it("starts signed out", () => {
    expect(useUserStore.getState().current).toBeNull();
  });

  it("sets the current user, without the terms flag, which stays in the layout's data", () => {
    // A whole `/me` answer, as the layout passes it.
    const fromMe: CurrentUserResponse = { ...currentUser, termsAcceptanceRequired: true };
    useUserStore.getState().setCurrent(fromMe);
    const { termsAcceptanceRequired: _flag, ...stored } = currentUser;
    expect(useUserStore.getState().current).toEqual(stored);
  });

  it("keeps the product-admin flag, which the layout re-seeds when it changes (D12 decision 3)", () => {
    useUserStore.getState().setCurrent({ ...currentUser, isProductAdmin: true });
    expect(useUserStore.getState().current?.isProductAdmin).toBe(true);
    useUserStore.getState().setCurrent(currentUser);
    expect(useUserStore.getState().current?.isProductAdmin).toBe(false);
  });

  it("keeps the preferences from /me (D21 decision 20)", () => {
    const preferences = {
      theme: "navy",
      editor: { tabSize: 4, fontSize: 16, lineNumbers: false, minimap: true },
      email: { productUpdates: false, productTips: true },
    } as const;
    useUserStore.getState().setCurrent({ ...currentUser, preferences });
    expect(useUserStore.getState().current?.preferences).toEqual(preferences);
    useUserStore.getState().setCurrent(currentUser);
    expect(useUserStore.getState().current?.preferences).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it("clears the current user", () => {
    useUserStore.getState().setCurrent(currentUser);
    useUserStore.getState().clear();
    expect(useUserStore.getState().current).toBeNull();
  });

  it("clears the current user and the switching flag", () => {
    useUserStore.getState().setCurrent(currentUser);
    useUserStore.getState().setSwitchingOrganization(true);
    useUserStore.getState().clear();
    expect(useUserStore.getState().current).toBeNull();
    expect(useUserStore.getState().isSwitchingOrganization).toBe(false);
  });

  it("lists a created organization after the others, leaving the active one", () => {
    useUserStore.getState().setCurrent(currentUser);
    const created = { id: "7e6d5c4b-3a2f-4e1d-8c0b-9a8f7e6d5c4b", name: "Group", type: "group", logoId: null, role: "admin" } as const;
    useUserStore.getState().addOrganization(created);
    expect(useUserStore.getState().current?.organizations).toEqual([...currentUser.organizations, created]);
    expect(useUserStore.getState().current?.organization).toEqual(currentUser.organization);
  });

  it("updates an organization's name and logo in the list and as the active one (D23-2 decision 52)", () => {
    const logoId = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
    const other = { id: "7e6d5c4b-3a2f-4e1d-8c0b-9a8f7e6d5c4b", name: "Group", type: "group", logoId: null, role: "admin" } as const;
    useUserStore.getState().setCurrent({ ...currentUser, organizations: [...currentUser.organizations, other] });

    useUserStore.getState().updateOrganization(currentUser.organization.id, { name: "Renamed", logoId });
    expect(useUserStore.getState().current?.organization).toEqual({ ...currentUser.organization, name: "Renamed", logoId });
    expect(useUserStore.getState().current?.organizations).toEqual([
      { ...currentUser.organizations[0], name: "Renamed", logoId },
      other,
    ]);

    // A removal: the logo id back to null.
    useUserStore.getState().updateOrganization(currentUser.organization.id, { name: "Renamed", logoId: null });
    expect(useUserStore.getState().current?.organization.logoId).toBeNull();
    expect(useUserStore.getState().current?.organizations[0]?.logoId).toBeNull();
  });

  it("changes nothing while signed out", () => {
    useUserStore.getState().updateOrganization(currentUser.organization.id, { name: "Renamed", logoId: null });
    useUserStore.getState().addOrganization(currentUser.organization);
    expect(useUserStore.getState().current).toBeNull();
  });
});

/** The defaults with every key flipped from them: each of the seven differs. */
const OTHER: UserPreferences = {
  theme: "navy",
  editor: { tabSize: 4, fontSize: 18, lineNumbers: false, minimap: true },
  email: { productUpdates: false, productTips: false },
};

function preferences(): UserPreferences | undefined {
  return useUserStore.getState().current?.preferences;
}

describe("the seven keys", () => {
  it("reads and writes each key alone", () => {
    for (const key of PREFERENCE_KEYS) {
      const changed = withPreference(DEFAULT_USER_PREFERENCES, key, readPreference(OTHER, key));
      expect(readPreference(changed, key), key).toEqual(readPreference(OTHER, key));
      for (const other of PREFERENCE_KEYS.filter((each) => each !== key)) {
        expect(readPreference(changed, other), `${key} left ${other}`).toEqual(readPreference(DEFAULT_USER_PREFERENCES, other));
      }
    }
  });
});

describe("per-key saves (D21 decision 33, Preflight ruling 35)", () => {
  beforeEach(() => {
    useUserStore.getState().setCurrent(currentUser);
  });

  it("shows a choice at once, numbering it, and changes no other key", () => {
    const sequence = useUserStore.getState().setPreference("editor.fontSize", 18);
    expect(sequence).toEqual(expect.any(Number));
    expect(preferences()).toEqual({ ...DEFAULT_USER_PREFERENCES, editor: { ...DEFAULT_USER_PREFERENCES.editor, fontSize: 18 } });
    expect(useUserStore.getState().pendingPreferences).toEqual({ "editor.fontSize": sequence });
    expect(useUserStore.getState().confirmedPreferences).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it("takes an answer for its own key only, and confirms it", () => {
    const sequence = useUserStore.getState().setPreference("theme", "light")!;
    // The answer says other things of other keys (another tab's change): only the theme is taken.
    expect(useUserStore.getState().takePreferenceAnswer("theme", sequence, { ...OTHER, theme: "light" })).toBe(true);
    expect(preferences()).toEqual({ ...DEFAULT_USER_PREFERENCES, theme: "light" });
    expect(useUserStore.getState().confirmedPreferences).toEqual({ ...DEFAULT_USER_PREFERENCES, theme: "light" });
    expect(useUserStore.getState().pendingPreferences).toEqual({});
  });

  it("an earlier choice's answer never overwrites a later choice of the same key, but confirms what the server holds (Ruling 86)", () => {
    const first = useUserStore.getState().setPreference("editor.tabSize", 4)!;
    const second = useUserStore.getState().setPreference("editor.tabSize", 2)!;
    expect(useUserStore.getState().takePreferenceAnswer("editor.tabSize", first, withPreference(DEFAULT_USER_PREFERENCES, "editor.tabSize", 4))).toBe(false);
    expect(preferences()?.editor.tabSize).toBe(2);
    expect(useUserStore.getState().confirmedPreferences?.editor.tabSize).toBe(4);
    expect(useUserStore.getState().restorePreference("editor.tabSize", first)).toBe(false);
    expect(preferences()?.editor.tabSize).toBe(2);
    expect(useUserStore.getState().pendingPreferences).toEqual({ "editor.tabSize": second });
  });

  it("a failure restores the confirmed value, not the one shown before the choice (Ruling 86)", () => {
    // Confirmed moves to 16 (another tab's change, through /me) while 14 is being saved.
    const sequence = useUserStore.getState().setPreference("editor.fontSize", 14)!;
    useUserStore.getState().reseedPreferences(currentUser.user.id, withPreference(DEFAULT_USER_PREFERENCES, "editor.fontSize", 16));
    expect(preferences()?.editor.fontSize).toBe(14);
    expect(useUserStore.getState().restorePreference("editor.fontSize", sequence)).toBe(true);
    expect(preferences()?.editor.fontSize).toBe(16);
  });

  it("a later save's answer stands over an earlier save's late answer, in the confirmed copy too", () => {
    const first = useUserStore.getState().setPreference("editor.fontSize", 14)!;
    const second = useUserStore.getState().setPreference("editor.fontSize", 16)!;
    expect(useUserStore.getState().takePreferenceAnswer("editor.fontSize", second, withPreference(DEFAULT_USER_PREFERENCES, "editor.fontSize", 16))).toBe(true);
    expect(useUserStore.getState().takePreferenceAnswer("editor.fontSize", first, withPreference(DEFAULT_USER_PREFERENCES, "editor.fontSize", 14))).toBe(false);
    expect(preferences()?.editor.fontSize).toBe(16);
    expect(useUserStore.getState().confirmedPreferences?.editor.fontSize).toBe(16);
  });

  it("a /me read sent before a save's answer never overwrites it; one sent after does (Ruling 86's item 4)", () => {
    const readBefore = numberPreferenceRead();
    const sequence = useUserStore.getState().setPreference("theme", "light")!;
    useUserStore.getState().takePreferenceAnswer("theme", sequence, { ...DEFAULT_USER_PREFERENCES, theme: "light" });
    useUserStore.getState().reseedPreferences(currentUser.user.id, OTHER, readBefore);
    expect(preferences()).toEqual({ ...OTHER, theme: "light" });
    useUserStore.getState().reseedPreferences(currentUser.user.id, OTHER, numberPreferenceRead());
    expect(preferences()).toEqual(OTHER);
  });

  it("an older /me answer that comes after a newer one never overwrites it (the Ruling 86 review's Nit 2)", () => {
    const older = numberPreferenceRead();
    const newer = numberPreferenceRead();
    useUserStore.getState().reseedPreferences(currentUser.user.id, OTHER, newer);
    expect(preferences()).toEqual(OTHER);
    expect(useUserStore.getState().highestReadApplied).toBe(newer);

    useUserStore.getState().reseedPreferences(currentUser.user.id, DEFAULT_USER_PREFERENCES, older);
    expect(preferences()).toEqual(OTHER);
    expect(useUserStore.getState().confirmedPreferences).toEqual(OTHER);

    // Through the layout's whole-answer seed too.
    useUserStore.getState().setCurrent({ ...currentUser, preferences: DEFAULT_USER_PREFERENCES }, older);
    expect(preferences()).toEqual(OTHER);
    // A newer read still applies.
    useUserStore.getState().reseedPreferences(currentUser.user.id, DEFAULT_USER_PREFERENCES, numberPreferenceRead());
    expect(preferences()).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it("a newer /me answer that changes nothing still refuses an older one after it", () => {
    const older = numberPreferenceRead();
    const newer = numberPreferenceRead();
    // The newer read says what the store already holds.
    useUserStore.getState().reseedPreferences(currentUser.user.id, DEFAULT_USER_PREFERENCES, newer);
    useUserStore.getState().reseedPreferences(currentUser.user.id, OTHER, older);
    expect(preferences()).toEqual(DEFAULT_USER_PREFERENCES);
    expect(useUserStore.getState().confirmedPreferences).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it("a re-seed for anyone but the person held changes nothing", () => {
    useUserStore.getState().reseedPreferences("1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", OTHER);
    expect(preferences()).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it("a failure restores that key alone to its confirmed value", () => {
    const tabSize = useUserStore.getState().setPreference("editor.tabSize", 4)!;
    useUserStore.getState().setPreference("editor.minimap", true);
    expect(useUserStore.getState().restorePreference("editor.tabSize", tabSize)).toBe(true);
    expect(preferences()?.editor).toEqual({ ...DEFAULT_USER_PREFERENCES.editor, minimap: true });
    expect(Object.keys(useUserStore.getState().pendingPreferences)).toEqual(["editor.minimap"]);
  });

  it("a /me re-seed takes every key but the pending ones, and confirms them all", () => {
    useUserStore.getState().setPreference("theme", "light");
    useUserStore.getState().setPreference("email.productTips", false);
    useUserStore.getState().setCurrent({ ...currentUser, preferences: OTHER });
    expect(preferences()).toEqual({ ...OTHER, theme: "light", email: { ...OTHER.email, productTips: false } });
    expect(useUserStore.getState().confirmedPreferences).toEqual(OTHER);
    expect(Object.keys(useUserStore.getState().pendingPreferences).sort()).toEqual(["email.productTips", "theme"]);
  });

  it("another user's seed drops the pending choices: their answers are never taken", () => {
    const sequence = useUserStore.getState().setPreference("theme", "light")!;
    const other = { ...currentUser, user: { id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", email: "other@example.com" }, preferences: OTHER };
    useUserStore.getState().setCurrent(other);
    expect(preferences()).toEqual(OTHER);
    expect(useUserStore.getState().takePreferenceAnswer("theme", sequence, DEFAULT_USER_PREFERENCES)).toBe(false);
    expect(preferences()).toEqual(OTHER);
  });

  it("changes nothing while signed out, and clear forgets the confirmed copy and the pending choices", () => {
    useUserStore.getState().setPreference("theme", "light");
    useUserStore.getState().clear();
    expect(useUserStore.getState().setPreference("theme", "navy")).toBeNull();
    expect(useUserStore.getState().current).toBeNull();
    expect(useUserStore.getState().confirmedPreferences).toBeNull();
    expect(useUserStore.getState().pendingPreferences).toEqual({});
  });
});
