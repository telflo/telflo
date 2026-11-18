import type {
  ActiveOrganization,
  CurrentUserResponse,
  EditorFontSize,
  EditorTabSize,
  Theme,
  UserPreferences,
} from "@telflo/contracts";
import { create } from "zustand";

/**
 * `/me`'s answer without `termsAcceptanceRequired`. That flag belongs to the
 * layout's loader data alone (D2c Preflight minor): the store is seeded once
 * per user, so a copy of it would still say "required" after Accept.
 * `isProductAdmin` is kept (D12 decision 3): the layout re-seeds the store
 * when it changes, so a revocation shows on the next navigation. So are the
 * `preferences` (D21 decision 20): the theme and the editor and email
 * preferences, re-seeded when they change.
 */
export type StoredCurrentUser = Omit<CurrentUserResponse, "termsAcceptanceRequired">;

/** The seven preferences Settings saves one at a time (D21 decision 33): the theme, then each group's keys. */
export const PREFERENCE_KEYS = [
  "theme",
  "editor.tabSize",
  "editor.fontSize",
  "editor.lineNumbers",
  "editor.minimap",
  "email.productUpdates",
  "email.productTips",
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

/** Each key's value. */
export type PreferenceValues = {
  theme: Theme;
  "editor.tabSize": EditorTabSize;
  "editor.fontSize": EditorFontSize;
  "editor.lineNumbers": boolean;
  "editor.minimap": boolean;
  "email.productUpdates": boolean;
  "email.productTips": boolean;
};

/** `key`'s value in `preferences`. */
export function readPreference<Key extends PreferenceKey>(preferences: UserPreferences, key: Key): PreferenceValues[Key] {
  if (key === "theme") return preferences.theme as PreferenceValues[Key];
  const [group, name] = key.split(".") as ["editor" | "email", string];
  return (preferences[group] as Record<string, unknown>)[name] as PreferenceValues[Key];
}

/** `preferences` with `key` set to `value`, every other key as it was. */
export function withPreference<Key extends PreferenceKey>(
  preferences: UserPreferences,
  key: Key,
  value: PreferenceValues[Key],
): UserPreferences {
  if (key === "theme") return { ...preferences, theme: value as Theme };
  const [group, name] = key.split(".") as ["editor" | "email", string];
  return { ...preferences, [group]: { ...preferences[group], [name]: value } };
}

/** A number per key: the pending choices, or the save that last confirmed each key. */
type PerKey = Partial<Record<PreferenceKey, number>>;

/*
 * The preferences' invariant (D21 decision 33, Preflight ruling 35, Ruling
 * 86):
 * - `confirmedPreferences[key]` is the last value the server is known to
 *   hold for that key: every save's answer, taken or overtaken, and every
 *   `/me` answer update it, unless something newer already did (below).
 * - What the page shows, `current.preferences[key]`, is the newest pending
 *   choice of that key, else the confirmed value. A failed save shows the
 *   confirmed value again, unless a later choice of the key is pending.
 *
 * Which answer is newer. Every choice (a save) and every `/me` read is
 * numbered from one counter when its request is sent. The store keeps, per
 * key, the number of the save whose answer last confirmed it
 * (`confirmedBySave`):
 * - a save's answer confirms when its number is above that: a later save's
 *   answer that came back first stands, and an earlier save's answer that
 *   comes back after it doesn't undo it;
 * - a `/me` answer confirms a key when its read was sent after that save
 *   was: a read sent before the save can't know of it, so it never
 *   overwrites the save's answer (Ruling 86's item 4). A read sent after a
 *   save was sent but answered before it is taken until the save's own
 *   answer comes back and confirms the save's value: the read can't tell
 *   whether the server had applied the save yet, the save's answer can.
 * - a `/me` answer is applied only when its read is the newest applied so
 *   far (`highestReadApplied`): an older read answered after a newer one
 *   never overwrites it. React Router aborts a stale navigation's loader
 *   today, so this is defence in depth (the Ruling 86 review's Nit 2).
 * A new person (or a first seed) starts every key's `confirmedBySave` at
 * its read's number, so no answer to a save sent before then is ever taken.
 *
 * The limits of numbering at sending (the Ruling 86 review's Minor 1). The
 * numbers say the order the browser SENT the requests in, not the order the
 * API applied them in, so two orders can leave the confirmed value stale
 * until a later `/me` read (sent after both) heals it:
 * - a `/me` read sent after a save but read by the API before the save's
 *   write, and answered after the save's answer: its number is the higher,
 *   so it confirms the value from before the save (the page still shows the
 *   save's value unless a failure later restores the stale one);
 * - two saves of one key that the API applies in the reverse order: the
 *   later-sent save's answer confirms its value, while the server holds the
 *   earlier-sent one's.
 * Only a revision the server keeps for the preferences, returned by `/me`
 * and by each save, would order them as the server applied them (TODO).
 */

// Numbers every choice and every `/me` read, across keys and users, so a number is never reused.
let lastPreferenceSequence = 0;

/**
 * Numbers a `/me` read at its sending: the layout's client loader takes one
 * before it asks, and hands it on with the answer (`preferencesReadAt`).
 */
export function numberPreferenceRead(): number {
  return ++lastPreferenceSequence;
}

/** `perKey` without `key`. */
function without(perKey: PerKey, key: PreferenceKey): PerKey {
  const { [key]: _gone, ...others } = perKey;
  return others;
}

/** Every key at `value`. */
function everyKey(value: number): PerKey {
  return Object.fromEntries(PREFERENCE_KEYS.map((key) => [key, value])) as PerKey;
}

/** What the page shows: each pending key's choice (from `shown`), every other key's confirmed value. */
function shownPreferences(shown: UserPreferences, confirmed: UserPreferences, pending: PerKey): UserPreferences {
  let preferences = confirmed;
  for (const key of PREFERENCE_KEYS) {
    if (pending[key] !== undefined) preferences = withPreference(preferences, key, readPreference(shown, key));
  }
  return preferences;
}

/** Whether two preferences say the same for every key. */
function samePreferences(left: UserPreferences, right: UserPreferences): boolean {
  return PREFERENCE_KEYS.every((key) => readPreference(left, key) === readPreference(right, key));
}

type UserState = {
  /**
   * The signed-in user, their active organization, every organization they
   * belong to, with its type and their role, whether they are a product
   * admin, and their preferences; null when signed out. The preferences are
   * the ones the person sees: a choice made in Settings is here at once,
   * before the API answers (decision 33).
   */
  current: StoredCurrentUser | null;
  /**
   * The preferences as the server is last known to hold them (`/me`, or a
   * save's answer): what a failed save shows again. Null when signed out.
   */
  confirmedPreferences: UserPreferences | null;
  /** The keys whose latest choice is still being saved, each with that choice's number (Preflight ruling 35). */
  pendingPreferences: PerKey;
  /** Per key, the number of the save whose answer last confirmed it (Ruling 86). */
  confirmedBySave: PerKey;
  /** The number of the newest `/me` read whose answer was applied: an older one is ignored. 0 when signed out. */
  highestReadApplied: number;
  /**
   * True while a switch of the active organization is in flight: the
   * signed-in shell shows a spinner in place of the page (D5 decision 11).
   */
  isSwitchingOrganization: boolean;
  /**
   * Seeds the store from `/me`, read at `readAt` (`numberPreferenceRead`;
   * now when not given). Another person, or the first seed, starts afresh.
   * The same person's re-seed takes the preferences as `reseedPreferences`
   * does.
   */
  setCurrent: (current: StoredCurrentUser, readAt?: number) => void;
  /**
   * A `/me` answer's preferences for the person the store holds (nothing
   * for anyone else), read at `readAt` (now when not given): each key the
   * read is newer for is confirmed, and shown unless a choice of it is
   * pending. Only the preferences: what create and rename put in the store
   * is left alone.
   */
  reseedPreferences: (userId: string, preferences: UserPreferences, readAt?: number) => void;
  /**
   * Shows `value` for `key` at once and marks the key pending: the number
   * returned names this choice, for its save's answer. Null while signed out
   * (nothing changes).
   */
  setPreference: <Key extends PreferenceKey>(key: Key, value: PreferenceValues[Key]) => number | null;
  /**
   * A save's answer: confirms `answer`'s value of `key` alone, unless a
   * later save's answer already did. True when `sequence` was the key's
   * pending choice, now settled; an overtaken answer still confirms, and
   * the later choice stays shown.
   */
  takePreferenceAnswer: (key: PreferenceKey, sequence: number, answer: UserPreferences) => boolean;
  /**
   * A save that failed: while `sequence` is still the key's pending choice,
   * shows the key's confirmed value again. True when it did.
   */
  restorePreference: (key: PreferenceKey, sequence: number) => boolean;
  setSwitchingOrganization: (isSwitching: boolean) => void;
  /**
   * Lists an organization the user just created. The layout re-seeds the
   * store only when the user or the active organization changes, so a
   * created organization that the user hasn't switched to yet is added here.
   */
  addOrganization: (organization: ActiveOrganization) => void;
  /**
   * Takes an organization's new name and logo wherever the store shows it
   * (the active organization and the list), after the API changed them
   * (D23-2 decision 52).
   */
  updateOrganization: (organizationId: string, change: { name: string; logoId: string | null }) => void;
  clear: () => void;
};

/**
 * Client-side copy of the current user. The app layout's loader is the
 * source of truth (it asks the API on every signed-in page load); this store
 * lets components read it without threading props, and logout clears it.
 * Settings saves a preference through it (`lib/preferences.ts`): every
 * reader, the shell's theme and every open Monaco, follows at once.
 */
export const useUserStore = create<UserState>()((set, get) => ({
  current: null,
  confirmedPreferences: null,
  pendingPreferences: {},
  confirmedBySave: {},
  highestReadApplied: 0,
  isSwitchingOrganization: false,
  // Picked field by field, so a whole `/me` answer passed in leaves its
  // terms flag behind.
  setCurrent: ({ user, organization, organizations, isProductAdmin, mayCreateOrganizations, preferences }, readAt) => {
    const { current } = get();
    if (current !== null && current.user.id === user.id) {
      set({ current: { ...current, user, organization, organizations, isProductAdmin, mayCreateOrganizations } });
      get().reseedPreferences(user.id, preferences, readAt);
      return;
    }
    const read = readAt ?? numberPreferenceRead();
    set({
      current: { user, organization, organizations, isProductAdmin, mayCreateOrganizations, preferences },
      confirmedPreferences: preferences,
      pendingPreferences: {},
      confirmedBySave: everyKey(read),
      highestReadApplied: read,
    });
  },
  reseedPreferences: (userId, preferences, readAt) => {
    const { current, confirmedPreferences, pendingPreferences, confirmedBySave, highestReadApplied } = get();
    if (current === null || confirmedPreferences === null || current.user.id !== userId) return;
    const read = readAt ?? numberPreferenceRead();
    // An older read answered after a newer one: the newer one's preferences stand.
    if (read < highestReadApplied) return;
    let confirmed = confirmedPreferences;
    for (const key of PREFERENCE_KEYS) {
      if (read > (confirmedBySave[key] ?? 0)) confirmed = withPreference(confirmed, key, readPreference(preferences, key));
    }
    if (samePreferences(confirmed, confirmedPreferences)) {
      // Nothing to show, but still the newest read applied, so an older one's answer is refused.
      if (read !== highestReadApplied) set({ highestReadApplied: read });
      return;
    }
    set({
      current: { ...current, preferences: shownPreferences(current.preferences, confirmed, pendingPreferences) },
      confirmedPreferences: confirmed,
      highestReadApplied: read,
    });
  },
  setPreference: (key, value) => {
    const { current, pendingPreferences } = get();
    if (current === null) return null;
    const sequence = ++lastPreferenceSequence;
    set({
      current: { ...current, preferences: withPreference(current.preferences, key, value) },
      pendingPreferences: { ...pendingPreferences, [key]: sequence },
    });
    return sequence;
  },
  takePreferenceAnswer: (key, sequence, answer) => {
    const { current, confirmedPreferences, pendingPreferences, confirmedBySave } = get();
    if (current === null || confirmedPreferences === null) return false;
    const newer = sequence > (confirmedBySave[key] ?? 0);
    const confirmed = newer ? withPreference(confirmedPreferences, key, readPreference(answer, key)) : confirmedPreferences;
    const taken = pendingPreferences[key] === sequence;
    const pending = taken ? without(pendingPreferences, key) : pendingPreferences;
    set({
      current: { ...current, preferences: shownPreferences(current.preferences, confirmed, pending) },
      confirmedPreferences: confirmed,
      pendingPreferences: pending,
      confirmedBySave: newer ? { ...confirmedBySave, [key]: sequence } : confirmedBySave,
    });
    return taken;
  },
  restorePreference: (key, sequence) => {
    const { current, confirmedPreferences, pendingPreferences } = get();
    if (current === null || confirmedPreferences === null || pendingPreferences[key] !== sequence) return false;
    const pending = without(pendingPreferences, key);
    set({
      current: { ...current, preferences: shownPreferences(current.preferences, confirmedPreferences, pending) },
      pendingPreferences: pending,
    });
    return true;
  },
  setSwitchingOrganization: (isSwitching) => set({ isSwitchingOrganization: isSwitching }),
  addOrganization: (organization) =>
    set(({ current }) =>
      current === null ? {} : { current: { ...current, organizations: [...current.organizations, organization] } },
    ),
  updateOrganization: (organizationId, { name, logoId }) =>
    set(({ current }) => {
      if (current === null) return {};
      const updated = <Listed extends { id: string; name: string; logoId: string | null }>(listed: Listed): Listed =>
        listed.id === organizationId ? { ...listed, name, logoId } : listed;
      return {
        current: {
          ...current,
          organization: updated(current.organization),
          organizations: current.organizations.map(updated),
        },
      };
    }),
  clear: () =>
    set({
      current: null,
      confirmedPreferences: null,
      pendingPreferences: {},
      confirmedBySave: {},
      highestReadApplied: 0,
      isSwitchingOrganization: false,
    }),
}));
