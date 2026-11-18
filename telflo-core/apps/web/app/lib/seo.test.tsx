import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { canonicalMeta, jsonLdScriptText, organizationJsonLd, publicWebUrlFrom } from "./seo.js";

const WITH_URL = [{ id: "root", loaderData: { publicWebUrl: "https://telflo.example" } }, { id: "routes/page" }];
const WITHOUT_URL = [{ id: "root", loaderData: { publicWebUrl: null } }, { id: "routes/page" }];

describe("publicWebUrlFrom", () => {
  it("reads the public URL from root's loader data", () => {
    expect(publicWebUrlFrom(WITH_URL)).toBe("https://telflo.example");
  });

  it("is undefined when root passed none, or has no loader data", () => {
    expect(publicWebUrlFrom(WITHOUT_URL)).toBeUndefined();
    expect(publicWebUrlFrom([{ id: "root", loaderData: undefined }])).toBeUndefined();
    expect(publicWebUrlFrom([undefined, { id: "routes/page" }])).toBeUndefined();
  });
});

describe("canonicalMeta", () => {
  it("is og:url and the canonical link, the path under the public URL", () => {
    expect(canonicalMeta(WITH_URL, "/pricing")).toEqual([
      { property: "og:url", content: "https://telflo.example/pricing" },
      { tagName: "link", rel: "canonical", href: "https://telflo.example/pricing" },
    ]);
  });

  it("is nothing without the public URL", () => {
    expect(canonicalMeta(WITHOUT_URL, "/pricing")).toEqual([]);
  });
});

describe("organizationJsonLd", () => {
  it("has the site's url and logo under the public URL", () => {
    expect(organizationJsonLd("https://telflo.example")).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Telflo",
      url: "https://telflo.example",
      logo: "https://telflo.example/telflo-logo-full.svg",
    });
  });

  it("leaves out the url and logo without it", () => {
    expect(organizationJsonLd(undefined)).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Telflo",
    });
  });
});

describe("jsonLdScriptText (D4 Ruling 16)", () => {
  it("can't end its script early, whatever the public URL holds, and reads back as it was", () => {
    const jsonLd = organizationJsonLd("https://telflo.example/</script><script>alert(1)</script><!--");
    const markup = renderToStaticMarkup(
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScriptText(jsonLd) }} />,
    );

    const parsed = new DOMParser().parseFromString(`<!doctype html><head>${markup}</head>`, "text/html");
    const scripts = parsed.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.textContent).not.toContain("<");
    expect(JSON.parse(scripts[0]?.textContent ?? "")).toEqual(jsonLd);
  });
});
