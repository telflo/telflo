import type { BrowserContext, Page } from "@playwright/test";

// Where private text sits on a page, for the browser tests' privacy checks
// (configuration text is shown only as text, inside `ph-no-capture` where a
// dialog's fields hold it, and never in an attribute). Evaluated as
// strings, as the E2E code has no DOM types.
//
// The page's title (`document.title`) counts as an attribute holder: it is
// no body text, yet analytics sends it with every page view and replay
// records `<head>`, so private text must never be there either.

/** Where one text is: text nodes inside `ph-no-capture`, outside it, and attribute values holding it. */
export interface TextPlaces {
  inside: number;
  outside: number;
  inAttributes: number;
}

/**
 * Where each of `texts` is on the page: as text inside `ph-no-capture`,
 * outside it, and in attributes (the page's title counted among them).
 */
export async function placesOf(page: Page, texts: string[]): Promise<TextPlaces[]> {
  return page.evaluate(`(() => {
    const texts = ${JSON.stringify(texts)};
    return texts.map((text) => {
      let inside = 0;
      let outside = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!node.textContent.includes(text)) continue;
        if (node.parentElement && node.parentElement.closest(".ph-no-capture")) inside += 1;
        else outside += 1;
      }
      let inAttributes = document.title.includes(text) ? 1 : 0;
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) if (attribute.value.includes(text)) inAttributes += 1;
      }
      return { inside, outside, inAttributes };
    });
  })()`);
}

/** Where one text is against the replay's masking: text nodes masked, unmasked, and attribute values holding it. */
export interface MaskedPlaces {
  /** Text nodes inside `ph-mask` (the shell's root, or `<body>` for portals and toasts) or `ph-no-capture`. */
  masked: number;
  /** Text nodes outside both: replay would record them as typed. */
  unmasked: number;
  /** Attribute values holding it, the page's title counted among them. */
  inAttributes: number;
}

/**
 * Where each of `texts` is against the replay's masking: other people's
 * personal data is visible text only inside `ph-mask` (or `ph-no-capture`),
 * and never in an attribute. A Radix portal renders into `<body>`, which the
 * signed-in shell marks `ph-mask` (AppLayout), so a dialog's text counts as
 * masked there. Collect, go to about:blank, then assert: the counts hold no
 * text.
 */
export async function maskedPlacesOf(page: Page, texts: string[]): Promise<MaskedPlaces[]> {
  return page.evaluate(`(() => {
    const texts = ${JSON.stringify(texts)};
    return texts.map((text) => {
      let masked = 0;
      let unmasked = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!node.textContent.includes(text)) continue;
        if (node.parentElement && node.parentElement.closest(".ph-mask, .ph-no-capture")) masked += 1;
        else unmasked += 1;
      }
      let inAttributes = document.title.includes(text) ? 1 : 0;
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) if (attribute.value.includes(text)) inAttributes += 1;
      }
      return { masked, unmasked, inAttributes };
    });
  })()`);
}

/**
 * `work`'s answer, or `fallback` when it fails or takes longer than `ms`:
 * a privacy check's collection, bounded so the test always reaches
 * about:blank before anything can fail.
 */
export function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/**
 * The attributes holding each of `texts`, each "{TAG} {attribute} {inside
 * ph-no-capture}" (e.g. "INPUT value true": a controlled input's value,
 * which React writes as the attribute; the only holder a dialog's fields
 * may be), and "document.title" when the page's title holds it.
 */
export async function attributeHoldersOf(page: Page, texts: string[]): Promise<string[][]> {
  return page.evaluate(`(() => {
    const texts = ${JSON.stringify(texts)};
    return texts.map((text) => {
      const holders = document.title.includes(text) ? ["document.title"] : [];
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (attribute.value.includes(text)) holders.push(element.tagName + " " + attribute.name + " " + (element.closest(".ph-no-capture") !== null));
        }
      }
      return holders;
    });
  })()`);
}

// ---------------------------------------------------------------------------
// Organization variables. A variable's value, name and description, and a
// variable group's name and description, are configuration text: shown as
// text (inside `ph-no-capture` where typed or shown in a dialog's fields, and
// the values everywhere), never in an attribute, a URL, a page title or
// browser storage.

/**
 * A canary value for an organization variable: unique to `token`, and
 * holding a `$`, so a filled-in text holds it with its `$` doubled
 * (`filledInValue`), the opamp-server's literal fill-in.
 */
export function canaryVariableValue(token: string): string {
  return `canary$value-${token}`;
}

/** `value` as a filled-in text holds it: each `$` doubled, so the collector reads it literally. */
export function filledInValue(value: string): string {
  return value.split("$").join("$$");
}

/**
 * The browser storage entries whose key or value holds any of `texts`
 * ("{store} {key}"): localStorage and sessionStorage, the cookies the page
 * can read ("cookie {name}"), and the names of its IndexedDB databases
 * ("indexedDB {name}"). Nothing about variables is kept there.
 */
export async function storageHolding(page: Page, texts: string[]): Promise<string[]> {
  return page.evaluate(`(async () => {
    const texts = ${JSON.stringify(texts)};
    const holds = (text) => texts.some((each) => text.includes(each));
    const found = [];
    for (const [label, store] of [["localStorage", window.localStorage], ["sessionStorage", window.sessionStorage]]) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (holds(key) || holds(store.getItem(key) ?? "")) found.push(label + " " + key);
      }
    }
    for (const cookie of document.cookie.split("; ").filter((each) => each !== "")) {
      let text = cookie;
      try {
        text = decodeURIComponent(cookie);
      } catch {}
      if (holds(cookie) || holds(text)) found.push("cookie " + cookie.split("=")[0]);
    }
    const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    for (const database of databases) if (holds(database.name ?? "")) found.push("indexedDB " + database.name);
    return found;
  })()`);
}

/**
 * The URLs among `urls` holding any of `texts`, as sent or decoded (each
 * percent-escape read back, once): no name, value or search may be in an
 * address.
 */
export function urlsHolding(urls: readonly string[], texts: readonly string[]): string[] {
  return urls.filter((url) => {
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      // A malformed escape: the URL as sent is checked alone.
    }
    return texts.some((text) => url.includes(text) || decoded.includes(text) || url.includes(encodeURIComponent(text)));
  });
}

// ---------------------------------------------------------------------------
// The account's personal data: the account's email, a linked identity's
// email, a session's IP address, browser and system and times are visible
// text only, inside the masked shell; never in an attribute, a URL, a toast,
// a page title or browser storage. The browser tests record every URL a
// context requests and every toast a page shows, and look for canaries in
// them.

/**
 * Every URL `context` requests from now on (each redirect's too: Playwright
 * reports a request per hop), in order, for `urlsHolding`.
 */
export function recordRequestUrls(context: BrowserContext): string[] {
  const urls: string[] = [];
  context.on("request", (request) => {
    urls.push(request.url());
  });
  return urls;
}

/**
 * The text of every toast `page` shows from now on, each once, across full
 * page loads (a link's round trip leaves the app and comes back): sonner's
 * `[data-sonner-toast]` elements, read whenever the document changes.
 */
export async function recordToasts(page: Page): Promise<string[]> {
  const texts: string[] = [];
  await page.exposeFunction("__e2eRecordToast", (text: string) => {
    if (!texts.includes(text)) texts.push(text);
  });
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  await page.addInitScript(`(() => {
    const sent = new Set();
    const record = () => {
      for (const toast of document.querySelectorAll("[data-sonner-toast]")) {
        const text = toast.textContent ?? "";
        if (text === "" || sent.has(text)) continue;
        sent.add(text);
        window.__e2eRecordToast(text);
      }
    };
    new MutationObserver(record).observe(document, { childList: true, subtree: true, characterData: true });
  })()`);
  return texts;
}

/** The toasts among `toasts` holding any of `texts`. */
export function toastsHolding(toasts: readonly string[], texts: readonly string[]): string[] {
  return toasts.filter((toast) => texts.some((text) => toast.includes(text)));
}

/**
 * The fields holding a value outside `ph-no-capture`: every text input,
 * textarea, native select and contenteditable (`true`, `""` or
 * `plaintext-only`) whose value is not empty and that has no `ph-no-capture`
 * element at or above it. Checkboxes, radios, buttons and the like hold no
 * typed text and are left out. Each is named by its tag, type and id (fixed
 * words), never its value. Shadow roots aren't searched: the playground's
 * surfaces have none (a component that adds one needs this widened).
 */
export async function unmaskedFieldsOf(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    const skipped = new Set(["checkbox", "radio", "button", "submit", "reset", "hidden", "file", "image", "range", "color"]);
    const fields = [...document.querySelectorAll("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")];
    return fields
      .filter((field) => !(field.tagName === "INPUT" && skipped.has((field.type || "").toLowerCase())))
      .filter((field) => (field.isContentEditable ? field.textContent : field.value) !== "")
      .filter((field) => field.closest(".ph-no-capture") === null)
      .map((field) => field.tagName.toLowerCase() + "[type=" + (field.type || "") + "]#" + (field.id || "") );
  })()`);
}
