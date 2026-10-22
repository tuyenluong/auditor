import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SyntaxKind,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isComputedPropertyName,
  isExportAssignment,
  isExpressionStatement,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  type BindingName,
  type Expression,
  type ImportDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  type VariableDeclaration,
} from "typescript/unstable/ast";
import { createConstantResolver, propertyKey, unwrapExpression } from "./constants.js";
import { withSourceFile } from "./parse.js";
import { splitUrl } from "./url.js";

const CONFIG_FILENAMES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.js",
  "playwright.config.mjs",
] as const;

const MAX_FOLLOW_DEPTH = 10;
const PLAYWRIGHT_TEST = "@playwright/test";

export type BaseURLResult = { literal: true; value: string } | { literal: false };

export interface StrippedUrl {
  path: string;
  query: Record<string, string>;
}

interface Bindings {
  defineConfig: Set<string>;
  values: Map<string, Expression | undefined>;
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
  const bindings = collectBindings(source);
  const root = configObject(exported, bindings, 0);
  if (!root) return undefined;
  const use = readProperty(root, "use");
  if (use.kind === "hidden") return { literal: false };
  if (use.kind === "absent") return undefined;
  const useObject = asObject(use.expression, bindings.values, 0);
  if (!useObject) return { literal: false };
  const baseURL = readProperty(useObject, "baseURL");
  if (baseURL.kind === "hidden") return { literal: false };
  if (baseURL.kind === "absent") return undefined;
  const resolved = createConstantResolver(source).resolve(baseURL.expression, "non-literal-url");
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

function collectBindings(source: SourceFile): Bindings {
  const defineConfig = new Set<string>();
  const values = new Map<string, Expression | undefined>();
  const visit = (node: Node): void => {
    if (isFunctionLikeDeclaration(node) || isClassDeclaration(node)) return;
    if (isImportDeclaration(node)) {
      collectImport(node, defineConfig);
      return;
    }
    if (isVariableDeclaration(node) && isIdentifier(node.name)) noteValue(values, node.name.text, node.initializer);
    if (isVariableDeclaration(node)) collectRequire(node, defineConfig);
    node.forEachChild(visit);
  };
  visit(source);
  return { defineConfig, values };
}

function noteValue(values: Map<string, Expression | undefined>, name: string, initializer: Expression | undefined): void {
  if (values.has(name)) values.set(name, undefined);
  else values.set(name, initializer);
}

function collectImport(node: ImportDeclaration, names: Set<string>): void {
  const clause = node.importClause;
  if (!clause || clause.phaseModifier === SyntaxKind.TypeKeyword) return;
  if (!isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== PLAYWRIGHT_TEST) return;
  const bindings = clause.namedBindings;
  if (!bindings || !isNamedImports(bindings)) return;
  for (const element of bindings.elements) {
    if (element.isTypeOnly) continue;
    const imported = element.propertyName?.text ?? element.name.text;
    if (imported === "defineConfig") names.add(element.name.text);
  }
}

function collectRequire(declaration: VariableDeclaration, names: Set<string>): void {
  if (!declaration.initializer) return;
  const init = unwrapExpression(declaration.initializer);
  if (isPlaywrightRequire(init)) {
    bindRequirePattern(declaration.name, names);
    return;
  }
  if (isIdentifier(declaration.name) && isDefineConfigRequire(init)) names.add(declaration.name.text);
}

function bindRequirePattern(name: BindingName, names: Set<string>): void {
  if (!isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    if (!isBindingElement(element) || !element.name || !isIdentifier(element.name)) continue;
    const imported = element.propertyName ? propertyKey(element.propertyName) : element.name.text;
    if (imported === "defineConfig") names.add(element.name.text);
  }
}

function isPlaywrightRequire(expression: Expression): boolean {
  if (!isCallExpression(expression) || !isIdentifier(expression.expression) || expression.expression.text !== "require") {
    return false;
  }
  const specifier = expression.arguments[0];
  return specifier !== undefined && isStringLiteral(specifier) && specifier.text === PLAYWRIGHT_TEST;
}

function isDefineConfigRequire(expression: Expression): boolean {
  return (
    isPropertyAccessExpression(expression) &&
    expression.name.text === "defineConfig" &&
    isPlaywrightRequire(unwrapExpression(expression.expression))
  );
}

function configObject(expression: Expression, bindings: Bindings, depth: number): ObjectLiteralExpression | undefined {
  if (depth > MAX_FOLLOW_DEPTH) return undefined;
  const node = unwrapExpression(expression);
  if (isCallExpression(node) && isIdentifier(node.expression) && bindings.defineConfig.has(node.expression.text)) {
    const arg = node.arguments[0];
    return arg ? configObject(arg, bindings, depth + 1) : undefined;
  }
  return asObject(node, bindings.values, depth);
}

function asObject(
  expression: Expression,
  values: Map<string, Expression | undefined>,
  depth: number,
): ObjectLiteralExpression | undefined {
  if (depth > MAX_FOLLOW_DEPTH) return undefined;
  const node = unwrapExpression(expression);
  if (isObjectLiteralExpression(node)) return node;
  if (!isIdentifier(node)) return undefined;
  const init = values.get(node.text);
  if (!init) return undefined;
  return asObject(init, values, depth + 1);
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
