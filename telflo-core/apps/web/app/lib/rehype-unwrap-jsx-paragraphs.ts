import type { Element, Parent, Root } from "hast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

/** A `<p>` written as JSX in a post, as MDX puts it in the tree. */
interface JsxParagraph extends Parent {
  type: "mdxJsxFlowElement" | "mdxJsxTextElement";
  name: "p";
}

function isJsxParagraph(node: { type: string }): node is JsxParagraph {
  return (
    (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
    (node as { name?: unknown }).name === "p" &&
    "children" in node
  );
}

function isParagraph(node: { type: string }): node is Element {
  return node.type === "element" && (node as Element).tagName === "p";
}

/**
 * A post may write a paragraph as JSX, its text on lines of its own
 * (`fleet-management-effectively-managing-chaos`, say):
 *
 *     <p>
 *       <strong>instance_uid</strong> uniquely identifies the client agent.
 *     </p>
 *
 * MDX reads those lines as markdown, a paragraph of their own, so the page
 * renders a `<p>` inside the `<p>`. A browser parsing the server's HTML
 * closes the first before the second, and hydration then mismatches.
 * This keeps the paragraph the post wrote and drops the one MDX
 * added, keeping its content. Where MDX made two or more paragraphs of the
 * lines, their contents are joined by a line break, which renders as a
 * space, rather than run together. Only flow JSX is handled: an inline
 * `<p>` inside a markdown paragraph (`Intro <p>inline</p> tail`) still
 * nests, and no post writes one.
 */
export const rehypeUnwrapJsxParagraphs: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, (node) => {
      if (!isJsxParagraph(node)) return;
      const children: typeof node.children = [];
      let afterParagraph = false;
      for (const child of node.children) {
        if (isParagraph(child)) {
          if (afterParagraph) children.push({ type: "text", value: "\n" });
          children.push(...child.children);
          afterParagraph = true;
        } else {
          children.push(child);
          // Whitespace between two of MDX's paragraphs doesn't separate them.
          if (!(child.type === "text" && child.value.trim() === "")) afterParagraph = false;
        }
      }
      node.children = children;
    });
  };
};
