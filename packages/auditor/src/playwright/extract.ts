import {
  isCallExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  type CallExpression,
  type Expression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SourceFile,
} from "typescript/unstable/ast";
import type { HttpMethod } from "../spec/model.js";
import type { UnresolvedCall, UnresolvedReason } from "../types.js";
import {
  createConstantResolver,
  propertyKey,
  testCallback,
  unwrapExpression,
  type ConstantResolver,
  type ResolveResult,
} from "./constants.js";
import type { ExtractedCall, JsonValue, Literal } from "./model.js";
import { withSourceFile } from "./parse.js";
import { queryFromString, splitUrl, takeDynamicPath } from "./url.js";

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

type QueryValue = Literal | { unresolved: UnresolvedReason };

type ParamRead =
  | { kind: "absent" }
  | { kind: "whole"; reason: UnresolvedReason }
  | { kind: "entries"; entries: Record<string, QueryValue> };

type Located = { line: number; column: number };

export function extractCalls(file: { path: string; text: string }): ExtractedCall[] {
  return withSourceFile(file.path, file.text, (source) => new Extractor(file.path, source).extract()) ?? [];
}

class Extractor {
  private readonly constants: ConstantResolver;
  private insideTest = 0;
  private pending: UnresolvedCall[] = [];
  private readonly calls: ExtractedCall[] = [];

  constructor(
    private readonly file: string,
    private readonly source: SourceFile,
  ) {
    this.constants = createConstantResolver(source);
  }

  extract(): ExtractedCall[] {
    this.walk(this.source);
    return this.calls;
  }

  private walk(node: Node): void {
    if (isCallExpression(node)) {
      if (this.constants.isTestCall(node)) {
        this.walkTest(node);
        return;
      }
      this.recordRequest(node);
    } else if (isFunctionLikeDeclaration(node)) {
      if (node.body) this.walk(node.body);
      return;
    }
    node.forEachChild((child) => {
      this.walk(child);
    });
  }

  private walkTest(node: CallExpression): void {
    const callback = testCallback(node);
    for (let index = 0; index < node.arguments.length; index += 1) {
      const arg = node.arguments[index];
      if (arg && index !== callback.index) this.walk(arg);
    }
    const body = callback.fn?.body;
    if (!body) return;
    this.insideTest += 1;
    this.walk(body);
    this.insideTest -= 1;
  }

  private recordRequest(node: CallExpression): void {
    const callee = node.expression;
    if (!isPropertyAccessExpression(callee) || !isIdentifier(callee.expression)) return;
    const methodName = callee.name.text;
    if (!isRequestMethod(methodName)) return;
    const receiver = callee.expression;
    const kind = this.constants.bindingKind(receiver.text, receiver.getStart(this.source));
    if (kind !== "fixture" && kind !== "context") return;
    this.calls.push(this.readCall(node, receiver.text, methodName));
  }

  private readCall(node: CallExpression, receiver: string, methodName: string): ExtractedCall {
    const callee = `${receiver}.${methodName}`;
    const located = this.position(node);
    this.pending = [];
    if (this.insideTest === 0) this.push(located, callee, "outside-test");

    let method = directMethod(methodName);
    const url = this.readUrl(node.arguments[0], located, callee);
    const optionsArg = node.arguments[1];
    let query: Record<string, QueryValue> = { ...url.query };
    let headers: Record<string, QueryValue> = {};
    let body: ExtractedCall["body"];

    if (!optionsArg) {
      if (methodName === "fetch") method = "get";
    } else {
      const options = unwrapExpression(optionsArg);
      if (isObjectLiteralExpression(options)) {
        if (methodName === "fetch") method = this.readMethod(options, located, callee);
        query = this.mergeQuery(url.query, this.readParams(options), located, callee);
        headers = this.finish(this.readHeaders(options), located, callee);
        body = this.readBody(options, located, callee);
      } else {
        const resolved = this.constants.resolve(options, "non-literal-data");
        const record = resolved.ok ? recordFields(resolved.value) : undefined;
        if (record) {
          if (methodName === "fetch") method = this.methodFrom(member(record, "method"), located, callee);
          query = this.mergeQuery(url.query, interpretMapping(member(record, "params"), "non-literal-param", "query"), located, callee);
          headers = this.finish(interpretMapping(member(record, "headers"), "non-literal-header", "reject"), located, callee);
          body = this.bodyFrom(member(record, "data"), "form" in record || "multipart" in record, located, callee);
        } else {
          if (methodName === "fetch") {
            this.push(located, callee, "non-literal-method");
            method = undefined;
          }
          const reason = resolved.ok ? "non-literal-data" : resolved.reason;
          this.push(located, callee, "non-literal-param");
          this.push(located, callee, "non-literal-header");
          this.push(located, callee, reason);
          query = {};
          body = { unresolved: reason };
        }
      }
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
    if (url.dynamicSegments !== undefined) call.dynamicSegments = url.dynamicSegments;
    if (body !== undefined) call.body = body;
    return call;
  }

  private readUrl(
    arg: Expression | undefined,
    located: Located,
    callee: string,
  ): { path?: string; query: Record<string, string>; dynamicSegments?: readonly number[] } {
    if (!arg) {
      this.push(located, callee, "non-literal-url");
      return { query: {} };
    }
    const resolved = this.constants.resolve(arg, "non-literal-url", { dynamicPath: true });
    if (!resolved.ok || typeof resolved.value !== "string") {
      this.push(located, callee, resolved.ok ? "non-literal-url" : resolved.reason);
      return { query: {} };
    }
    const split = splitUrl(resolved.value);
    const marked = takeDynamicPath(split.path);
    if (marked.dynamicSegments === undefined) return { path: marked.path, query: split.query };
    return { path: marked.path, query: split.query, dynamicSegments: marked.dynamicSegments };
  }

  private readMethod(object: ObjectLiteralExpression, located: Located, callee: string): HttpMethod | undefined {
    if (!hasProperty(object, "method")) return "get";
    const expression = propertyExpression(object, "method");
    if (!expression) return this.methodFrom({ ok: false, reason: "non-literal-method" }, located, callee);
    return this.methodFrom(this.constants.resolve(expression, "non-literal-method"), located, callee);
  }

  private methodFrom(resolved: ResolveResult | "absent", located: Located, callee: string): HttpMethod | undefined {
    if (resolved === "absent") return "get";
    if (resolved.ok && typeof resolved.value === "string") {
      const method = resolved.value.toLowerCase();
      if (isHttpMethod(method)) return method;
    }
    this.push(located, callee, resolved.ok ? "non-literal-method" : resolved.reason);
    return undefined;
  }

  private readParams(object: ObjectLiteralExpression): ParamRead {
    if (!hasProperty(object, "params")) return { kind: "absent" };
    const expression = propertyExpression(object, "params");
    if (!expression) return { kind: "whole", reason: "non-literal-param" };
    return interpretMapping(this.resolveParams(expression), "non-literal-param", "query");
  }

  private readHeaders(object: ObjectLiteralExpression): ParamRead {
    if (!hasProperty(object, "headers")) return { kind: "absent" };
    const expression = propertyExpression(object, "headers");
    if (!expression) return { kind: "whole", reason: "non-literal-header" };
    return interpretMapping(this.constants.resolve(expression, "non-literal-header"), "non-literal-header", "reject");
  }

  private readBody(object: ObjectLiteralExpression, located: Located, callee: string): ExtractedCall["body"] {
    if (hasProperty(object, "form") || hasProperty(object, "multipart")) {
      return this.formBody(located, callee);
    }
    if (!hasProperty(object, "data")) return undefined;
    const expression = propertyExpression(object, "data");
    if (!expression) return this.dataFrom({ ok: false, reason: "non-literal-data" }, located, callee);
    return this.dataFrom(this.constants.resolve(expression, "non-literal-data"), located, callee);
  }

  private resolveParams(expression: Expression): ResolveResult {
    const node = unwrapSearchParams(expression);
    if (!node) return { ok: true, value: "" };
    return this.constants.resolve(node, "non-literal-param");
  }

  private bodyFrom(
    resolved: ResolveResult | "absent",
    form: boolean,
    located: Located,
    callee: string,
  ): ExtractedCall["body"] {
    if (form) return this.formBody(located, callee);
    return this.dataFrom(resolved, located, callee);
  }

  private formBody(located: Located, callee: string): ExtractedCall["body"] {
    this.push(located, callee, "form-body");
    return { unresolved: "form-body" };
  }

  private dataFrom(resolved: ResolveResult | "absent", located: Located, callee: string): ExtractedCall["body"] {
    if (resolved === "absent") return undefined;
    if (resolved.ok && typeof resolved.value === "string") {
      this.push(located, callee, "raw-string-body");
      return { unresolved: "raw-string-body" };
    }
    if (!resolved.ok) {
      this.push(located, callee, resolved.reason);
      return { unresolved: resolved.reason };
    }
    return resolved.value;
  }

  private mergeQuery(
    urlQuery: Record<string, string>,
    params: ParamRead,
    located: Located,
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

  private finish(read: ParamRead, located: Located, callee: string): Record<string, QueryValue> {
    if (read.kind === "whole") {
      this.push(located, callee, read.reason);
      return {};
    }
    if (read.kind === "absent") return {};
    for (const value of Object.values(read.entries)) {
      if (isUnresolved(value)) this.push(located, callee, value.unresolved);
    }
    return read.entries;
  }

  private push(located: Located, callee: string, reason: UnresolvedReason): void {
    if (this.pending.some((item) => item.reason === reason)) return;
    this.pending.push({ file: this.file, line: located.line, column: located.column, callee, reason });
  }

  private position(node: Node): Located {
    const point = this.source.getLineAndCharacterOfPosition(node.getStart(this.source));
    return { line: point.line + 1, column: point.character + 1 };
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

function interpretMapping(resolved: ResolveResult | "absent", fallback: UnresolvedReason, mode: "query" | "reject"): ParamRead {
  if (resolved === "absent") return { kind: "absent" };
  if (!resolved.ok) {
    if (resolved.fields) return { kind: "entries", entries: resolved.fields };
    return { kind: "whole", reason: resolved.reason };
  }
  if (typeof resolved.value === "string" && mode === "query") {
    return { kind: "entries", entries: queryFromString(resolved.value) };
  }
  const record = recordFields(resolved.value);
  if (record) return { kind: "entries", entries: entriesFromRecord(record, fallback) };
  return { kind: "whole", reason: fallback };
}

function member(record: { [key: string]: JsonValue }, key: string): ResolveResult | "absent" {
  if (!Object.hasOwn(record, key)) return "absent";
  const value = record[key];
  if (value === undefined) return "absent";
  return { ok: true, value };
}

function propertyName(property: ObjectLiteralElementLike): string | undefined {
  if (isSpreadAssignment(property)) return undefined;
  return propertyKey(property.name);
}

function findProperty(object: ObjectLiteralExpression, name: string): ObjectLiteralElementLike | undefined {
  for (const property of object.properties) {
    if (propertyName(property) === name) return property;
  }
  return undefined;
}

function hasProperty(object: ObjectLiteralExpression, name: string): boolean {
  return findProperty(object, name) !== undefined;
}

function propertyExpression(object: ObjectLiteralExpression, name: string): Expression | undefined {
  const property = findProperty(object, name);
  if (!property) return undefined;
  if (isPropertyAssignment(property)) return property.initializer;
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) return property.name;
  return undefined;
}

function unwrapSearchParams(expression: Expression): Expression | undefined {
  let current = unwrapExpression(expression);
  while (isNewExpression(current) && isIdentifier(current.expression) && current.expression.text === "URLSearchParams") {
    const arg = current.arguments?.[0];
    if (!arg) return undefined;
    current = unwrapExpression(arg);
  }
  return current;
}

function recordFields(value: JsonValue): { [key: string]: JsonValue } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as { [key: string]: JsonValue };
}

function entriesFromRecord(value: { [key: string]: JsonValue }, fallback: UnresolvedReason): Record<string, QueryValue> {
  const entries: Record<string, QueryValue> = {};
  for (const [key, item] of Object.entries(value)) {
    entries[key] = item === null || typeof item !== "object" ? item : { unresolved: fallback };
  }
  return entries;
}
