import mdx from "@mdx-js/rollup";
import rehypeShiki from "@shikijs/rehype";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import type { PluginOption } from "vite";
import { rehypeCollectHeadings } from "./app/lib/rehype-collect-headings.js";
import { rehypeUnwrapJsxParagraphs } from "./app/lib/rehype-unwrap-jsx-paragraphs.js";

/**
 * The blog's MDX compiler, shared by vite.config.ts and vitest.config.ts
 * so the tests import posts compiled exactly as the build compiles them. A
 * post exports its frontmatter, and the headings and text
 * rehype-collect-headings adds.
 *
 * rehype-unwrap-jsx-paragraphs keeps a paragraph written as JSX from holding
 * the one MDX adds inside it.
 *
 * `enforce: "pre"` runs it before React Router's and Vite's own transforms,
 * which don't understand MDX. Shiki highlights code here, at build time; no
 * highlighter reaches the browser.
 */
export function mdxPlugin(): PluginOption {
  return {
    enforce: "pre",
    ...mdx({
      format: "mdx",
      mdExtensions: [],
      remarkPlugins: [
        remarkFrontmatter,
        [remarkMdxFrontmatter, { name: "frontmatter" }],
        remarkGfm,
      ],
      rehypePlugins: [
        rehypeUnwrapJsxParagraphs,
        rehypeSlug,
        rehypeCollectHeadings,
        [rehypeShiki, { theme: "github-dark-default" }],
      ],
      providerImportSource: "@mdx-js/react",
    }),
  };
}
