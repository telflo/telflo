import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/*
 * Only for `npm run fixture:palette-defaults` (scripts/palette-defaults.ts):
 * runs `write.spec.ts`, which writes the palette-defaults fixture, in Node,
 * through Vitest so the catalog is read as the web's build reads it
 * (`import.meta.glob`). The web's own suite (apps/web/vitest.config.ts)
 * never runs it.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [tsconfigPaths()],
  test: {
    name: "palette-defaults",
    environment: "node",
    include: ["scripts/palette-defaults/write.spec.ts"],
  },
});
