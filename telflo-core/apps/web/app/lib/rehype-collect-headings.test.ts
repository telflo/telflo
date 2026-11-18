import { describe, expect, it } from "vitest";
import { mdxPlugin } from "../../mdx.config.js";

/*
 * Compiles MDX through the plugin the build and the tests use (mdx.config.ts),
 * here in the test itself, so rehype-collect-headings runs where its coverage
 * is measured. Posts imported elsewhere are compiled in Vite's own process.
 */
async function compile(source: string): Promise<string> {
  const plugin = mdxPlugin() as unknown as {
    transform(code: string, id: string): Promise<{ code: string }>;
  };
  return (await plugin.transform(source, "/posts/a-test-post.mdx")).code;
}

/** A named export's value; the compiler writes each as a JSON literal. */
function exported(code: string, name: string): unknown {
  const match = code.match(new RegExp(`^export const ${name} = ([\\s\\S]*?);$`, "m"));
  if (!match?.[1]) throw new Error(`the compiled post has no ${name} export`);
  return JSON.parse(match[1]);
}

const SOURCE = `---
title: "A test post"
slug: "a-test-post"
---

Intro *paragraph*.

## First \`section\`

### A sub-section

#### Too deep

\`\`\`yaml
receivers:
  otlp: {}
\`\`\`
`;

describe("the blog's MDX compiler", () => {
  it("exports the h2 and h3 headings with their slugs, for the table of contents", async () => {
    const code = await compile(SOURCE);
    expect(exported(code, "headings")).toEqual([
      { id: "first-section", text: "First section", depth: 2 },
      { id: "a-sub-section", text: "A sub-section", depth: 3 },
    ]);
  });

  it("exports the post's text for the read time, each word once", async () => {
    const text = exported(await compile(SOURCE), "rawText") as string;
    expect(text.split(/\s+/).filter(Boolean)).toEqual([
      "Intro",
      "paragraph",
      ".",
      "First",
      "section",
      "A",
      "sub-section",
      "Too",
      "deep",
      "receivers:",
      "otlp:",
      "{}",
    ]);
  });

  it("exports the frontmatter", async () => {
    expect(exported(await compile(SOURCE), "frontmatter")).toEqual({
      title: "A test post",
      slug: "a-test-post",
    });
  });

  it("highlights code with Shiki at build time, so no highlighter is imported", async () => {
    const code = await compile(SOURCE);
    expect(code).toContain('className: "shiki github-dark-default"');
    const imports = Array.from(code.matchAll(/^import .* from "(.+)";$/gm), (match) => match[1]);
    expect(imports).toEqual(["react/jsx-runtime", "@mdx-js/react"]);
  });

  it("gives every heading an id", async () => {
    const code = await compile(SOURCE);
    expect(code).toContain('id: "too-deep"');
  });
});
