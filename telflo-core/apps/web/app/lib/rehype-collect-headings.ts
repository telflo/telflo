import type { Root, Element, Text } from "hast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { valueToEstree } from "estree-util-value-to-estree";

interface HeadingInfo {
  id: string;
  text: string;
  depth: number;
}

function extractText(node: Element): string {
  let result = "";
  visit(node, "text", (textNode: Text) => {
    result += textNode.value;
  });
  return result.trim();
}

/**
 * Rehype plugin that walks the MDX AST, collects h2/h3 headings,
 * and exposes them as a named `headings` export on the compiled module.
 * Used by the blog post page to render a table of contents.
 *
 * Must run after rehype-slug so each heading has an id.
 */
export const rehypeCollectHeadings: Plugin<[], Root> = () => {
  return (tree) => {
    const headings: HeadingInfo[] = [];
    let totalText = "";

    // Collect text once from the root. (Collecting inside the element visitor
    // counted every text node once per ancestor element, inflating read time.)
    visit(tree, "text", (t: Text) => {
      totalText += t.value + " ";
    });

    visit(tree, "element", (node: Element) => {
      if (node.tagName === "h2" || node.tagName === "h3") {
        const id = (node.properties?.id as string) || "";
        if (!id) return;
        headings.push({
          id,
          text: extractText(node),
          depth: node.tagName === "h2" ? 2 : 3,
        });
      }
    });

    const mdxJsEsm = {
      type: "mdxjsEsm" as const,
      value: "",
      data: {
        estree: {
          type: "Program",
          sourceType: "module",
          body: [
            {
              type: "ExportNamedDeclaration",
              specifiers: [],
              declaration: {
                type: "VariableDeclaration",
                kind: "const",
                declarations: [
                  {
                    type: "VariableDeclarator",
                    id: { type: "Identifier", name: "headings" },
                    init: valueToEstree(headings),
                  },
                ],
              },
            },
            {
              type: "ExportNamedDeclaration",
              specifiers: [],
              declaration: {
                type: "VariableDeclaration",
                kind: "const",
                declarations: [
                  {
                    type: "VariableDeclarator",
                    id: { type: "Identifier", name: "rawText" },
                    init: valueToEstree(totalText),
                  },
                ],
              },
            },
          ],
        },
      },
    };

    tree.children.unshift(mdxJsEsm as never);
  };
};
