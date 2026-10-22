import type { HttpMethod, SpecModel, SpecOperation } from "../spec/model.js";
import { stripBase } from "./config.js";
import type { ExtractedCall } from "./model.js";
import { originAndPath, splitPathSegments } from "./url.js";

const PARAM = /^\{[^{}/]+\}$/;
const DYNAMIC_TOKEN = /^AUDITOR_DYNAMIC_\d+$/;
const METHOD_ORDER = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const satisfies readonly HttpMethod[];

export type OperationMatch =
  | { operation: SpecOperation }
  | { ambiguous: true }
  | {
      operation: undefined;
      concretePath: string;
      allowedMethods?: string[];
      // Set when one template matched and the method did not. Messages print this, not concretePath.
      pathTemplate?: string;
    };

export function matchOperation(call: ExtractedCall, spec: SpecModel): OperationMatch {
  const path = call.path ?? "";
  const viewed = view(path, call.dynamicSegments, spec.servers);
  const matched = spec.operations.filter((operation) =>
    templateMatches(viewed.segments, viewed.dynamic, operation.pathTemplate),
  );
  const templates = unique(matched.map((operation) => operation.pathTemplate));
  if (templates.length > 1) return { ambiguous: true };

  const methodMatches = matched.filter((operation) => operation.method === call.method);
  if (methodMatches.length > 1) return { ambiguous: true };
  const operation = methodMatches[0];
  if (operation) return { operation };

  const template = templates[0];
  if (template !== undefined) {
    return {
      operation: undefined,
      concretePath: viewed.concretePath,
      pathTemplate: template,
      allowedMethods: allowedMethods(matched),
    };
  }
  return { operation: undefined, concretePath: viewed.concretePath };
}

function view(
  path: string,
  dynamicSegments: readonly number[] | undefined,
  servers: readonly string[],
): { concretePath: string; segments: string[]; dynamic: Set<number> } {
  const concretePath = stripBase(path, servers).path;
  const indexes = dynamicSegments ?? [];
  if (indexes.length === 0) {
    return { concretePath, segments: decodeSegments(splitPathSegments(concretePath)), dynamic: new Set() };
  }
  const stripped = stripBase(rewrite(path, new Set(indexes)), servers).path;
  const dynamic = new Set<number>();
  const segments = splitPathSegments(stripped).map((segment, index) => {
    const decoded = decodeSegment(segment);
    if (DYNAMIC_TOKEN.test(decoded)) dynamic.add(index);
    return decoded;
  });
  return { concretePath, segments, dynamic };
}

function rewrite(path: string, dynamic: ReadonlySet<number>): string {
  const located = originAndPath(path);
  if (!located) return replaceDynamicSegments(path, dynamic);
  return located.origin + replaceDynamicSegments(located.pathname, dynamic);
}

function replaceDynamicSegments(path: string, dynamic: ReadonlySet<number>): string {
  const leading = path.startsWith("/");
  const trailing = path.length > 1 && path.endsWith("/");
  const segments = splitPathSegments(path).map((segment, index) =>
    dynamic.has(index) ? `AUDITOR_DYNAMIC_${index}` : segment,
  );
  const slash = trailing && segments.length > 0 ? "/" : "";
  return `${leading ? "/" : ""}${segments.join("/")}${slash}`;
}

function templateMatches(segments: readonly string[], dynamic: ReadonlySet<number>, template: string): boolean {
  const expected = decodeSegments(splitPathSegments(template));
  if (expected.length !== segments.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const specSegment = expected[index];
    const got = segments[index];
    if (specSegment === undefined || got === undefined) return false;
    if (dynamic.has(index) || DYNAMIC_TOKEN.test(got)) {
      if (!PARAM.test(specSegment)) return false;
      continue;
    }
    if (PARAM.test(specSegment)) {
      if (got === "") return false;
      continue;
    }
    if (specSegment !== got) return false;
  }
  return true;
}

function decodeSegments(segments: readonly string[]): string[] {
  return segments.map(decodeSegment);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function allowedMethods(operations: readonly SpecOperation[]): string[] {
  const present = new Set(operations.map((operation) => operation.method));
  return METHOD_ORDER.filter((method) => present.has(method)).map((method) => method.toUpperCase());
}

function unique(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}
