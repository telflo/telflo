import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
 * One organization source for every read. Inside the playground the user
 * store may still hold a signed-in visitor's real organization; a hook
 * reading it there would send that organization's reads from a playground
 * page. Every other reader takes the organization from `useCurrentUser()`
 * (the visitor first; `readsFor` readers) or `useOrganizationForReads()`
 * (null inside the playground).
 *
 * Every non-test source file under apps/web/app is read with TypeScript's
 * own parser (no regex over the text, which comments, newlines and second
 * declarators get past). Refused, outside the allowlists below:
 * - an import of the store's module (any specifier naming `user-store`)
 *   other than its named, unaliased bindings: a default, namespace or
 *   aliased import; a dynamic `import(…)` (or `require`) naming it;
 * - any export declaration naming it (`export … from`), and any re-export
 *   (`export { x as y }`, `export default x`) of a binding imported from it;
 * - every reference to the identifier `useUserStore` that isn't one of
 *   today's exact uses (ALLOWED), each with its reason: a hook call, written
 *   out, or a `getState()` chain. Anything else is refused whatever it reads:
 *   a selector defined elsewhere, the whole state or current user,
 *   `.subscribe`, `.setState`, the store passed as an argument or assigned, a
 *   computed member. An entry no code uses any more is refused (stale).
 * - any `import.meta.glob` (or `globEager`) whose pattern could reach the
 *   store's module: one naming `user-store`, one starting inside
 *   `lib/stores/`, or one whose wildcards could descend into it;
 *   a pattern that isn't a literal is refused outright;
 * - any import of `app/test/` (the test helpers) from a source file.
 * The store's own module isn't scanned for uses; its exports are pinned
 * instead (STORE_EXPORTS): its value exports as the module itself has them
 * at run time, its type exports as the parser reads them. A new export fails
 * until listed. Its body is read too: no reference to `useUserStore` but its
 * declaration, and no write to `globalThis`, `window` or `self`.
 *
 * Every file Vite loads under app/ is read (`.ts .tsx .mts .cts .js .jsx
 * .mjs .cjs`; declaration files aside), but the tests (`*.test.*`) and the
 * top-level `app/test/` (their helpers, which no source may import).
 *
 * What it is: the backstop against the ordinary ways code reads the
 * organization, a hook or a helper written as code is written here. A
 * deliberately obfuscated read (a run-time-built import path, a key put
 * together from strings, a store reached through some other object) is
 * accepted residue behind the playground's e2e request allowlist
 * (e2e/support/playground.ts, in every playground spec and every browser),
 * which fails on any request such a read would send: that holds the line.
 */

const APP = dirname(dirname(fileURLToPath(import.meta.url)));

/** The store's own module, relative to apps/web/app. */
const STORE = "lib/stores/user-store.ts";

/** Whether a module specifier names the store's module, in any spelling (`~/lib/stores/user-store.js`, `./user-store`, …). */
function namesStore(specifier: string): boolean {
  return specifier.includes("user-store");
}

/** The store module's exports, exactly, each with why it reads no organization for a caller. */
const STORE_EXPORTS: Record<string, { kind: "value" | "type"; reason: string }> = {
  useUserStore: { kind: "value", reason: "the store itself: every use of it is held to ALLOWED below" },
  PREFERENCE_KEYS: { kind: "value", reason: "a constant: the preference keys" },
  readPreference: { kind: "value", reason: "a pure function of the preferences it is given" },
  withPreference: { kind: "value", reason: "a pure function of the preferences it is given" },
  numberPreferenceRead: { kind: "value", reason: "a counter for the preferences' reads, no state of the user" },
  StoredCurrentUser: { kind: "type", reason: "a type: /me's shape, no read" },
  PreferenceKey: { kind: "type", reason: "a type" },
  PreferenceValues: { kind: "type", reason: "a type" },
};

const listed = (kind: "value" | "type") =>
  Object.entries(STORE_EXPORTS)
    .filter(([, entry]) => entry.kind === kind)
    .map(([name]) => name)
    .sort();

interface AllowedUse {
  /** The use, written out: a hook call `useUserStore(…)` (whitespace collapsed), or a chain `getState()….`. */
  use: string;
  reason: string;
  /** Only in these files: the two that may read the organization. */
  only?: readonly string[];
}

/** Today's uses, exactly. */
const ALLOWED: readonly AllowedUse[] = [
  // The organization, in the two files that answer the playground's visitor first.
  { use: "useUserStore((state) => state.current)", reason: "useCurrentUser: the visitor first, then the store", only: ["lib/use-current-user.ts"] },
  {
    use: "useUserStore((state) => state.current?.organization.id ?? null)",
    reason: "useOrganizationForReads: the visitor first, null for the sample's",
    only: ["lib/organization-for-reads.ts"],
  },
  // The signed-in user's own id: who queued a run, who may act on a row.
  { use: "useUserStore((state) => state.current?.user.id ?? null)", reason: "the user's own id, not the organization" },
  { use: "getState().current?.user.id", reason: "the user's own id, not the organization" },
  // Preferences.
  {
    use: "useUserStore((state) => state.current?.preferences.theme ?? DEFAULT_USER_PREFERENCES.theme)",
    reason: "the theme preference",
  },
  {
    use: "useUserStore((state) => userId !== undefined && state.current?.user.id === userId ? state.current.preferences.theme : null)",
    reason: "the signed-in theme, for the given user only",
  },
  {
    use: "useUserStore((state) => state.current?.preferences.editor ?? DEFAULT_USER_PREFERENCES.editor)",
    reason: "the editor preferences",
  },
  { use: "getState().setPreference(", reason: "a setter: writes a preference" },
  { use: "getState().takePreferenceAnswer(", reason: "a setter: takes the API's answer" },
  { use: "getState().restorePreference(", reason: "a setter: puts a preference back" },
  // Flags and setters: they write, or name no organization.
  { use: "useUserStore((state) => state.isSwitchingOrganization)", reason: "a flag: whether a switch is under way" },
  { use: "useUserStore((state) => state.setSwitchingOrganization)", reason: "a setter" },
  { use: "useUserStore((state) => state.addOrganization)", reason: "a setter" },
  { use: "useUserStore((state) => state.updateOrganization)", reason: "a setter" },
  { use: "useUserStore((state) => state.setCurrent)", reason: "a setter: the layout seeds the store" },
  { use: "useUserStore((state) => state.reseedPreferences)", reason: "a setter" },
  { use: "getState().clear(", reason: "a setter: signing out" },
  // Presence only.
  { use: "getState().current !== null", reason: "whether anyone is signed in, nothing of whom" },
];

/** The extensions Vite loads as modules. */
const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Whether a file under apps/web/app (its path relative to it, `/`-separated)
 * is a source the guard reads: any module Vite loads, but declaration files,
 * the tests (`*.test.*`) and the top-level `test/` (a `test` folder
 * anywhere else is source like any other).
 */
function isSource(path: string): boolean {
  const name = posix.basename(path);
  if (!SOURCE_EXTENSION.test(name) || /\.d\.(ts|mts|cts)$/.test(name) || /\.test\.[^.]+$/.test(name)) return false;
  return path !== "test" && !path.startsWith("test/");
}

/** Every source file under apps/web/app (`isSource`), relative to it. */
function sourceFiles(directory = APP): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const under = relative(APP, path).split("\\").join("/");
    if (entry.isDirectory()) return under === "test" ? [] : sourceFiles(path);
    return isSource(under) ? [under] : [];
  });
}

/** `source` parsed as the file `file`, by its extension. */
function parsed(file: string, source: string): ts.SourceFile {
  const kind = /\.(tsx)$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.(jsx)$/.test(file)
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

/** The store module's folder, `/`-separated from apps/web's root (the folder over app/). */
const STORES_FOLDER = "app/lib/stores";

/** Where a module specifier or glob from `file` (relative to app/) points, `/`-separated from apps/web's root; null for a package. */
function resolvedFrom(file: string, specifier: string): string | null {
  if (specifier.startsWith("~/")) return posix.normalize(`app/${specifier.slice(2)}`);
  // Vite's root is apps/web: `/posts/*.mdx` is apps/web/posts.
  if (specifier.startsWith("/")) return posix.normalize(specifier.slice(1));
  if (specifier.startsWith("./") || specifier.startsWith("../")) return posix.normalize(posix.join("app", posix.dirname(file), specifier));
  return null;
}

/** A glob's one path segment as a regular expression (`*`, `?`, `{a,b}`, `[…]`). */
function segmentPattern(segment: string): RegExp {
  let pattern = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else if (char === "{") pattern += "(?:";
    else if (char === "}") pattern += ")";
    else if (char === "," && pattern.includes("(?:")) pattern += "|";
    else if (char === "[" || char === "]") pattern += char;
    else pattern += char.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

/** Whether a glob pattern from `file` could match the store's module. */
function globReachesStore(file: string, glob: string): boolean {
  if (namesStore(glob)) return true;
  const negated = glob.startsWith("!");
  if (negated) return false;
  const resolved = resolvedFrom(file, glob);
  if (resolved === null) return false;
  const segments = resolved.split("/");
  const firstWild = segments.findIndex((segment) => /[*?{[]/.test(segment));
  const fixed = (firstWild === -1 ? segments.slice(0, -1) : segments.slice(0, firstWild)).join("/");
  if (fixed === STORES_FOLDER || fixed.startsWith(`${STORES_FOLDER}/`)) return true;
  if (!STORES_FOLDER.startsWith(`${fixed}/`)) return false;
  // Above the store's folder: its wildcards reach it when they can walk down to a file inside it.
  const rest = segments.slice(fixed === "" ? 0 : fixed.split("/").length);
  if (rest.includes("**")) return true;
  const needed = STORES_FOLDER.slice(fixed.length + 1).split("/");
  return rest.length > needed.length && needed.every((component, index) => segmentPattern(rest[index]!).test(component));
}

/** Every node of `root`, depth first. */
function nodesOf(root: ts.Node): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    all.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return all;
}

/** A hook call as the list writes it: whitespace collapsed, no trailing comma. */
function normalized(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/,?\s*\)/g, ")").trim();
}

/** A string literal's text (a plain string or a template without substitutions), else null. */
function literalText(node: ts.Node | undefined): string | null {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

/** The imports and exports the guard refuses in `file`, as written. */
function refusedModuleUses(sourceFile: ts.SourceFile): string[] {
  const refused: string[] = [];
  /** The local names bound to the store module's exports. */
  const fromStore = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = literalText(statement.moduleSpecifier);
    if (specifier === null || !namesStore(specifier)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    const typeOnly = clause.isTypeOnly;
    if (clause.name !== undefined) {
      fromStore.add(clause.name.text);
      refused.push(statement.getText(sourceFile));
    }
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      fromStore.add(bindings.name.text);
      refused.push(statement.getText(sourceFile));
    }
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        fromStore.add(element.name.text);
        // An aliased value binding hides the store under another name.
        if (element.propertyName !== undefined && !typeOnly && !element.isTypeOnly) refused.push(element.getText(sourceFile));
      }
    }
  }
  for (const node of nodesOf(sourceFile)) {
    // Any export naming the store's module, and any re-export of a binding imported from it.
    if (ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== null && namesStore(specifier)) {
        refused.push(node.getText(sourceFile));
        continue;
      }
      if (node.moduleSpecifier === undefined && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const local = (element.propertyName ?? element.name).getText(sourceFile);
          if (fromStore.has(local)) refused.push(element.getText(sourceFile));
        }
      }
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression) && fromStore.has(node.expression.text)) {
      refused.push(node.getText(sourceFile));
    }
    // A glob that could reach the store's module: its pattern, or each of its patterns, a literal.
    if (ts.isCallExpression(node) && isImportMetaGlob(node.expression)) {
      const argument = node.arguments[0];
      const patterns =
        argument !== undefined && ts.isArrayLiteralExpression(argument) ? argument.elements.map((element) => literalText(element)) : [literalText(argument)];
      if (patterns.some((pattern) => pattern === null || globReachesStore(sourceFile.fileName, pattern))) refused.push(node.getText(sourceFile));
    }
    // A dynamic import, or a require, naming the store's module.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isImport || isRequire) {
        const argument = node.arguments[0];
        const text = literalText(argument) ?? (argument !== undefined && ts.isTemplateExpression(argument) ? argument.getText(sourceFile) : null);
        if (text !== null && namesStore(text)) refused.push(node.getText(sourceFile));
      }
    }
  }
  return refused;
}

/** Whether `callee` is `import.meta.glob` or `import.meta.globEager`. */
function isImportMetaGlob(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "glob" || callee.name.text === "globEager") &&
    ts.isMetaProperty(callee.expression) &&
    callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/** Every module specifier of `sourceFile` (imports, exports, dynamic imports, requires, globs), as written. */
function specifiersOf(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const node of nodesOf(sourceFile)) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      const text = literalText(node.moduleSpecifier);
      if (text !== null) specifiers.push(text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require") || isImportMetaGlob(callee);
      const argument = node.arguments[0];
      if (!loads || argument === undefined) continue;
      const texts = ts.isArrayLiteralExpression(argument) ? argument.elements.map((element) => literalText(element)) : [literalText(argument)];
      for (const text of texts) if (text !== null) specifiers.push(text);
    }
  }
  return specifiers;
}

/** The imports of `app/test/` (the test helpers) in `sourceFile`: none may be. */
function testHelperImports(sourceFile: ts.SourceFile): string[] {
  return specifiersOf(sourceFile).filter((specifier) => {
    const resolved = resolvedFrom(sourceFile.fileName, specifier);
    return resolved !== null && (resolved === "app/test" || resolved.startsWith("app/test/"));
  });
}

/** The roots a write to the page's globals goes through. */
const GLOBALS = new Set(["globalThis", "window", "self"]);

/** The identifier at the root of a member chain (`globalThis` of `globalThis.a["b"]`), else null. */
function rootOf(node: ts.Expression): string | null {
  let at: ts.Expression = node;
  while (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isNonNullExpression(at) || ts.isParenthesizedExpression(at)) {
    at = at.expression;
  }
  return ts.isIdentifier(at) ? at.text : null;
}

/** What the store module's body may not hold: a reference to `useUserStore` but its declaration, a write to the globals. */
function refusedInStore(source: string): string[] {
  const sourceFile = parsed(STORE, source);
  const refused: string[] = [];
  for (const node of nodesOf(sourceFile)) {
    if (ts.isIdentifier(node) && node.text === "useUserStore") {
      const declares = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      if (!declares) refused.push(normalized(node.parent.getText(sourceFile)).slice(0, 80));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      GLOBALS.has(rootOf(node.left) ?? "")
    ) {
      refused.push(normalized(node.getText(sourceFile)).slice(0, 80));
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const writer =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ((callee.expression.text === "Object" && ["defineProperty", "defineProperties", "assign"].includes(callee.name.text)) ||
          (callee.expression.text === "Reflect" && ["set", "defineProperty"].includes(callee.name.text)));
      const target = node.arguments[0];
      if (writer && target !== undefined && GLOBALS.has(rootOf(target) ?? "")) refused.push(normalized(node.getText(sourceFile)).slice(0, 80));
    }
  }
  return refused;
}

/** A `getState()` chain as the list writes it, from the `useUserStore.getState()` call `call`. */
function chainFrom(call: ts.CallExpression): string {
  let members = "";
  let at: ts.Node = call;
  while (ts.isPropertyAccessExpression(at.parent) && at.parent.expression === at) {
    members += `${at.parent.questionDotToken === undefined ? "." : "?."}${at.parent.name.text}`;
    at = at.parent;
  }
  const parent = at.parent;
  if (ts.isCallExpression(parent) && parent.expression === at) return `getState()${members}(`;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === at &&
    parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    parent.right.kind === ts.SyntaxKind.NullKeyword
  ) {
    return `getState()${members} !== null`;
  }
  if (ts.isElementAccessExpression(parent)) return `getState()${members}[`;
  if (ts.isNonNullExpression(parent)) return `getState()${members}!`;
  return `getState()${members}`;
}

/** Every reference to `useUserStore` in `sourceFile` outside its imports and exports, as the list writes it. */
function usesOf(sourceFile: ts.SourceFile): string[] {
  const uses: string[] = [];
  for (const node of nodesOf(sourceFile)) {
    if (!ts.isIdentifier(node) || node.text !== "useUserStore") continue;
    const parent = node.parent;
    // The import's own binding, and an export's (refused by refusedModuleUses).
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)) continue;
    if (ts.isCallExpression(parent) && parent.expression === node) {
      uses.push(normalized(parent.getText(sourceFile)));
      continue;
    }
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === "getState" &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      parent.parent.arguments.length === 0
    ) {
      uses.push(chainFrom(parent.parent));
      continue;
    }
    // Anything else: `.subscribe`, `.setState`, passed as an argument, assigned, a computed member, a declaration.
    uses.push(`useUserStore in ${ts.SyntaxKind[parent.kind]}: ${normalized(parent.getText(sourceFile)).slice(0, 60)}`);
  }
  return uses;
}

/** Whether `use` is allowed in `file`. */
function isAllowed(file: string, use: string): boolean {
  return ALLOWED.some((entry) => entry.use === use && (entry.only === undefined || entry.only.includes(file)));
}

/** Everything in `source` (the file `file`) the guard refuses, as written. */
function refused(file: string, source: string): string[] {
  const sourceFile = parsed(file, source);
  const imports = [...refusedModuleUses(sourceFile), ...testHelperImports(sourceFile).map((specifier) => `imports app/test: ${specifier}`)];
  if (file === STORE) return [...imports, ...refusedInStore(source)];
  return [...imports, ...usesOf(sourceFile).filter((use) => !isAllowed(file, use))];
}

/** A module's exports as the parser reads them: its values' names and its types' names, and `*` or `default` where it has them. */
function exportsOf(file: string, source: string): { values: string[]; types: string[] } {
  const sourceFile = parsed(file, source);
  const values: string[] = [];
  const types: string[] = [];
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      // Every declarator: `export const a = 1, b = 2` exports both.
      for (const declaration of statement.declarationList.declarations) {
        for (const node of nodesOf(declaration.name)) if (ts.isIdentifier(node)) values.push(node.text);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && exported(statement)) {
      values.push(isDefault(statement) || statement.name === undefined ? "default" : statement.name.text);
    } else if (ts.isEnumDeclaration(statement) && exported(statement)) {
      values.push(statement.name.text);
    } else if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && exported(statement)) {
      types.push(statement.name.text);
    } else if (ts.isExportAssignment(statement)) {
      values.push("default");
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) values.push("*");
      else if (ts.isNamespaceExport(clause)) values.push(clause.name.text);
      else {
        for (const element of clause.elements) (statement.isTypeOnly || element.isTypeOnly ? types : values).push(element.name.text);
      }
    }
  }
  return { values: values.sort(), types: types.sort() };
}

const STORE_SOURCE = readFileSync(join(APP, STORE), "utf8");

/** The store's source with `added` appended. */
const storeWith = (added: string) => `${STORE_SOURCE}\n${added}\n`;

describe("one organization source for every read: the user store's uses and exports, read by AST", () => {
  const files = sourceFiles().filter((file) => file !== STORE);

  it("pins the store module's exports: its values as the module has them at run time, its types as the parser reads them", async () => {
    const module = await import("~/lib/stores/user-store.js");
    expect(Object.keys(module).sort()).toEqual(listed("value"));
    const read = exportsOf(STORE, STORE_SOURCE);
    expect(read.values).toEqual(listed("value"));
    expect(read.types).toEqual(listed("type"));
  });

  it("refuses a new export of the store module, however it is written", () => {
    const hook = "useStoredOrganizationId";
    const shapes = [
      // A hook reading the organization.
      `export function ${hook}() {\n  return useUserStore((s) => s.current?.organization.id ?? null);\n}`,
      // A comment between `export` and its keyword.
      `export /* a note */ function ${hook}() {\n  return useUserStore((s) => s.current?.organization.id ?? null);\n}`,
      `export const selectOrganization = (s: UserState) => s.current?.organization;`,
      `const selectOrganization = 1;\nexport { selectOrganization };`,
      `export { inner as selectOrganization } from "./inner.js";`,
      `export * from "./organization.js";`,
      `export * as organization from "./organization.js";`,
      `export default function useOrganization() {}`,
      `export async function readOrganization() {}`,
      `export type OrganizationOnly = string;`,
      `export interface OrganizationOnly { id: string }`,
    ];
    for (const shape of shapes) {
      const read = exportsOf(STORE, storeWith(shape));
      const unlisted = [...read.values.filter((name) => !listed("value").includes(name)), ...read.types.filter((name) => !listed("type").includes(name))];
      expect(unlisted.length > 0, shape).toBe(true);
    }
    // A second declarator on a listed export's own statement.
    const b1 = STORE_SOURCE.replace(
      /\] as const;/,
      `] as const, ${hook} = () => useUserStore((s) => s.current?.organization.id ?? null);`,
    );
    expect(b1 !== STORE_SOURCE).toBe(true);
    expect(exportsOf(STORE, b1).values.includes(hook)).toBe(true);
  });

  it("has the web app's sources to scan", () => {
    expect(files.length).toBeGreaterThan(200);
    for (const entry of ALLOWED) for (const file of entry.only ?? []) expect(files, file).toContain(file);
  });

  it("reads every file Vite loads under app/, but the tests and the top-level test/", () => {
    for (const path of [
      "lib/leak.mts",
      "lib/leak.cts",
      "lib/leak.js",
      "lib/leak.jsx",
      "lib/leak.mjs",
      "lib/leak.cjs",
      "components/fleets/Leak.tsx",
      "components/fleets/test/leak.ts",
      "lib/test/leak.mjs",
    ]) {
      expect(isSource(path), path).toBe(true);
    }
    for (const path of ["lib/leak.d.ts", "lib/leak.d.mts", "lib/leak.test.ts", "lib/leak.test.mjs", "lib/leak.test.jsx", "test/leak.ts", "test/deep/leak.mjs", "lib/leak.md"]) {
      expect(isSource(path), path).toBe(false);
    }
  });

  it("finds nothing refused in today's code, the store module's body included", () => {
    const found = [...files, STORE].flatMap((file) => refused(file, readFileSync(join(APP, file), "utf8")).map((what) => `${file}: ${what}`));
    expect(found).toEqual([]);
  });

  it("refuses an import of app/test/ from a source, in any spelling", () => {
    for (const [file, shape] of [
      ["components/fleets/TokensTab.tsx", 'import { leak } from "~/test/leak.js";'],
      ["components/fleets/TokensTab.tsx", 'import { leak } from "../../test/leak.js";'],
      ["lib/leak.mts", 'export { leak } from "../test/leak.js";'],
      ["lib/leak.js", 'const leak = await import("~/test/leak.js");'],
    ] as const) {
      expect(refused(file, shape).length > 0, shape).toBe(true);
    }
    // A folder named test elsewhere is source like any other.
    expect(refused("components/fleets/TokensTab.tsx", 'import { leak } from "./test/leak.js";')).toEqual([]);
  });

  it("refuses an import.meta.glob that could reach the store's module", () => {
    for (const [file, shape] of [
      // The store's own file, named.
      ["lib/leak.ts", 'const m = import.meta.glob<typeof Store>("./stores/user-store.ts", { eager: true, import: "useUserStore" });'],
      ["lib/leak.ts", 'const m = import.meta.glob("./stores/*.ts", { eager: true });'],
      ["lib/leak.ts", 'const m = import.meta.glob("./*/*.ts", { eager: true });'],
      ["lib/leak.ts", 'const m = import.meta.glob("./{stores,other}/*.ts", { eager: true });'],
      ["components/fleets/Leak.tsx", 'const m = import.meta.glob("../../**/*.ts", { eager: true });'],
      ["components/fleets/Leak.tsx", 'const m = import.meta.glob("~/lib/stores/*.ts", { eager: true });'],
      ["components/fleets/Leak.tsx", 'const m = import.meta.glob("/app/lib/**", { eager: true });'],
      ["components/fleets/Leak.tsx", 'const m = import.meta.glob(["./a/*.ts", "~/lib/st*/*.ts"], { eager: true });'],
      ["components/fleets/Leak.tsx", 'const m = import.meta.globEager("~/lib/stores/user-store.ts");'],
      ["components/fleets/Leak.tsx", "const m = import.meta.glob(pattern, { eager: true });"],
    ] as const) {
      expect(refused(file, shape).length > 0, shape).toBe(true);
    }
    // Today's kinds of glob pass: the posts, the corpus, the catalogue, one folder down nowhere near the stores.
    for (const [file, fine] of [
      ["lib/posts.ts", 'const modules = import.meta.glob<MDXModule>("/posts/*.mdx", { eager: true });'],
      ["lib/graph/corpus/corpus.ts", 'const files = import.meta.glob<string>("./*.yaml", { query: "?raw", import: "default", eager: true });'],
      ["lib/playground/catalogue.ts", 'const files = import.meta.glob<unknown>("../../../../../../catalog/distributions/*.json", { eager: true });'],
      ["lib/leak.ts", 'const files = import.meta.glob("./*.ts", { eager: true });'],
      ["lib/leak.ts", 'const files = import.meta.glob("./graph/*/*.ts", { eager: true });'],
    ] as const) {
      expect(refused(file, fine), fine).toEqual([]);
    }
  });

  it("refuses, in the store module's body, a reference to useUserStore but its declaration and a write to the globals", () => {
    for (const shape of [
      // A getter on a listed export, reading the organization.
      'Object.defineProperty(readPreference, "organization", { get: () => useUserStore.getState().current?.organization.id });',
      "const handle = useUserStore;",
      "globalThis.telfloOrganization = () => 1;",
      'window["telfloOrganization"] = 1;',
      "self.telfloOrganization ??= 1;",
      'Object.defineProperty(globalThis, "telfloOrganization", { get: () => 1 });',
      "Object.assign(window, { telfloOrganization: 1 });",
      'Reflect.set(self, "telfloOrganization", 1);',
    ]) {
      expect(refusedInStore(storeWith(shape)).length > 0, shape).toBe(true);
    }
    expect(refusedInStore(STORE_SOURCE)).toEqual([]);
  });

  it("lists only uses today's code makes, each where it is allowed (no stale entry)", () => {
    const made = files.flatMap((file) => usesOf(parsed(file, readFileSync(join(APP, file), "utf8"))).map((use) => ({ file, use })));
    for (const entry of ALLOWED) {
      const used = made.some(({ file, use }) => use === entry.use && (entry.only === undefined || entry.only.includes(file)));
      expect(used, entry.use).toBe(true);
    }
  });

  it("refuses every shape found so far (the guard's own check)", () => {
    const file = "components/some/Reader.tsx";
    const shapes = [
      // Reads of the organization, each its own way.
      "const id = useUserStore((state) => state.current?.organization.id ?? null);",
      "const id = useUserStore(\n  (s) => s.current?.organization.id,\n);",
      "const id = useUserStore.getState().current?.organization.id;",
      "const current = useUserStore((state) => state.current);",
      "const selectOrg = (s: UserState) => s.current?.organization.id;\nconst id = useUserStore(selectOrg);",
      "const all = useUserStore((s) => s);",
      "const current = useUserStore((s) => s.current ?? null);",
      "const current = useUserStore((s) => s.current!);",
      "const current = useUserStore(({ current }) => current);",
      "const current = useStore(useUserStore, (s) => s.current);",
      'import { useUserStore as useAccount } from "~/lib/stores/user-store.js";\nconst id = useAccount((s) => s.current?.organization.id);',
      "useUserStore.subscribe((s) => send(s.current?.organization.id));",
      'const current = useUserStore.getState()["current"];',
      // And more: no selector, the whole state, the whole current user, setState, a namespace or default import, a re-export.
      "const all = useUserStore();",
      "const state = useUserStore.getState();",
      "const current = useUserStore.getState().current;",
      "const current = useUserStore.getState().current!.organization;",
      "useUserStore.setState({ current: null });",
      "export const useAccount = useUserStore;",
      'import * as users from "~/lib/stores/user-store.js";',
      'import users from "~/lib/stores/user-store.js";',
      'export { useUserStore } from "~/lib/stores/user-store.js";',
      'export * from "../stores/user-store";',
      // An allowed file's use, elsewhere.
      "const stored = useUserStore((state) => state.current);",
      // Code followed by text holding ` from "…"`.
      'export function A() {\n  const c = useUserStore((s) => s.current)\n  return <p>Sent from "here"</p>\n}',
      // A dynamic import of the store's module, its key built from strings; a require.
      'const m = await import("~/lib/stores/user-store.js");\nconst id = m["useUser" + "Store"].getState().current;',
      "const m = await import(`~/lib/stores/user-store.js`);",
      'const m = require("./user-store.js");',
      // A re-export under another name, followed by another export from a module.
      'import { useUserStore } from "~/lib/stores/user-store.js";\nexport { useUserStore as useAccount }\nexport { isSampleOrganization } from "~/lib/workspace-reads.js";',
      'import { useUserStore } from "~/lib/stores/user-store.js";\nexport { useUserStore };',
      'import { useUserStore } from "~/lib/stores/user-store.js";\nexport default useUserStore;',
      // A multi-line import without semicolons, followed by another import, then a refused use.
      'import {\n  useUserStore\n} from "~/lib/stores/user-store.js"\nimport { other } from "~/lib/other.js"\nconst id = useUserStore((s) => s.current?.organization.id)',
    ];
    for (const shape of shapes) expect(refused(file, shape).length > 0, shape).toBe(true);
    // Today's kinds of use pass: a user's id, a preference, a setter, a presence check; types imported freely.
    for (const fine of [
      "const id = useUserStore((state) => state.current?.user.id ?? null);",
      "const set = useUserStore((state) => state.setCurrent);",
      "useUserStore.getState().clear();",
      "const sequence = useUserStore.getState().setPreference(key, value);",
      "if (useUserStore.getState().current !== null) go();",
      "return useUserStore.getState().current?.user.id ?? null;",
      'import { useUserStore, type PreferenceKey } from "~/lib/stores/user-store.js";',
      'import type { StoredCurrentUser as Stored } from "~/lib/stores/user-store.js";',
      'import {\n  numberPreferenceRead,\n  useUserStore\n} from "~/lib/stores/user-store.js"\nimport { other } from "~/lib/other.js"\nconst id = useUserStore((state) => state.current?.user.id ?? null)',
      // Text naming the store in a comment or JSX is no reference.
      '// useUserStore((s) => s.current) is refused\nexport function B() { return <p>useUserStore from "~/lib/stores/user-store.js"</p>; }',
    ]) {
      expect(refused(file, fine), fine).toEqual([]);
    }
  });
});
