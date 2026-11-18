import { describe, expect, it } from "vitest";
import {
  CreateHelmQuickDeployLinkRequestSchema,
  CreateLinuxQuickDeployLinkRequestSchema,
  CreateQuickDeployLinkRequestSchema,
  CreateQuickDeployLinkResponseSchema,
  ExtendQuickDeployLinkRequestSchema,
  ListQuickDeployLinksQuerySchema,
  PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE,
  QUICK_DEPLOY_LINK_ERROR_CODES,
  QUICK_DEPLOY_LINK_ERROR_MESSAGES,
  QUICK_DEPLOY_LINK_EXTENSION_LABELS,
  QUICK_DEPLOY_LINK_EXTENSIONS,
  QUICK_DEPLOY_MASKED_SECRET,
  QUICK_DEPLOY_PUBLIC_API_URL_PATTERN,
  QUICK_DEPLOY_SECRET_PATTERN,
  QUICK_DEPLOY_URL_PATTERN,
  quickDeployLinkExpiryAfter,
  quickDeployLinkFirstExpiry,
  QuickDeployHelmChoicesSchema,
  QuickDeployLinkChoicesSchema,
  QuickDeployLinkResponseSchema,
  QuickDeployLinksPageSchema,
} from "./quick-deploy.js";

// D17c-2 decisions 5, 22 to 25 and 33; Preflight rulings 8, 15, 20 and 25.

const SECRET = `tqd_${"aZ09_-".repeat(7)}x`;
const LINK = {
  id: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e60",
  groupId: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e61",
  groupName: "Default",
  defaultTokenId: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e62",
  createdBy: { userId: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e63", email: "sam@acme.example" },
  choices: { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", executablePath: null, systemd: true, envNames: ["NGINX_ENV"] },
  createdAt: "2026-10-17T10:00:00.000Z",
  expiresAt: "2026-10-18T10:00:00.000Z",
  revokedAt: null,
  downloadCount: 0,
  lastDownloadedAt: null,
  status: "active",
};

const createIssuesOf = (body: unknown) => {
  const parsed = CreateQuickDeployLinkRequestSchema.safeParse(body);
  return parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
};

describe("the secret and the link's URL", () => {
  it("takes the secret's shape: tqd_ and 43 base64url characters", () => {
    expect(SECRET).toHaveLength(47);
    expect(QUICK_DEPLOY_SECRET_PATTERN.test(SECRET)).toBe(true);
  });

  it.each([
    ["42 characters", SECRET.slice(0, -1)],
    ["44 characters", `${SECRET}A`],
    ["another prefix", `tqx_${SECRET.slice(4)}`],
    ["an upper-case prefix", `TQD_${SECRET.slice(4)}`],
    ["no prefix", SECRET.slice(4)],
    ["standard base64's +", `${SECRET.slice(0, -1)}+`],
    ["standard base64's /", `${SECRET.slice(0, -1)}/`],
    ["padding", `${SECRET.slice(0, -1)}=`],
    ["a line break after it", `${SECRET}\n`],
    ["32 hex characters", "0123456789abcdef0123456789abcdef"],
  ])("refuses a secret with %s", (_label, secret) => {
    expect(QUICK_DEPLOY_SECRET_PATTERN.test(secret)).toBe(false);
  });

  it.each([
    "http://localhost:8080",
    "http://127.0.0.1:56899",
    "http://host.docker.internal:50080",
    "https://telflo.example",
    "https://telflo.example/base/path",
    "https://[::1]:8443",
    "http://gateway",
  ])("takes the API's base URL %s, and a link under it", (base) => {
    expect(QUICK_DEPLOY_PUBLIC_API_URL_PATTERN.test(base)).toBe(true);
    expect(QUICK_DEPLOY_URL_PATTERN.test(`${base}/api/v1/quick-deploy/${SECRET}`)).toBe(true);
  });

  it.each([
    "ftp://telflo.example",
    "telflo.example",
    "https://user:pw@telflo.example",
    "https://user@telflo.example",
    "https://telflo.example/",
    "https://telflo.example?x=1",
    "https://telflo.example#x",
    "https://telflo.example/a%20b",
    "https://telflo.example/a b",
    "https://telflo.example/it's",
    'https://telflo.example/"x"',
    "https://telflo.example/$(echo EXPANDED)",
    "https://telflo.example/`echo EXPANDED`",
    "https://telflo.example/a\\b",
    "https://-telflo.example",
    "https://telflo.example:port",
  ])("refuses the base URL %s, and a link under it", (base) => {
    expect(QUICK_DEPLOY_PUBLIC_API_URL_PATTERN.test(base)).toBe(false);
    expect(QUICK_DEPLOY_URL_PATTERN.test(`${base}/api/v1/quick-deploy/${SECRET}`)).toBe(false);
  });

  it.each([
    ["another path", `https://telflo.example/api/v1/quick-deploys/${SECRET}`],
    ["a bad secret", `https://telflo.example/api/v1/quick-deploy/${SECRET.slice(0, -1)}`],
    ["a trailing slash", `https://telflo.example/api/v1/quick-deploy/${SECRET}/`],
    ["a query", `https://telflo.example/api/v1/quick-deploy/${SECRET}?x=1`],
    ["no secret", "https://telflo.example/api/v1/quick-deploy/"],
  ])("refuses a link with %s", (_label, url) => {
    expect(QUICK_DEPLOY_URL_PATTERN.test(url)).toBe(false);
  });

  it("masks the secret with its prefix only", () => {
    expect(QUICK_DEPLOY_MASKED_SECRET).toBe("tqd_••••••••");
    expect(QUICK_DEPLOY_SECRET_PATTERN.test(QUICK_DEPLOY_MASKED_SECRET)).toBe(false);
  });
});

describe("CreateQuickDeployLinkRequestSchema", () => {
  const request = { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", env: [{ name: "NGINX_ENV", value: "prod" }], systemd: true };

  it("takes a bundle request's fields and systemd, a path's trailing / removed", () => {
    expect(CreateQuickDeployLinkRequestSchema.parse({ ...request, rootPath: "/etc/otelcol/" })).toEqual(request);
    expect(
      CreateQuickDeployLinkRequestSchema.parse({ ...request, method: "own-binary", arch: "arm64", executablePath: "/usr/bin/otelcol-contrib", systemd: false, env: [] }),
    ).toEqual({ ...request, method: "own-binary", arch: "arm64", executablePath: "/usr/bin/otelcol-contrib", systemd: false, env: [] });
  });

  it.each([
    ["no systemd", (({ systemd: _systemd, ...rest }) => rest)(request), [{ path: "systemd", message: "Required" }]],
    ["systemd as a string", { ...request, systemd: "true" }, [{ path: "systemd", message: "Expected boolean, received string" }]],
    ["an unknown field", { ...request, displayName: "web-1" }, [{ path: "", message: "Unrecognized key(s) in object: 'displayName'" }]],
    ["a secret", { ...request, secret: SECRET }, [{ path: "", message: "Unrecognized key(s) in object: 'secret'" }]],
    ["Kubernetes", { ...request, method: "kubernetes" }, [{ path: "method", message: "Invalid enum value. Expected 'all-in-one' | 'own-binary', received 'kubernetes'" }]],
    ["a relative root", { ...request, rootPath: "etc/otelcol" }, [{ path: "rootPath", message: "Use an absolute path, starting with /." }]],
    ["own-binary without its executable", { ...request, method: "own-binary" }, [{ path: "executablePath", message: "Type the path to otelcol-contrib." }]],
    [
      "All In One with an executable",
      { ...request, executablePath: "/usr/bin/otelcol-contrib" },
      [{ path: "executablePath", message: "All In One installs its own collector: no executable path." }],
    ],
    [
      "a variable twice",
      { ...request, env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] },
      [{ path: "env.1.name", message: "Each variable once." }],
    ],
    [
      "a value with a line break",
      { ...request, env: [{ name: "A", value: "1\n2" }] },
      [{ path: "env.0.value", message: "Use no control characters (a line break or a tab, say)." }],
    ],
    ["an empty value", { ...request, env: [{ name: "A", value: "" }] }, [{ path: "env.0.value", message: "Type a value or untick it." }]],
    [
      "51 variables",
      { ...request, env: Array.from({ length: 51 }, (_, index) => ({ name: `V${index}`, value: "x" })) },
      [{ path: "env", message: "At most 50 variables." }],
    ],
  ])("refuses %s", (_label, body, issues) => {
    expect(createIssuesOf(body)).toEqual(issues);
  });
});

// D17d-2 decision 21, Preflight rulings 11 and 12: the create's body by kind. D17c-2's Linux body (no kind) keeps
// every one of its 400s above; a Helm values link's body is its kind and its variables.
describe("CreateQuickDeployLinkRequestSchema by kind", () => {
  const linux = { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", env: [{ name: "NGINX_ENV", value: "prod" }], systemd: true };
  const helm = { kind: "helm", env: [{ name: "LOKI_TENANT", value: "acme" }] };

  it("takes a Linux body without kind, or with kind linux, adding no kind to the first", () => {
    expect(CreateQuickDeployLinkRequestSchema.parse(linux)).toEqual(linux);
    expect(CreateQuickDeployLinkRequestSchema.parse(linux)).not.toHaveProperty("kind");
    expect(CreateQuickDeployLinkRequestSchema.parse({ ...linux, kind: "linux" })).toEqual({ ...linux, kind: "linux" });
    expect(CreateLinuxQuickDeployLinkRequestSchema.parse(linux)).toEqual(linux);
  });

  it("takes a Helm values link's body: its kind and up to 50 variables", () => {
    expect(CreateQuickDeployLinkRequestSchema.parse(helm)).toEqual(helm);
    expect(CreateQuickDeployLinkRequestSchema.parse({ kind: "helm", env: [] })).toEqual({ kind: "helm", env: [] });
    expect(CreateHelmQuickDeployLinkRequestSchema.parse(helm)).toEqual(helm);
  });

  it.each([
    ["an unknown kind", { ...helm, kind: "windows" }, "kind"],
    ["kind null", { ...linux, kind: null }, "kind"],
    ["a Helm body with a Linux field", { ...helm, method: "all-in-one" }, ""],
    ["a Helm body with a release", { ...helm, release: "telflo-node" }, ""],
    ["a Helm body with systemd", { ...helm, systemd: true }, ""],
    ["a Helm body without env", { kind: "helm" }, "env"],
    ["a Helm variable twice", { kind: "helm", env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }, "env.1.name"],
    ["a Helm value with a line break", { kind: "helm", env: [{ name: "A", value: "1\n2" }] }, "env.0.value"],
    ["a Helm value with a lone surrogate (Ruling 36)", { kind: "helm", env: [{ name: "A", value: "1\ud800" }] }, "env.0.value"],
    ["a Helm variable that isn't a shell name", { kind: "helm", env: [{ name: "1A", value: "1" }] }, "env.0.name"],
    ["51 Helm variables", { kind: "helm", env: Array.from({ length: 51 }, (_, index) => ({ name: `V${index}`, value: "x" })) }, "env"],
    ["a Linux body with kind helm", { ...linux, kind: "helm" }, ""],
  ])("refuses %s, at its field", (_label, body, path) => {
    const issues = createIssuesOf(body);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.path).toBe(path);
  });

  it("keeps D17c-2's Linux 400s through the union: each variable once, the arch's enum", () => {
    expect(createIssuesOf({ ...linux, env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] })).toEqual([
      { path: "env.1.name", message: "Each variable once." },
    ]);
    expect(createIssuesOf({ ...linux, kind: "linux", arch: "x86" })).toEqual([
      { path: "arch", message: "Invalid enum value. Expected 'amd64' | 'arm64', received 'x86'" },
    ]);
  });

  it("refuses a Linux link's value with a lone surrogate at env.0.value, its words fixed (Ruling 36; Ruling 37's Nit 1)", () => {
    for (const value of ["1\ud800", "\udfff", "a\ud83d"]) {
      const parsed = CreateLinuxQuickDeployLinkRequestSchema.safeParse({ ...linux, env: [{ name: "A", value }] });
      expect(parsed.success).toBe(false);
      const issues = parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      expect(issues).toEqual([{ path: "env.0.value", message: "Use only whole characters (not half of an emoji, say)." }]);
    }
    expect(CreateLinuxQuickDeployLinkRequestSchema.safeParse({ ...linux, env: [{ name: "A", value: "a\ud83d\ude00" }] }).success).toBe(true);
  });

  it("refuses a Helm body on the Linux link's route (a 400 until the Helm link's create is served)", () => {
    expect(CreateLinuxQuickDeployLinkRequestSchema.safeParse(helm).success).toBe(false);
    expect(CreateLinuxQuickDeployLinkRequestSchema.safeParse({ ...linux, kind: "helm" }).success).toBe(false);
  });
});

describe("a link's choices by kind (Preflight ruling 11)", () => {
  const helmChoices = { kind: "helm", role: "node", release: "telflo-node", namespace: "observability", envNames: ["LOKI_TENANT"] };

  it("reads a stored Linux row without kind as a Linux link's, adding no kind", () => {
    const parsed = QuickDeployLinkChoicesSchema.parse(LINK.choices);
    expect(parsed).toEqual(LINK.choices);
    expect(parsed).not.toHaveProperty("kind");
    expect(QuickDeployLinkChoicesSchema.parse({ ...LINK.choices, kind: "linux" })).toEqual({ ...LINK.choices, kind: "linux" });
  });

  it("takes a Helm values link's choices: its role, release, namespace and variables' names, and lists such a link", () => {
    expect(QuickDeployLinkChoicesSchema.parse(helmChoices)).toEqual(helmChoices);
    for (const role of ["cluster", "gateway"]) expect(QuickDeployHelmChoicesSchema.parse({ ...helmChoices, role })).toEqual({ ...helmChoices, role });
    const link = { ...LINK, choices: helmChoices };
    expect(QuickDeployLinksPageSchema.parse({ links: [link, LINK], nextCursor: null })).toEqual({ links: [link, LINK], nextCursor: null });
  });

  it.each([
    ["an unknown kind", { ...helmChoices, kind: "windows" }],
    ["a Helm link's Linux field", { ...helmChoices, rootPath: "/etc/otelcol" }],
    ["a Helm link's values", { ...helmChoices, env: [{ name: "LOKI_TENANT", value: "acme" }] }],
    ["a Helm link's bearer", { ...helmChoices, token: "QmVhcmVy" }],
    ["a Helm link without its role", (({ role: _role, ...rest }) => rest)(helmChoices)],
    ["a Helm link of an unknown role", { ...helmChoices, role: "daemon" }],
    ["a Helm link without its namespace", (({ namespace: _namespace, ...rest }) => rest)(helmChoices)],
    ["a Linux link's Helm field", { ...LINK.choices, release: "telflo-node" }],
    ["a Linux row with kind helm", { ...LINK.choices, kind: "helm" }],
  ])("refuses choices with %s", (_label, choices) => {
    expect(QuickDeployLinkChoicesSchema.safeParse(choices).success).toBe(false);
  });
});

describe("the link's replies", () => {
  it("takes a link with every field, as the list, the create, an extend and a revoke answer it", () => {
    expect(QuickDeployLinkResponseSchema.parse({ link: LINK })).toEqual({ link: LINK });
    expect(QuickDeployLinksPageSchema.parse({ links: [LINK], nextCursor: null })).toEqual({ links: [LINK], nextCursor: null });
    const created = { link: LINK, url: `http://localhost:8080/api/v1/quick-deploy/${SECRET}` };
    expect(CreateQuickDeployLinkResponseSchema.parse(created)).toEqual(created);
    const gone = { ...LINK, groupName: null, createdBy: null, expiresAt: null, status: "revoked", revokedAt: "2026-10-17T11:00:00.000Z" };
    expect(QuickDeployLinkResponseSchema.parse({ link: gone })).toEqual({ link: gone });
  });

  it.each([
    ["a secret", { ...LINK, secret: SECRET }],
    ["a hash", { ...LINK, secretHash: "0".repeat(64) }],
    ["the values", { ...LINK, choices: { ...LINK.choices, env: [{ name: "NGINX_ENV", value: "prod" }] } }],
    ["envValuesSet", { ...LINK, envValuesSet: true }],
    ["an unknown status", { ...LINK, status: "token_revoked" }],
    ["a negative count", { ...LINK, downloadCount: -1 }],
    ["a time with an offset", { ...LINK, createdAt: "2026-10-17T10:00:00+02:00" }],
  ])("refuses a link holding %s", (_label, link) => {
    expect(QuickDeployLinkResponseSchema.safeParse({ link }).success).toBe(false);
  });

  it("refuses a create's reply whose url isn't a link, or that carries the secret beside it", () => {
    for (const reply of [
      { link: LINK, url: SECRET },
      { link: LINK, url: `http://localhost:8080/api/v1/quick-deploy/${SECRET}/x` },
      { link: LINK, url: `http://localhost:8080/api/v1/quick-deploy/${SECRET}`, secret: SECRET },
    ]) {
      expect(CreateQuickDeployLinkResponseSchema.safeParse(reply).success).toBe(false);
    }
  });

  it("pages 1 to 100 links, 50 by default", () => {
    expect(ListQuickDeployLinksQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ListQuickDeployLinksQuerySchema.parse({ limit: "100", cursor: "c" })).toEqual({ limit: 100, cursor: "c" });
    for (const query of [{ limit: "0" }, { limit: "101" }, { limit: "1.5" }, { cursor: "" }, { cursor: "x".repeat(2049) }, { sort: "created" }]) {
      expect({ query, success: ListQuickDeployLinksQuerySchema.safeParse(query).success }).toEqual({ query, success: false });
    }
  });
});

describe("extending a link (decision 5, Preflight ruling 25)", () => {
  const now = new Date("2026-10-17T10:30:00.000Z");

  it("offers the presets, in order, with their words", () => {
    expect(QUICK_DEPLOY_LINK_EXTENSIONS).toEqual(["1d", "1w", "1mo", "180d", "1y", "never"]);
    expect(QUICK_DEPLOY_LINK_EXTENSIONS.map((by) => QUICK_DEPLOY_LINK_EXTENSION_LABELS[by])).toEqual([
      "1 day",
      "1 week",
      "1 month",
      "180 days",
      "1 year",
      "Never",
    ]);
  });

  it("takes one preset, and nothing else", () => {
    expect(ExtendQuickDeployLinkRequestSchema.parse({ by: "1mo" })).toEqual({ by: "1mo" });
    for (const body of [{}, { by: "2d" }, { by: "never", from: "expiry" }, { by: 86_400 }]) {
      expect({ body, success: ExtendQuickDeployLinkRequestSchema.safeParse(body).success }).toEqual({ body, success: false });
    }
  });

  it("counts each from now, in UTC", () => {
    expect(
      Object.fromEntries(QUICK_DEPLOY_LINK_EXTENSIONS.map((by) => [by, quickDeployLinkExpiryAfter(by, now)?.toISOString() ?? null])),
    ).toEqual({
      "1d": "2026-10-18T10:30:00.000Z",
      "1w": "2026-10-24T10:30:00.000Z",
      "1mo": "2026-11-17T10:30:00.000Z",
      "180d": "2027-04-15T10:30:00.000Z",
      "1y": "2027-10-17T10:30:00.000Z",
      never: null,
    });
  });

  it("keeps a month's day, or takes the shorter month's last, and a year's Feb 29 is Feb 28", () => {
    expect(quickDeployLinkExpiryAfter("1mo", new Date("2027-01-31T23:00:00.000Z"))!.toISOString()).toBe("2027-02-28T23:00:00.000Z");
    expect(quickDeployLinkExpiryAfter("1mo", new Date("2028-01-31T00:00:00.000Z"))!.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(quickDeployLinkExpiryAfter("1mo", new Date("2026-12-15T00:00:00.000Z"))!.toISOString()).toBe("2027-01-15T00:00:00.000Z");
    expect(quickDeployLinkExpiryAfter("1y", new Date("2028-02-29T12:00:00.000Z"))!.toISOString()).toBe("2029-02-28T12:00:00.000Z");
  });

  it("gives a new link 24 hours", () => {
    expect(quickDeployLinkFirstExpiry(now).toISOString()).toBe("2026-10-18T10:30:00.000Z");
  });
});

describe("the refusals (Preflight ruling 15)", () => {
  it("are the six codes, each with its words (D17d-2's public_install_links_disabled the sixth)", () => {
    expect(QUICK_DEPLOY_LINK_ERROR_CODES).toEqual([
      "quick_deploy_link_not_found",
      "quick_deploy_link_revoked",
      "quick_deploy_link_limit_reached",
      "enrollment_token_default_missing",
      "collector_group_variables_changed",
      "public_install_links_disabled",
    ]);
    expect(QUICK_DEPLOY_LINK_ERROR_MESSAGES).toEqual({
      quick_deploy_link_not_found: "Install link not found.",
      quick_deploy_link_revoked: "This install link is revoked: make a new one.",
      quick_deploy_link_limit_reached: "Revoke an install link first: a fleet holds at most 100 active links.",
      enrollment_token_default_missing: "The fleet's default token is revoked. Issue a new one on the Tokens tab, then install.",
      collector_group_variables_changed:
        "This group's published version no longer reads the variables this link was made with: make a new link.",
      public_install_links_disabled:
        "Public install links are turned off for this organization: an admin can turn them on in Settings → Organization.",
    });
  });

  it("refuse a link's download while the organization's switch is off with A-10's words", () => {
    expect(PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE).toBe("Install links are turned off for this organization.");
  });
});
