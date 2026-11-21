import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ListVariablesResult, OpampServerClient } from "../../opamp-server/client.js";
import {
  fillInRunText,
  NO_VALUES,
  opampOrganizationVariables,
  references,
  render,
  renderedLength,
  type IOrganizationVariables,
  type OrganizationVariablesRead,
} from "./organization-variables.js";

/*
 * The port of the opamp-server's fill-in (store/orgvariables/render.go),
 * held to it by the shared corpus, read by a path relative to this file.
 */

const CORPUS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../vendor/opamp-server/org-token-corpus.json",
);

const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as {
  render: { name: string; text: string; vars: Record<string, string>; expected: string; names: string[] }[];
  extract: { name: string; text: string; expected: string[] }[];
};

const valuesOf = (vars: Record<string, string>) => new Map(Object.entries(vars));

/** What the collector's confmap makes of a filled-in scalar: each `$$` collapsed to `$`, left to right. */
const collapsed = (text: string) => text.replaceAll("$$", () => "$");

describe("the fill-in, against the corpus", () => {
  it("reads the corpus' rows", () => {
    expect(corpus.render.length).toBeGreaterThan(20);
    expect(corpus.extract.length).toBeGreaterThan(5);
  });

  it.each(corpus.render.map((row) => [row.name, row] as const))("renders the corpus' row %s", (_name, row) => {
    expect(render(row.text, valuesOf(row.vars))).toBe(row.expected);
  });

  it.each(corpus.render.map((row) => [row.name, row] as const))(
    "measures the corpus' row %s as long as its rendering, with its names",
    (_name, row) => {
      expect(renderedLength(row.text, valuesOf(row.vars))).toEqual({ length: row.expected.length, names: row.names });
    },
  );

  it.each(corpus.render.map((row) => [row.name, row] as const))("references the corpus' row %s's names", (_name, row) => {
    expect(references(row.text)).toEqual(row.names);
  });

  it.each(corpus.extract.map((row) => [row.name, row] as const))("agrees with the corpus' extract row %s", (_name, row) => {
    expect(references(row.text)).toEqual(row.expected);
  });
});

describe("the fill-in", () => {
  it("fills in each live reference whose name is known, inside a larger scalar too, behind an odd run of $ too", () => {
    const values = new Map([
      ["PROD_OTLP", "https://otlp.example:4318"],
      ["REGION", "eu-west-1"],
    ]);
    expect(render("endpoint: ${org:PROD_OTLP}/v1\nlabel: a-${org:REGION}-b\nc: $$${org:REGION}\n", values)).toBe(
      "endpoint: https://otlp.example:4318/v1\nlabel: a-eu-west-1-b\nc: $$eu-west-1\n",
    );
  });

  it("writes a value's every $ doubled, so confmap's pass gives back the value exactly", () => {
    const values = ["a$b", "$$", "$", "${env:HOME}", "$${org:X}", "x$$$y", "plain", "", "é$😀$"];
    for (const value of values) {
      const filled = render("v: ${org:V}\n", new Map([["V", value]]));
      expect(filled).toBe(`v: ${value.split("$").join("$$")}\n`);
      expect(collapsed(filled.slice("v: ".length, -1))).toBe(value);
    }
  });

  it("leaves the legacy form, an escaped reference and a default's form as written", () => {
    const values = new Map([["HOST", "x.example"]]);
    for (const text of ["a: $orgvar:HOST\n", "a: $${org:HOST}\n", "a: ${org:HOST:-y}\n", "a: $$orgvar:HOST\n"]) {
      expect(render(text, values)).toBe(text);
      expect(references(text)).toEqual([]);
    }
  });

  it("names every live reference once, in the order first seen, defined or not", () => {
    const text = "a: ${org:B}\nb: ${org:A}\nc: ${org:B}\nd: ${org:C}\n";
    expect(references(text)).toEqual(["B", "A", "C"]);
    expect(renderedLength(text, new Map([["A", "1"]])).names).toEqual(["B", "A", "C"]);
  });

  it("returns a text in which nothing is filled in as it is", () => {
    const text = "a: ${org:UNKNOWN}\nb: plain\n";
    expect(render(text, new Map([["OTHER", "x"]]))).toBe(text);
    expect(render(text, NO_VALUES)).toBe(text);
    expect(render("", new Map([["A", "x"]]))).toBe("");
  });

  it("never takes a value from an object's prototype: a NAME such as constructor is unknown until defined", () => {
    const text = "a: ${org:constructor}\nb: ${org:__proto__}\nc: ${org:toString}\n";
    expect(render(text, NO_VALUES)).toBe(text);
    expect(renderedLength(text, NO_VALUES).length).toBe(text.length);
    expect(render(text, new Map([["constructor", "c"]]))).toBe("a: c\nb: ${org:__proto__}\nc: ${org:toString}\n");
  });

  it("counts UTF-16 code units, the unit TEST_RUN_YAML_MAXIMUM_LENGTH counts", () => {
    // 😀 is one code point, two code units; é and € one each.
    const values = new Map([["U", "é€😀$"]]);
    const text = "a: ${org:U} ${org:U}\n";
    const filled = render(text, values);
    expect(filled).toBe("a: é€😀$$ é€😀$$\n");
    expect(renderedLength(text, values).length).toBe(filled.length);
    expect(filled.length).toBe(text.length + 2 * ("é€😀$$".length - "${org:U}".length));
  });

  it("agrees with its own rendering's length on the escape cases", () => {
    const values = new Map([
      ["A", "$"],
      ["B", "b$$"],
      ["LONG", "$".repeat(64)],
    ]);
    for (const text of [
      "${org:A}",
      "$${org:A}",
      "$$${org:A}",
      "$$$${org:A}",
      "${org:A}${org:B}${org:A}",
      "x${org:LONG}y$${org:LONG}z",
      "${org:A",
      "${org:}",
      "${org:${org:A}}",
      "${org:A}}",
    ]) {
      expect(renderedLength(text, values).length).toBe(render(text, values).length);
    }
  });

  it("measures an oversized fill-in without building it", () => {
    // About 466,000 references to a value of 1,024 $ (the longest a value can
    // be) in 4 Mi code units: 954 million code units filled in, past the
    // longest string V8 can build, so the length can only have been counted.
    const reference = "${org:P}\n";
    const count = Math.floor(4 * 1_048_576 / reference.length);
    const text = reference.repeat(count);
    const values = new Map([["P", "$".repeat(1_024)]]);
    const { length, names } = renderedLength(text, values);
    expect(length).toBe(text.length + count * (2 * 1_024 - "${org:P}".length));
    expect(length).toBeGreaterThan(2 ** 29);
    expect(names).toEqual(["P"]);
  });
});

const ORGANIZATION_ID = "0190a1b2-0000-7000-8000-000000000000";

/** A client whose listVariables answers `result`, counting the organizations it was asked for. */
function listing(result: ListVariablesResult): Pick<OpampServerClient, "listVariables"> & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    listVariables: (organizationId) => {
      asked.push(organizationId);
      return Promise.resolve(result);
    },
  };
}

function variable(name: string, value: string) {
  return { id: "0190a1b2-0000-7000-8000-0000000000aa", name, value, description: null, changedBy: null, changedAt: "2026-10-20T00:00:00Z" };
}

describe("opampOrganizationVariables", () => {
  it("reads the organization's values from listVariables, NAME to value", async () => {
    const client = listing({ kind: "listed", variables: [variable("A", "a$1"), variable("B", "")] });
    const read = await opampOrganizationVariables(client).read(ORGANIZATION_ID);
    expect(read).toEqual({ kind: "values", values: new Map([["A", "a$1"], ["B", ""]]) });
    expect(client.asked).toEqual([ORGANIZATION_ID]);
  });

  it("answers none for an organization the opamp-server doesn't hold", async () => {
    expect(await opampOrganizationVariables(listing({ kind: "organization_not_found" })).read(ORGANIZATION_ID)).toEqual({ kind: "none" });
  });

  it.each([
    [{ kind: "unavailable", reason: "timeout" }, "timeout"],
    [{ kind: "unavailable", reason: "network" }, "network"],
    [{ kind: "unavailable", reason: "server_error", status: 503 }, "server_error"],
    [{ kind: "unavailable", reason: "oversized_reply" }, "oversized_reply"],
    [{ kind: "invalid", code: "invalid_request" }, "invalid_request"],
  ] as const)("answers unavailable for %o, with its reason", async (result, reason) => {
    expect(await opampOrganizationVariables(listing(result)).read(ORGANIZATION_ID)).toEqual({ kind: "unavailable", reason });
  });
});

/** A source answering `read`, counting its reads. */
function source(read: OrganizationVariablesRead): IOrganizationVariables & { reads: number } {
  const counted = {
    reads: 0,
    read: () => {
      counted.reads += 1;
      return Promise.resolve(read);
    },
  };
  return counted;
}

describe("fillInRunText", () => {
  const options = { maximumLength: 100, build: true };

  it("reads nothing for a text with no live reference, an escaped or a legacy one included", async () => {
    const values = source({ kind: "unavailable", reason: "network" });
    for (const text of ["a: plain\n", "a: $${org:A}\n", "a: $orgvar:A\n", "a: ${org:A:-x}\n"]) {
      expect(await fillInRunText(values, ORGANIZATION_ID, text, options)).toEqual({ kind: "filled", text });
    }
    expect(values.reads).toBe(0);
  });

  it("fills in the values read, a $ doubled; measuring only, keeps the text as written", async () => {
    const values = source({ kind: "values", values: new Map([["A", "x$y"]]) });
    expect(await fillInRunText(values, ORGANIZATION_ID, "a: ${org:A}\n", options)).toEqual({ kind: "filled", text: "a: x$$y\n" });
    expect(await fillInRunText(values, ORGANIZATION_ID, "a: ${org:A}\n", { ...options, build: false })).toEqual({
      kind: "filled",
      text: "a: ${org:A}\n",
    });
    expect(values.reads).toBe(2);
  });

  it("leaves every reference as written when the organization has no variables", async () => {
    expect(await fillInRunText(source({ kind: "none" }), ORGANIZATION_ID, "a: ${org:A}\n", options)).toEqual({
      kind: "filled",
      text: "a: ${org:A}\n",
    });
  });

  it("answers the read's unavailability", async () => {
    expect(await fillInRunText(source({ kind: "unavailable", reason: "timeout" }), ORGANIZATION_ID, "a: ${org:A}\n", options)).toEqual({
      kind: "unavailable",
      reason: "timeout",
    });
  });

  it("refuses a text longer than the limit once filled in, counting UTF-16 code units, and takes one exactly at it", async () => {
    const text = "a: ${org:A}\n";
    // "a: " and "\n" are 4 units: a value of 96 fills in to exactly 100.
    const exactly = source({ kind: "values", values: new Map([["A", "x".repeat(96)]]) });
    expect(await fillInRunText(exactly, ORGANIZATION_ID, text, options)).toEqual({ kind: "filled", text: `a: ${"x".repeat(96)}\n` });
    // 48 surrogate pairs and one more code unit: 97 units, though 49 code points.
    const over = source({ kind: "values", values: new Map([["A", `${"😀".repeat(48)}x`]]) });
    expect(await fillInRunText(over, ORGANIZATION_ID, text, options)).toEqual({ kind: "too_long" });
    // 48 $ are 96 once doubled.
    const dollars = source({ kind: "values", values: new Map([["A", "$".repeat(48)]]) });
    expect(await fillInRunText(dollars, ORGANIZATION_ID, text, options)).toEqual({ kind: "filled", text: `a: ${"$".repeat(96)}\n` });
    const moreDollars = source({ kind: "values", values: new Map([["A", "$".repeat(49)]]) });
    expect(await fillInRunText(moreDollars, ORGANIZATION_ID, text, options)).toEqual({ kind: "too_long" });
  });
});
