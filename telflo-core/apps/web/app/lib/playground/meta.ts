import type { MetaDescriptor } from "react-router";
import { canonicalMeta } from "~/lib/seo.js";
import type { ThemeHandle } from "~/lib/theme.js";

/*
 * The playground's pages' head (D31-1 decision 17, Preflight ruling 15):
 * crawlable (robots unchanged), each with its own fixed title and its own
 * canonical (a child never inherits the layout's). Titles are fixed words:
 * never a configuration's, a flow's or a fleet's name (ADR 0024).
 */

/** The playground's description. */
export const PLAYGROUND_DESCRIPTION =
  "Explore the full Telflo product with sample data — visual pipeline editor, behavioral testing, and remote fleet management. No account needed.";

/** The public editor's description. */
export const PUBLIC_EDITOR_DESCRIPTION = "Public visual editor for OpenTelemetry Collector configurations";

/** The fixed titles. */
export const PLAYGROUND_TITLES = {
  configurations: "Playground - Telflo",
  flows: "Flows - Playground - Telflo",
  flow: "Flow - Playground - Telflo",
  fleets: "Fleet Management - Playground - Telflo",
  fleet: "Fleet - Playground - Telflo",
  editor: "Playground Editor - Telflo",
  publicEditor: "Public Editor - Telflo",
} as const;

/** Every playground route's handle: root renders the remembered theme (decision 14). */
export const PLAYGROUND_HANDLE = { theme: "remembered" } satisfies ThemeHandle;

type MetaMatches = Parameters<typeof canonicalMeta>[0];

/** A playground page's meta: its title, the description, the Open Graph tags and its canonical (`path` under the public URL). */
export function playgroundMeta(
  matches: MetaMatches,
  title: string,
  path: string,
  description: string = PLAYGROUND_DESCRIPTION,
): MetaDescriptor[] {
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    ...canonicalMeta(matches, path),
  ];
}
