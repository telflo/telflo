import type { MetaDescriptor } from "react-router";

/** What a meta function's `matches` holds, as far as these helpers read it. */
type MetaMatchesLike = ReadonlyArray<{ id: string; loaderData?: unknown } | undefined>;

/**
 * TELFLO_PUBLIC_WEB_URL as the root loader passed it on, or undefined when it
 * is unset. Undefined too when root's loader data is missing, as it is when
 * the loader itself failed.
 */
export function publicWebUrlFrom(matches: MetaMatchesLike): string | undefined {
  const root = matches.find((match) => match?.id === "root")?.loaderData;
  if (typeof root !== "object" || root === null || !("publicWebUrl" in root)) return undefined;
  return typeof root.publicWebUrl === "string" ? root.publicWebUrl : undefined;
}

/**
 * A page's `og:url` and canonical link, `path` under the public URL. Nothing
 * without the setting: a canonical on the wrong host is worse than none
 * (a hardcoded https://telflo.com would be wrong for an on-prem install).
 */
export function canonicalMeta(matches: MetaMatchesLike, path: string): MetaDescriptor[] {
  const base = publicWebUrlFrom(matches);
  if (base === undefined) return [];
  const url = `${base}${path}`;
  return [
    { property: "og:url", content: url },
    { tagName: "link", rel: "canonical", href: url },
  ];
}

/**
 * The Organization JSON-LD root renders on every page. Its `url` and `logo`
 * are the site's and its full logo, under the public URL, and left out
 * without it.
 */
export function organizationJsonLd(publicWebUrl: string | undefined): Record<string, string> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Telflo",
    ...(publicWebUrl === undefined
      ? {}
      : { url: publicWebUrl, logo: `${publicWebUrl}/telflo-logo-full.svg` }),
  };
}

/**
 * `value` as the text of a `<script type="application/ld+json">`. A browser
 * reads a script's text with no entities, so a `<` in a value (`</script>`
 * in TELFLO_PUBLIC_WEB_URL, say) could end the script early: each is
 * written `\u003c`, which JSON reads back as `<`. React Router's meta
 * escapes a page's own `script:ld+json` the same way.
 */
export function jsonLdScriptText(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
