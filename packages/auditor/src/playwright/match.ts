import type { HttpMethod, SpecModel, SpecOperation } from "../spec/model.js";
import { stripBase } from "./config.js";
import type { ExtractedCall } from "./model.js";
import { originAndPath, splitPathSegments, splitUrl } from "./url.js";

const PARAM = /^\{[^{}/]+\}$/;
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
  const matched = mostSpecific(
    spec.operations.filter((operation) => templateMatches(viewed.segments, viewed.dynamic, operation.pathTemplate)),
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
  const segments = decodeSegments(splitPathSegments(concretePath));
  return { concretePath, segments, dynamic: align(path, segments.length, dynamicSegments) };
}

// Indexes are counted before stripping. The removed prefix is literal, so the shift is the drop in segment count.
function align(path: string, after: number, dynamicSegments: readonly number[] | undefined): Set<number> {
  const indexes = dynamicSegments ?? [];
  if (indexes.length === 0) return new Set();
  const bare = splitUrl(path).path;
  const before = splitPathSegments(originAndPath(bare)?.pathname ?? bare);
  const removed = Math.max(0, before.length - after);
  const dynamic = new Set<number>();
  for (const index of indexes) {
    const shifted = index - removed;
    if (shifted >= 0) dynamic.add(shifted);
  }
  return dynamic;
}

function templateMatches(segments: readonly string[], dynamic: ReadonlySet<number>, template: string): boolean {
  const expected = decodeSegments(splitPathSegments(template));
  if (expected.length !== segments.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const specSegment = expected[index];
    const got = segments[index];
    if (specSegment === undefined || got === undefined) return false;
    if (dynamic.has(index)) {
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

// A template with more literal segments outranks a parameter template. Equal scores stay ambiguous.
function mostSpecific(operations: readonly SpecOperation[]): SpecOperation[] {
  let best = -1;
  const chosen: SpecOperation[] = [];
  for (const operation of operations) {
    const score = staticSegments(operation.pathTemplate);
    if (score > best) {
      best = score;
      chosen.length = 0;
      chosen.push(operation);
    } else if (score === best) {
      chosen.push(operation);
    }
  }
  return chosen;
}

function staticSegments(template: string): number {
  let count = 0;
  for (const segment of splitPathSegments(template)) {
    if (!PARAM.test(decodeSegment(segment))) count += 1;
  }
  return count;
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
