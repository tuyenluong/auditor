import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SyntaxKind,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isExportAssignment,
  isExpressionStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  type Expression,
  type ObjectLiteralExpression,
  type SourceFile,
} from "typescript/unstable/ast";
import {
  createConstantResolver,
  propertyKey,
  unwrapExpression,
  type ConstantResolver,
} from "./constants.js";
import { withSourceFile } from "./parse.js";
import { splitUrl } from "./url.js";

const CONFIG_FILENAMES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.js",
  "playwright.config.mjs",
] as const;

export type BaseURLResult = { literal: true; value: string } | { literal: false };

export interface StrippedUrl {
  path: string;
  query: Record<string, string>;
}

export function findPlaywrightConfig(cwd: string, playwrightConfigPath?: string | null): string | undefined {
  if (playwrightConfigPath === null) return undefined;
  if (playwrightConfigPath !== undefined) return resolve(cwd, playwrightConfigPath);
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(cwd, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

export function readBaseURL(filePath: string): BaseURLResult | undefined {
  return withSourceFile(filePath, readFileSync(filePath, "utf8"), readConfig);
}

export function stripBase(url: string, bases: readonly string[], baseURL?: string): StrippedUrl {
  const { path, query } = splitUrl(url);
  const prefixes = baseURL === undefined ? bases : [baseURL, ...bases];
  return { path: stripPath(path, prefixes, baseURL), query };
}

function readConfig(source: SourceFile): BaseURLResult | undefined {
  const exported = exportedExpression(source);
  if (!exported) return undefined;
  const resolver = createConstantResolver(source);
  const root = configObject(exported, source, resolver, new Set());
  if (root === "unstable") return { literal: false };
  if (!root) return undefined;
  const use = readProperty(root, "use");
  if (use.kind === "hidden") return { literal: false };
  if (use.kind === "absent") return undefined;
  const useObject = asObject(use.expression, resolver);
  if (!useObject) return { literal: false };
  const baseURL = readProperty(useObject, "baseURL");
  if (baseURL.kind === "hidden") return { literal: false };
  if (baseURL.kind === "absent") return undefined;
  const resolved = resolver.resolve(baseURL.expression, "non-literal-url");
  if (resolved.ok && typeof resolved.value === "string") return { literal: true, value: resolved.value };
  return { literal: false };
}

function stripPath(path: string, prefixes: readonly string[], baseURL: string | undefined): string {
  if (isPathAbsolute(path)) return path;
  if (!isSchemeAbsolute(path)) {
    const resolved = baseURL === undefined ? undefined : resolveAgainst(baseURL, path);
    if (resolved === undefined) return pathFromRelative(path);
    return stripAbsolute(resolved, prefixes);
  }
  return stripAbsolute(path, prefixes);
}

function stripAbsolute(url: string, prefixes: readonly string[]): string {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return pathFromRelative(url);
  }
  for (const prefix of prefixes) {
    const base = parsePrefix(prefix);
    if (!base || base.origin !== target.origin) continue;
    const rest = remainder(target.pathname, base.pathname);
    if (rest !== undefined) return rest;
  }
  return rooted(target.pathname);
}

function parsePrefix(prefix: string): { origin: string; pathname: string } | undefined {
  try {
    const url = new URL(prefix);
    return { origin: url.origin, pathname: directoryPath(url.pathname) };
  } catch {
    return undefined;
  }
}

function remainder(pathname: string, basePath: string): string | undefined {
  if (basePath === "/") return rooted(pathname);
  if (pathname === basePath || pathname === `${basePath}/`) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return undefined;
}

function directoryPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname === "" ? "/" : pathname;
}

function pathFromRelative(relative: string): string {
  try {
    return rooted(new URL(relative, "http://localhost/").pathname);
  } catch {
    return rooted(relative);
  }
}

function rooted(pathname: string): string {
  if (pathname === "" || pathname === "/") return "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function resolveAgainst(base: string, relative: string): string | undefined {
  try {
    return new URL(relative, base).href;
  } catch {
    return undefined;
  }
}

function isPathAbsolute(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

function isSchemeAbsolute(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
}

function exportedExpression(source: SourceFile): Expression | undefined {
  let found: Expression | undefined;
  source.forEachChild((node) => {
    if (isExportAssignment(node)) {
      found = node.expression;
      return;
    }
    if (!isExpressionStatement(node)) return;
    const expr = unwrapExpression(node.expression);
    if (!isBinaryExpression(expr) || expr.operatorToken.kind !== SyntaxKind.EqualsToken) return;
    if (!isModuleExports(expr.left)) return;
    found = assignedValue(expr.right);
  });
  return found;
}

function assignedValue(expression: Expression): Expression {
  let current = unwrapExpression(expression);
  while (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    current = unwrapExpression(current.right);
  }
  return current;
}

function isModuleExports(expression: Expression): boolean {
  const node = unwrapExpression(expression);
  if (!isPropertyAccessExpression(node) || node.name.text !== "exports") return false;
  const object = unwrapExpression(node.expression);
  return isIdentifier(object) && object.text === "module";
}

function configObject(
  expression: Expression,
  source: SourceFile,
  resolver: ConstantResolver,
  seen: Set<Expression>,
): ObjectLiteralExpression | "unstable" | undefined {
  const followed = followedExpression(expression, resolver);
  if (followed === "unstable") return "unstable";
  if (!followed) return undefined;
  if (isCallExpression(followed)) {
    const callee = unwrapExpression(followed.expression);
    if (isIdentifier(callee) && resolver.isDefineConfig(callee.text, callee.getStart(source))) {
      if (seen.has(followed)) return "unstable";
      seen.add(followed);
      const arg = followed.arguments[0];
      return arg ? configObject(arg, source, resolver, seen) : undefined;
    }
  }
  return isObjectLiteralExpression(followed) ? followed : undefined;
}

function asObject(expression: Expression, resolver: ConstantResolver): ObjectLiteralExpression | undefined {
  const followed = followedExpression(expression, resolver);
  if (!followed || followed === "unstable" || !isObjectLiteralExpression(followed)) return undefined;
  return followed;
}

function followedExpression(expression: Expression, resolver: ConstantResolver): Expression | "unstable" | undefined {
  const node = unwrapExpression(expression);
  const bound = resolver.boundExpression(node);
  if (bound) return bound;
  if (!isIdentifier(node)) return undefined;
  const resolved = resolver.resolve(node, "non-literal-url");
  if (!resolved.ok && resolved.reason === "ambiguous-constant") return "unstable";
  return undefined;
}

type PropertyRead =
  | { kind: "absent" }
  | { kind: "hidden" }
  | { kind: "value"; expression: Expression };

function readProperty(object: ObjectLiteralExpression, name: string): PropertyRead {
  let found: Expression | undefined;
  let saw = false;
  let spread = false;
  let obscured = false;
  for (const property of object.properties) {
    if (isSpreadAssignment(property) || isComputedPropertyName(property.name)) {
      spread = true;
      if (saw) obscured = true;
      continue;
    }
    if (propertyKey(property.name) !== name) continue;
    saw = true;
    obscured = false;
    if (isPropertyAssignment(property)) found = property.initializer;
    else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) found = property.name;
    else found = undefined;
  }
  if (obscured || (!saw && spread)) return { kind: "hidden" };
  if (!found) return saw ? { kind: "hidden" } : { kind: "absent" };
  return { kind: "value", expression: found };
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}
