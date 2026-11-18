import { expect, type Page } from "@playwright/test";

// Where a bearer may be on the page (D17a decision 24; D17b-2 decisions 12
// and 34, Preflight ruling 15): only inside `ph-no-capture`, which session
// replay records nothing of (`SecretCopyBox`), never in an attribute or the
// page's title. Used by the create's tokens step (fleets.e2e.ts) and the
// Tokens tab's reveal and rotation (tokens.e2e.ts). The DOM twin of the web
// tests' `expectTextOnlyInsideNoCapture` (app/test/fleets.ts).

/**
 * Each bearer is on the page once, inside `ph-no-capture`, and in no
 * attribute and not in `document.title`; nor in the page's text with every
 * `ph-no-capture` subtree taken out (the text split across nodes outside,
 * which no single node holds: Ruling 22's check, Ruling 28). Evaluated as a
 * string, as the E2E code has no DOM types.
 */
export async function expectBearersOnlyInNoCapture(page: Page, bearers: string[]): Promise<void> {
  const placed = await page.evaluate<
    Array<{ inside: number; outside: number; splitOutside: boolean; inAttributes: number; inTitle: boolean }>
  >(`(() => {
    const bearers = ${JSON.stringify(bearers)};
    // The page's text outside ph-no-capture, joined: a clone of the body with every ph-no-capture subtree removed.
    const outsideBody = document.body.cloneNode(true);
    for (const each of outsideBody.querySelectorAll(".ph-no-capture")) each.remove();
    const outsideText = outsideBody.textContent;
    return bearers.map((bearer) => {
      let inside = 0;
      let outside = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!node.textContent.includes(bearer)) continue;
        if (node.parentElement && node.parentElement.closest(".ph-no-capture")) inside += 1;
        else outside += 1;
      }
      let inAttributes = 0;
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) if (attribute.value.includes(bearer)) inAttributes += 1;
      }
      return { inside, outside, splitOutside: outsideText.includes(bearer), inAttributes, inTitle: document.title.includes(bearer) };
    });
  })()`);
  expect(placed).toEqual(bearers.map(() => ({ inside: 1, outside: 0, splitOutside: false, inAttributes: 0, inTitle: false })));
}
