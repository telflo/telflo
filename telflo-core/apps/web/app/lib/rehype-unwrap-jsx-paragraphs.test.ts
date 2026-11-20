import { describe, expect, it } from "vitest";
import { mdxPlugin } from "../../mdx.config.js";

/*
 * Compiles MDX through the plugin the build and the tests use (mdx.config.ts),
 * here in the test itself, so rehype-unwrap-jsx-paragraphs runs where its
 * coverage is measured (as rehype-collect-headings.test.ts does).
 */
async function compile(source: string): Promise<string> {
  const plugin = mdxPlugin() as unknown as {
    transform(code: string, id: string): Promise<{ code: string }>;
  };
  return (await plugin.transform(source, "/posts/a-test-post.mdx")).code;
}

const FRONTMATTER = `---
title: "A test post"
slug: "a-test-post"
---
`;

describe("a paragraph written as JSX", () => {
  it("holds its text, not a second paragraph MDX made of the lines inside it", async () => {
    const code = await compile(`${FRONTMATTER}
<div>
  <p>
    <strong>instance_uid</strong> uniquely identifies the client agent.
  </p>
</div>
`);

    // The post's own <p> is a literal "p"; a paragraph MDX made would be _components.p.
    expect(code).toContain(`"p"`);
    expect(code).not.toContain("_components.p");
    expect(code).toContain("uniquely identifies the client agent.");
  });

  it("joins two paragraphs MDX made inside one JSX paragraph with a line break, not run together", async () => {
    const code = await compile(`${FRONTMATTER}
<p>
  first line

  second line
</p>
`);

    expect(code).not.toContain("_components.p");
    expect(code).toMatch(/"first line",\s*"\\n",\s*"second line"/);
  });

  it("leaves a paragraph on one line, and markdown's own paragraphs, as they were", async () => {
    const code = await compile(`${FRONTMATTER}
<p>One <em>line</em>.</p>

A markdown paragraph.
`);

    expect(code).toContain("One ");
    expect(code).toContain("_components.p");
    expect(code).toContain("A markdown paragraph.");
  });
});
