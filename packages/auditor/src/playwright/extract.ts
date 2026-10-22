import { extname } from "node:path";
import { API } from "typescript/unstable/sync";
import {
  SyntaxKind,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isBindingElement,
  isBlock,
  isBooleanLiteral,
  isCallExpression,
  isClassDeclaration,
  isConditionalExpression,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNonNullExpression,
  isNullLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isTypeAssertion,
  isVariableDeclaration,
  type BindingName,
  type CallExpression,
  type Expression,
  type ImportDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyName,
  type SourceFile,
} from "typescript/unstable/ast";
import type { HttpMethod } from "../spec/model.js";
import type { UnresolvedCall, UnresolvedReason } from "../types.js";
import type { ExtractedCall, JsonValue, Literal } from "./model.js";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const HTTP_METHODS = new Set<HttpMethod>([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);

type Binding = "fixture" | "context" | "imported-request" | "test" | "import" | "value";

type QueryValue = Literal | { unresolved: UnresolvedReason };

type ParamRead =
  | { kind: "absent" }
  | { kind: "whole"; reason: UnresolvedReason }
  | { kind: "entries"; entries: Record<string, QueryValue> };

type LiteralRead =
  | { ok: true; value: Literal }
  | { ok: false; reason: UnresolvedReason };

type JsonRead = { ok: true; value: JsonValue } | { ok: false; reason: UnresolvedReason };

type FunctionLike = {
  parameters: readonly ParameterDeclaration[];
  body?: Node;
};

const files = new Map<string, string>();
let parser: API | undefined;
let sequence = 0;

export function extractCalls(file: { path: string; text: string }): ExtractedCall[] {
  const extension = extname(file.path).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) return [];
  return parseCalls(file.path, extension, file.text);
}

function parseCalls(filePath: string, extension: string, text: string): ExtractedCall[] {
  const api = parserApi();
  sequence += 1;
  const virtualPath = `/virtual/file-${sequence}${extension}`;
  files.set(virtualPath, text);
  try {
    const snapshot = api.updateSnapshot({ openFiles: [virtualPath] });
    try {
      const source = snapshot.getDefaultProjectForFile(virtualPath)?.program.getSourceFile(virtualPath);
      if (!source) return [];
      return new Extractor(filePath, source).extract();
    } finally {
      snapshot.dispose();
    }
  } finally {
    files.delete(virtualPath);
    api.updateSnapshot({ closeFiles: [virtualPath] });
  }
}

function parserApi(): API {
  parser ??= new API({
    cwd: "/",
    fs: {
      readFile(name) {
        const text = files.get(name);
        return text === undefined ? null : text;
      },
      fileExists(name) {
        return files.has(name);
      },
      directoryExists(name) {
        return !files.has(name);
      },
    },
  });
  return parser;
}

class Extractor {
  private readonly scopes: Map<string, Binding>[] = [new Map()];
  private insideTest = 0;
  private pending: UnresolvedCall[] = [];
  private readonly calls: ExtractedCall[] = [];

  constructor(
    private readonly file: string,
    private readonly source: SourceFile,
  ) {}

  extract(): ExtractedCall[] {
    this.visit(this.source);
    return this.calls;
  }

  private visit(node: Node): void {
    if (isImportDeclaration(node)) {
      this.recordImport(node);
      return;
    }
    if (isFunctionDeclaration(node)) {
      if (node.name) this.bind(node.name.text, "value");
      this.visitFunction(node);
      return;
    }
    if (isClassDeclaration(node)) {
      if (node.name) this.bind(node.name.text, "value");
      this.visitChildren(node);
      return;
    }
    if (
      isFunctionExpression(node) ||
      isArrowFunction(node) ||
      isMethodDeclaration(node) ||
      isConstructorDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)
    ) {
      this.visitFunction(node);
      return;
    }
    if (isBlock(node)) {
      this.pushScope();
      this.visitChildren(node);
      this.pop();
      return;
    }
    if (isVariableDeclaration(node)) {
      if (node.initializer) this.visit(node.initializer);
      if (isIdentifier(node.name) && node.initializer && this.isNewContext(node.initializer)) {
        this.bind(node.name.text, "context");
      } else {
        this.bindValue(node.name);
      }
      return;
    }
    if (isCallExpression(node)) {
      if (this.isTestCall(node)) {
        this.visitTestCall(node);
        return;
      }
      this.recordRequest(node);
      this.visitChildren(node);
      return;
    }
    this.visitChildren(node);
  }

  private visitChildren(node: Node): void {
    node.forEachChild((child) => {
      this.visit(child);
    });
  }

  private visitFunction(node: FunctionLike): void {
    this.pushScope();
    this.bindParameters(node.parameters, new Set());
    if (node.body) this.visit(node.body);
    this.pop();
  }

  private visitTestCall(node: CallExpression): void {
    let callbackIndex = -1;
    for (let index = node.arguments.length - 1; index >= 0; index -= 1) {
      const arg = node.arguments[index];
      if (arg && this.asFunction(arg)) {
        callbackIndex = index;
        break;
      }
    }
    for (let index = 0; index < node.arguments.length; index += 1) {
      const arg = node.arguments[index];
      if (arg && index !== callbackIndex) this.visit(arg);
    }
    const callbackArg = callbackIndex >= 0 ? node.arguments[callbackIndex] : undefined;
    const callback = callbackArg ? this.asFunction(callbackArg) : undefined;
    if (!callback) return;
    const fixtures = new Set(this.fixtureNames(callback.parameters[0]));
    this.pushScope();
    for (const name of fixtures) this.bind(name, "fixture");
    this.bindParameters(callback.parameters, fixtures);
    this.insideTest += 1;
    if (callback.body) this.visit(callback.body);
    this.insideTest -= 1;
    this.pop();
  }

  private recordRequest(node: CallExpression): void {
    const callee = node.expression;
    if (!isPropertyAccessExpression(callee) || !isIdentifier(callee.expression)) return;
    const methodName = callee.name.text;
    if (!isRequestMethod(methodName)) return;
    const receiver = callee.expression.text;
    const kind = this.lookup(receiver);
    if (kind !== "fixture" && kind !== "context") return;
    this.calls.push(this.readCall(node, receiver, methodName));
  }

  private readCall(
    node: CallExpression,
    receiver: string,
    methodName: string,
  ): ExtractedCall {
    const callee = `${receiver}.${methodName}`;
    const located = this.position(node);
    this.pending = [];
    if (this.insideTest === 0) this.push(located, callee, "outside-test");

    const direct = directMethod(methodName);
    let method: HttpMethod | undefined = direct;
    const url = this.readUrl(node.arguments[0], located, callee);
    const optionsArg = node.arguments[1];
    const options = optionsArg ? this.unwrap(optionsArg) : undefined;
    const object = options && isObjectLiteralExpression(options) ? options : undefined;
    if (methodName === "fetch") method = this.readFetchMethod(object, options, located, callee);

    let query: Record<string, QueryValue> = { ...url.query };
    let headers: Record<string, QueryValue> = {};
    let body: ExtractedCall["body"];
    if (options && !object) {
      const reason = this.expressionReason(options, "non-literal-data");
      this.push(located, callee, "non-literal-param");
      this.push(located, callee, "non-literal-header");
      this.push(located, callee, reason);
      query = {};
      body = { unresolved: reason };
    } else if (object) {
      query = this.mergeQuery(url.query, this.readParams(object), located, callee);
      headers = this.readHeaders(object, located, callee);
      body = this.readBody(object, located, callee);
    }

    const call: ExtractedCall = {
      file: this.file,
      line: located.line,
      column: located.column,
      callee,
      pathParams: {},
      query,
      headers,
      expectations: [],
      unresolved: this.pending,
    };
    if (method !== undefined) call.method = method;
    if (url.path !== undefined) call.path = url.path;
    if (body !== undefined) call.body = body;
    return call;
  }

  private readUrl(
    arg: Expression | undefined,
    located: { line: number; column: number },
    callee: string,
  ): { path?: string; query: Record<string, string> } {
    if (!arg) {
      this.push(located, callee, "non-literal-url");
      return { query: {} };
    }
    const node = this.unwrap(arg);
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return splitUrl(node.text);
    this.push(located, callee, this.expressionReason(node, "non-literal-url"));
    return { query: {} };
  }

  private readFetchMethod(
    object: ObjectLiteralExpression | undefined,
    options: Expression | undefined,
    located: { line: number; column: number },
    callee: string,
  ): HttpMethod | undefined {
    if (!options) return "get";
    if (!object) {
      this.push(located, callee, "non-literal-method");
      return undefined;
    }
    const initializer = this.propertyInitializer(object, "method");
    if (initializer === undefined) {
      if (this.hasProperty(object, "method")) this.push(located, callee, "non-literal-method");
      else return "get";
      return undefined;
    }
    const value = this.unwrap(initializer);
    if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
      const method = value.text.toLowerCase();
      if (isHttpMethod(method)) return method;
    }
    this.push(located, callee, "non-literal-method");
    return undefined;
  }

  private readParams(object: ObjectLiteralExpression): ParamRead {
    const property = this.findProperty(object, "params");
    if (!property) return { kind: "absent" };
    if (!isPropertyAssignment(property)) return { kind: "whole", reason: "non-literal-param" };
    return this.readParamValue(property.initializer);
  }

  private readParamValue(expression: Expression): ParamRead {
    const node = this.unwrap(expression);
    if (isObjectLiteralExpression(node)) return this.readLiteralObject(node, "non-literal-param");
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
      return { kind: "entries", entries: queryFromString(node.text) };
    }
    if (isNewExpression(node) && isIdentifier(node.expression) && node.expression.text === "URLSearchParams") {
      const arg = node.arguments?.[0];
      if (!arg) return { kind: "entries", entries: {} };
      return this.readParamValue(arg);
    }
    return { kind: "whole", reason: this.expressionReason(node, "non-literal-param") };
  }

  private readHeaders(
    object: ObjectLiteralExpression,
    located: { line: number; column: number },
    callee: string,
  ): Record<string, QueryValue> {
    const property = this.findProperty(object, "headers");
    if (!property) return {};
    if (!isPropertyAssignment(property)) {
      this.push(located, callee, "non-literal-header");
      return {};
    }
    const value = this.unwrap(property.initializer);
    if (!isObjectLiteralExpression(value)) {
      this.push(located, callee, this.expressionReason(value, "non-literal-header"));
      return {};
    }
    const read = this.readLiteralObject(value, "non-literal-header");
    if (read.kind !== "entries") {
      if (read.kind === "whole") this.push(located, callee, read.reason);
      return {};
    }
    this.pushUnresolvedValues(read.entries, located, callee);
    return read.entries;
  }

  private readBody(
    object: ObjectLiteralExpression,
    located: { line: number; column: number },
    callee: string,
  ): ExtractedCall["body"] {
    if (this.hasProperty(object, "form") || this.hasProperty(object, "multipart")) {
      this.push(located, callee, "form-body");
      return { unresolved: "form-body" };
    }
    const property = this.findProperty(object, "data");
    if (!property) return undefined;
    if (!isPropertyAssignment(property)) {
      this.push(located, callee, "non-literal-data");
      return { unresolved: "non-literal-data" };
    }
    return this.readDataValue(property.initializer, located, callee);
  }

  private readDataValue(
    expression: Expression,
    located: { line: number; column: number },
    callee: string,
  ): ExtractedCall["body"] {
    const node = this.unwrap(expression);
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
      this.push(located, callee, "raw-string-body");
      return { unresolved: "raw-string-body" };
    }
    const read = this.readJson(node, "non-literal-data");
    if (!read.ok) {
      this.push(located, callee, read.reason);
      return { unresolved: read.reason };
    }
    return read.value;
  }

  private mergeQuery(
    urlQuery: Record<string, string>,
    params: ParamRead,
    located: { line: number; column: number },
    callee: string,
  ): Record<string, QueryValue> {
    if (params.kind === "whole") {
      this.push(located, callee, params.reason);
      return {};
    }
    const query: Record<string, QueryValue> = { ...urlQuery };
    if (params.kind === "absent") return query;
    for (const [key, value] of Object.entries(params.entries)) {
      const existing = query[key];
      if (existing === undefined) {
        query[key] = value;
        if (isUnresolved(value)) this.push(located, callee, value.unresolved);
        continue;
      }
      if (isUnresolved(value)) {
        query[key] = value;
        this.push(located, callee, value.unresolved);
        continue;
      }
      if (isUnresolved(existing)) {
        this.push(located, callee, existing.unresolved);
        continue;
      }
      if (String(existing) !== String(value)) {
        query[key] = { unresolved: "ambiguous-constant" };
        this.push(located, callee, "ambiguous-constant");
      }
    }
    return query;
  }

  private readLiteralObject(node: ObjectLiteralExpression, fallback: UnresolvedReason): ParamRead {
    const entries: Record<string, QueryValue> = {};
    for (const property of node.properties) {
      if (isSpreadAssignment(property)) return { kind: "whole", reason: "spread" };
      if (isShorthandPropertyAssignment(property)) {
        const key = this.staticName(property.name);
        if (key === undefined) return { kind: "whole", reason: "computed-key" };
        entries[key] = { unresolved: this.identifierReason(key, fallback) };
        continue;
      }
      if (!isPropertyAssignment(property)) return { kind: "whole", reason: fallback };
      const key = this.staticName(property.name);
      if (key === undefined) return { kind: "whole", reason: "computed-key" };
      const literal = this.readPrimitive(property.initializer, fallback);
      entries[key] = literal.ok ? literal.value : { unresolved: literal.reason };
    }
    return { kind: "entries", entries };
  }

  private readPrimitive(expression: Expression, fallback: UnresolvedReason): LiteralRead {
    const read = this.readJson(expression, fallback);
    if (!read.ok) return read;
    if (read.value === null || typeof read.value !== "object") return { ok: true, value: read.value };
    return { ok: false, reason: fallback };
  }

  private readJson(expression: Expression, fallback: UnresolvedReason): JsonRead {
    const node = this.unwrap(expression);
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return { ok: true, value: node.text };
    if (isNumericLiteral(node)) {
      const value = numberValue(node.text);
      return value === undefined ? { ok: false, reason: fallback } : { ok: true, value };
    }
    if (isPrefixUnaryExpression(node) && isNumericLiteral(node.operand)) {
      const magnitude = numberValue(node.operand.text);
      if (magnitude === undefined) return { ok: false, reason: fallback };
      if (node.operator === SyntaxKind.MinusToken) return { ok: true, value: -magnitude };
      if (node.operator === SyntaxKind.PlusToken) return { ok: true, value: magnitude };
      return { ok: false, reason: fallback };
    }
    if (isBooleanLiteral(node)) return { ok: true, value: node.kind === SyntaxKind.TrueKeyword };
    if (isNullLiteral(node)) return { ok: true, value: null };
    if (isArrayLiteralExpression(node)) {
      const items: JsonValue[] = [];
      for (const element of node.elements) {
        if (isSpreadElement(element)) return { ok: false, reason: "spread" };
        if (isOmittedExpression(element)) return { ok: false, reason: fallback };
        const item = this.readJson(element, fallback);
        if (!item.ok) return item;
        items.push(item.value);
      }
      return { ok: true, value: items };
    }
    if (isObjectLiteralExpression(node)) {
      const value: { [key: string]: JsonValue } = {};
      for (const property of node.properties) {
        if (isSpreadAssignment(property)) return { ok: false, reason: "spread" };
        if (isShorthandPropertyAssignment(property)) {
          const key = this.staticName(property.name);
          return { ok: false, reason: key === undefined ? "computed-key" : this.identifierReason(key, fallback) };
        }
        if (!isPropertyAssignment(property)) return { ok: false, reason: fallback };
        const key = this.staticName(property.name);
        if (key === undefined) return { ok: false, reason: "computed-key" };
        const item = this.readJson(property.initializer, fallback);
        if (!item.ok) return item;
        value[key] = item.value;
      }
      return { ok: true, value };
    }
    return { ok: false, reason: this.expressionReason(node, fallback) };
  }

  private expressionReason(node: Expression, fallback: UnresolvedReason): UnresolvedReason {
    if (isCallExpression(node)) return "helper-call";
    if (isIdentifier(node)) return this.identifierReason(node.text, fallback);
    if (isConditionalExpression(node)) return "ambiguous-constant";
    if (isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        const reason = this.expressionReason(this.unwrap(span.expression), fallback);
        if (reason !== fallback) return reason;
      }
    }
    return fallback;
  }

  private identifierReason(name: string, fallback: UnresolvedReason): UnresolvedReason {
    const kind = this.lookup(name);
    if (kind === "import" || kind === "imported-request" || kind === "test") return "imported-value";
    return fallback;
  }

  private recordImport(node: ImportDeclaration): void {
    const clause = node.importClause;
    if (!clause || clause.phaseModifier === SyntaxKind.TypeKeyword) return;
    const specifier = node.moduleSpecifier;
    const fromPlaywright = isStringLiteral(specifier) && specifier.text === "@playwright/test";
    if (clause.name) this.bind(clause.name.text, "import");
    const bindings = clause.namedBindings;
    if (!bindings) return;
    if (isNamespaceImport(bindings)) {
      this.bind(bindings.name.text, "import");
      return;
    }
    if (!isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      const local = element.name.text;
      if (fromPlaywright && imported === "request") this.bind(local, "imported-request");
      else if (fromPlaywright && imported === "test") this.bind(local, "test");
      else this.bind(local, "import");
    }
  }

  private isTestCall(node: CallExpression): boolean {
    const expr = node.expression;
    if (isIdentifier(expr)) return this.isPlaywrightTest(expr.text);
    if (isPropertyAccessExpression(expr) && isIdentifier(expr.expression)) {
      const name = expr.name.text;
      return (name === "only" || name === "skip" || name === "fixme") && this.isPlaywrightTest(expr.expression.text);
    }
    return false;
  }

  private isPlaywrightTest(name: string): boolean {
    const kind = this.lookup(name);
    return kind === "test" || (kind === undefined && name === "test");
  }

  private isNewContext(expression: Expression): boolean {
    const node = this.unwrap(expression);
    if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return false;
    if (!isIdentifier(node.expression.expression) || node.expression.name.text !== "newContext") return false;
    return this.lookup(node.expression.expression.text) === "imported-request";
  }

  private asFunction(expression: Expression): FunctionLike | undefined {
    const node = this.unwrap(expression);
    if (isArrowFunction(node) || isFunctionExpression(node)) return node;
    return undefined;
  }

  private fixtureNames(param: ParameterDeclaration | undefined): string[] {
    if (!param || !isObjectBindingPattern(param.name)) return [];
    const names: string[] = [];
    for (const element of param.name.elements) {
      if (!isBindingElement(element)) continue;
      const local = element.name;
      if (!local || !isIdentifier(local)) continue;
      const property = element.propertyName;
      if (property === undefined) {
        if (local.text === "request") names.push(local.text);
        continue;
      }
      if (this.staticName(property) === "request") names.push(local.text);
    }
    return names;
  }

  private unwrap(expression: Expression): Expression {
    let current = expression;
    while (
      isAwaitExpression(current) ||
      isParenthesizedExpression(current) ||
      isAsExpression(current) ||
      isSatisfiesExpression(current) ||
      isTypeAssertion(current) ||
      isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }

  private findProperty(object: ObjectLiteralExpression, name: string): ObjectLiteralElementLike | undefined {
    for (const property of object.properties) {
      if (this.propertyName(property) === name) return property;
    }
    return undefined;
  }

  private hasProperty(object: ObjectLiteralExpression, name: string): boolean {
    return this.findProperty(object, name) !== undefined;
  }

  private propertyInitializer(object: ObjectLiteralExpression, name: string): Expression | undefined {
    const property = this.findProperty(object, name);
    if (property && isPropertyAssignment(property)) return property.initializer;
    return undefined;
  }

  private propertyName(property: ObjectLiteralElementLike): string | undefined {
    if (isSpreadAssignment(property)) return undefined;
    return this.staticName(property.name);
  }

  private staticName(name: PropertyName): string | undefined {
    if (
      isIdentifier(name) ||
      isStringLiteral(name) ||
      isNumericLiteral(name) ||
      isNoSubstitutionTemplateLiteral(name)
    ) {
      return name.text;
    }
    return undefined;
  }

  private bindParameters(params: readonly ParameterDeclaration[], fixtures: ReadonlySet<string>): void {
    for (const param of params) this.bindValue(param.name, fixtures);
  }

  private bindValue(name: BindingName, skip?: ReadonlySet<string>): void {
    if (isIdentifier(name)) {
      if (!skip?.has(name.text)) this.bind(name.text, "value");
      return;
    }
    if (isObjectBindingPattern(name) || isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (isBindingElement(element) && element.name) this.bindValue(element.name, skip);
      }
    }
  }

  private push(located: { line: number; column: number }, callee: string, reason: UnresolvedReason): void {
    if (this.pending.some((item) => item.reason === reason)) return;
    this.pending.push({
      file: this.file,
      line: located.line,
      column: located.column,
      callee,
      reason,
    });
  }

  private pushUnresolvedValues(
    entries: Record<string, QueryValue>,
    located: { line: number; column: number },
    callee: string,
  ): void {
    for (const value of Object.values(entries)) {
      if (isUnresolved(value)) this.push(located, callee, value.unresolved);
    }
  }

  private position(node: Node): { line: number; column: number } {
    const point = this.source.getLineAndCharacterOfPosition(node.getStart(this.source));
    return { line: point.line + 1, column: point.character + 1 };
  }

  private bind(name: string, kind: Binding): void {
    this.current().set(name, kind);
  }

  private lookup(name: string): Binding | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const kind = this.scopes[index]?.get(name);
      if (kind !== undefined) return kind;
    }
    return undefined;
  }

  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private pop(): void {
    this.scopes.pop();
  }

  private current(): Map<string, Binding> {
    const scope = this.scopes[this.scopes.length - 1];
    if (!scope) throw new Error("scope stack empty");
    return scope;
  }
}

function isRequestMethod(name: string): boolean {
  return directMethod(name) !== undefined || name === "fetch";
}

function directMethod(name: string): HttpMethod | undefined {
  if (name === "get" || name === "post" || name === "put" || name === "patch" || name === "delete") return name;
  return undefined;
}

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHODS.has(value as HttpMethod);
}

function isUnresolved(value: QueryValue): value is { unresolved: UnresolvedReason } {
  return typeof value === "object" && value !== null && "unresolved" in value;
}

function numberValue(text: string): number | undefined {
  const value = Number(text.replaceAll("_", ""));
  return Number.isFinite(value) ? value : undefined;
}

function splitUrl(url: string): { path: string; query: Record<string, string> } {
  const hash = url.indexOf("#");
  const withoutHash = hash === -1 ? url : url.slice(0, hash);
  const question = withoutHash.indexOf("?");
  if (question === -1) return { path: withoutHash, query: {} };
  return {
    path: withoutHash.slice(0, question),
    query: queryFromString(withoutHash.slice(question + 1)),
  };
}

function queryFromString(query: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) entries[key] = value;
  return entries;
}
