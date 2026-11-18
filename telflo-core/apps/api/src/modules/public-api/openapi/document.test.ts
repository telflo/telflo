import { describe, expect, it } from "vitest";
import { assemblePublicApiDocument, PUBLIC_API_FRAGMENTS, publicApiDocument, publicApiDocumentJson } from "./document.js";

/*
 * The OpenAPI document's assembly (D25 decision 49, Preflight ruling 19):
 * the repository's fragments make one OpenAPI 3.1 document with the two
 * security schemes and the shared components; a duplicate anywhere refuses
 * the whole.
 */

const fragments = (texts: Record<string, string>) => (name: string) => {
  const text = texts[name];
  if (text === undefined) throw new Error(`no fragment ${name}`);
  return text;
};

describe("the public API's OpenAPI document", () => {
  it("assembles every fragment into one OpenAPI 3.1 document, served as its JSON", () => {
    expect(PUBLIC_API_FRAGMENTS).toEqual([
      "common",
      "organizations",
      "configurations",
      "validation-pipelines",
      "validate",
      "ottl",
      "fleets",
      "flows",
      "test-runs",
    ]);
    const document = publicApiDocument();
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([{ url: "/api/public/v1" }]);
    expect(document.security).toEqual([{ bearer: [], organization: [] }, { bearer: [] }]);
    expect(document.components.securitySchemes).toEqual({
      bearer: expect.objectContaining({ type: "http", scheme: "bearer" }),
      organization: expect.objectContaining({ type: "apiKey", in: "header", name: "X-Telflo-Org" }),
    });
    // The shared components every area refers to (Ruling 160).
    for (const name of ["Error", "ValidationErrorItem", "ListPage"]) expect(document.components.schemas).toHaveProperty(name);
    expect(document.components.schemas!.ValidationErrorItem).toMatchObject({ required: ["message", "componentPath"] });
    expect(document.components.schemas!.ListPage).toMatchObject({ required: ["items", "nextCursor"] });
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(["/health", "/whoami"]));
    expect(JSON.parse(publicApiDocumentJson())).toEqual(document);
  });

  it("refuses a path two fragments define", () => {
    const read = fragments({ a: "paths:\n  /x:\n    get: {}\n", b: "paths:\n  /x:\n    post: {}\n" });
    expect(() => assemblePublicApiDocument(["a", "b"], read)).toThrow("OpenAPI path /x is defined twice (again in b)");
  });

  it("refuses a component two fragments define", () => {
    const read = fragments({ a: "components:\n  schemas:\n    X: {}\n", b: "components:\n  schemas:\n    X: {}\n" });
    expect(() => assemblePublicApiDocument(["a", "b"], read)).toThrow("OpenAPI component schemas.X is defined twice (again in b)");
  });

  it("refuses a duplicate key within one fragment, and anything but paths and components at its top", () => {
    expect(() => assemblePublicApiDocument(["a"], fragments({ a: "paths:\n  /x: {}\n  /x: {}\n" }))).toThrow();
    expect(() => assemblePublicApiDocument(["a"], fragments({ a: "info:\n  title: x\n" }))).toThrow(
      "OpenAPI fragment a has an unexpected key: info",
    );
  });
});
