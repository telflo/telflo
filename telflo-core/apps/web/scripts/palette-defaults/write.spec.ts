import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { PALETTE_DEFAULTS_FIXTURE, serializedFixture } from "../palette-defaults.js";

/*
 * Writes the palette-defaults fixture (`npm run fixture:palette-defaults
 * --workspace @telflo/web`; scripts/palette-defaults.ts says what it holds).
 * Only that script runs this file; the web's suite checks the committed
 * file and never writes it (scripts/palette-defaults.test.ts).
 */

const REPOSITORY_ROOT = new URL("../../../../../", import.meta.url);

it("writes the palette-defaults fixture", () => {
  const path = fileURLToPath(new URL(PALETTE_DEFAULTS_FIXTURE, REPOSITORY_ROOT));
  const text = serializedFixture();
  writeFileSync(path, text);
  expect(text.length).toBeGreaterThan(0);
  console.log(`Wrote ${path} (${text.length} characters).`);
});
