import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { mdxPlugin } from "./mdx.config.js";

export default defineConfig({
  // mdxPlugin: the blog's MDX compiler (mdx.config.ts).
  plugins: [tailwindcss(), mdxPlugin(), reactRouter(), tsconfigPaths()],
  // The browser tests' dev server keeps its pre-bundled dependencies apart
  // (see playwright.config.ts). Sharing node_modules/.vite with a developer's
  // running dev server, each would rewrite the files the other is serving,
  // and a page can end up with two copies of React. Unset, it is Vite's
  // default.
  cacheDir: process.env.TELFLO_VITE_CACHE_DIR ?? "node_modules/.vite",
  // Pre-bundle every dependency the app's modules import when the server
  // starts. With no entries (React Router's plugin sets none, and there is no
  // index.html), Vite finds dependencies page by page, and each find reloads
  // every open page; one reload mid-render can load two copies of React. The
  // browser tests start from an empty cache, so they hit this on every CI run.
  // The scanner doesn't follow `new Worker(new URL(…))`, so Monaco's worker
  // files are entries of their own: without them, the first editor opened
  // finds monaco-editor's and monaco-yaml's worker modules, re-optimizes and
  // reloads every page.
  optimizeDeps: {
    entries: ["app/root.tsx", "app/routes/**/*.tsx", "app/lib/editor/*.worker.ts", "!app/**/*.test.tsx"],
  },
  // Pinned (not Vite's 5173 default) and strict: TELFLO_PUBLIC_WEB_URL in
  // .env / .env.example must match this port, since verification links are
  // built from it server-side. A silent fallback to another port here would
  // silently break those links instead of failing loudly — see .env.example.
  // TELFLO_WEB_PORT is for the browser tests' own server (23100, see
  // playwright.config.ts); unset or empty, it is 53000 as always.
  server: {
    port: Number(process.env.TELFLO_WEB_PORT || 53000),
    strictPort: true,
    // The browser calls the API same-origin (see app/lib/api-client.ts), so
    // in development this server forwards /api to the API process, exactly
    // as the gateway does in the container stack.
    proxy: { "/api": `http://localhost:${process.env.TELFLO_API_PORT ?? "8080"}` },
  },
});
