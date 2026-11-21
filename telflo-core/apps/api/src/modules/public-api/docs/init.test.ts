import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

/*
 * The reference page's start, init.js, run as the browser runs it (a
 * classic script) in a context of its own, with Swagger UI's entry point,
 * the DOM and MutationObserver stood in: the options Swagger UI gets, the
 * autocomplete fix (Firefox's form history stored the token without it),
 * the tokenless curl block and the cookie-free requests. The three fixes
 * are also driven in the real bundle, in three browsers, by
 * e2e/api-reference.e2e.ts.
 */

const INIT = readFileSync(new URL("./init.js", import.meta.url), "utf8");

/** A stand-in input: its attributes, as setAttribute leaves them. */
class FakeField {
  readonly attributes = new Map<string, string>();
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

/** A stand-in for Immutable's Map, as the curl component's `request` prop is one. */
class FakeImmutable {
  constructor(readonly entries: Record<string, unknown>) {}
  get(key: string): unknown {
    return this.entries[key];
  }
  setIn([first, second]: [string, string], value: unknown): FakeImmutable {
    const inner = this.entries[first] as FakeImmutable;
    return new FakeImmutable({ ...this.entries, [first]: new FakeImmutable({ ...inner.entries, [second]: value }) });
  }
}

/** Runs init.js once; answers what it gave Swagger UI and the DOM stand-ins. */
function runInit() {
  const fields: FakeField[] = [];
  const observers: Array<{ callback: () => void; target: unknown; options: unknown }> = [];
  const configs: Array<Record<string, unknown>> = [];
  const documentElement = {};
  const context = createContext({
    SwaggerUIBundle: (config: Record<string, unknown>) => void configs.push(config),
    MutationObserver: class {
      constructor(private readonly callback: () => void) {}
      observe(target: unknown, options: unknown) {
        observers.push({ callback: this.callback, target, options });
      }
    },
    document: {
      documentElement,
      querySelectorAll: (selector: string) => (selector === "input, textarea" ? fields : []),
    },
  });
  runInContext(INIT, context);
  return { fields, observers, configs, documentElement };
}

describe("the API reference page's init.js", () => {
  it("starts Swagger UI once on the public document, with the page's options", () => {
    const { configs } = runInit();
    expect(configs).toHaveLength(1);
    const config = configs[0]!;
    expect({
      url: config.url,
      dom_id: config.dom_id,
      persistAuthorization: config.persistAuthorization,
      tryItOutEnabled: config.tryItOutEnabled,
      deepLinking: config.deepLinking,
      validatorUrl: config.validatorUrl,
      queryConfigEnabled: config.queryConfigEnabled,
      requestSnippetsEnabled: config.requestSnippetsEnabled,
      withCredentials: config.withCredentials,
    }).toEqual({
      url: "/api/public/v1/openapi.json",
      dom_id: "#swagger-ui",
      persistAuthorization: false,
      tryItOutEnabled: true,
      deepLinking: false,
      validatorUrl: null,
      queryConfigEnabled: false,
      requestSnippetsEnabled: false,
      withCredentials: false,
    });
    // No option that reads a configuration from elsewhere, or keeps the token.
    expect(Object.keys(config).filter((key) => /^(configUrl|urls|oauth2RedirectUrl|persist)/.test(key))).toEqual(["persistAuthorization"]);
  });

  it("marks every input and textarea autocomplete=off as the page changes, so no browser keeps a typed token", () => {
    const { fields, observers, documentElement } = runInit();
    expect(observers).toHaveLength(1);
    expect(observers[0]!.target).toBe(documentElement);
    expect(observers[0]!.options).toEqual({ childList: true, subtree: true });
    // The Authorize dialog's fields appear later: the observer marks them.
    fields.push(new FakeField(), new FakeField());
    observers[0]!.callback();
    expect(fields.map((field) => field.getAttribute("autocomplete"))).toEqual(["off", "off"]);
    fields.push(new FakeField());
    observers[0]!.callback();
    expect(fields.every((field) => field.getAttribute("autocomplete") === "off")).toBe(true);
  });

  it("sends every request without credentials (the public surface reads no cookie)", () => {
    const { configs } = runInit();
    const intercept = configs[0]!.requestInterceptor as (request: Record<string, unknown>) => Record<string, unknown>;
    const request = { url: "/api/public/v1/whoami", credentials: "same-origin" };
    expect(intercept(request)).toBe(request);
    expect(request.credentials).toBe("omit");
  });

  it("shows the curl block with Authorization: Bearer $TELFLO_TOKEN, never the typed token", () => {
    const { configs } = runInit();
    const plugins = configs[0]!.plugins as Array<(system: unknown) => { wrapComponents: Record<string, unknown> }>;
    expect(plugins).toHaveLength(1);
    const rendered: Array<{ props: { request: FakeImmutable } }> = [];
    const system = { React: { createElement: (_type: unknown, props: { request: FakeImmutable }) => rendered.push({ props }) } };
    const wrap = plugins[0]!(system).wrapComponents.curl as (original: unknown) => (props: { request: FakeImmutable }) => unknown;
    const curl = wrap("Curl");
    const typed = `tf_${"Q".repeat(43)}`;
    curl({ request: new FakeImmutable({ url: "/api/public/v1/whoami", headers: new FakeImmutable({ Authorization: `Bearer ${typed}`, Accept: "*/*" }) }) });
    const shown = rendered[0]!.props.request.get("headers") as FakeImmutable;
    // Booleans only: a failure prints no token-shaped text.
    expect(shown.get("Authorization") === "Bearer $TELFLO_TOKEN").toBe(true);
    expect(shown.get("Accept")).toBe("*/*");
    expect(JSON.stringify(rendered).includes(typed)).toBe(false);
    // A request without the header is shown as it is.
    const plain = new FakeImmutable({ url: "/api/public/v1/health", headers: new FakeImmutable({ Accept: "*/*" }) });
    curl({ request: plain });
    expect(rendered[1]!.props.request).toBe(plain);
  });
});
