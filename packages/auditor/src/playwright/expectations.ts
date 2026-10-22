import {
  isAsExpression,
  isAssignmentOperator,
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isTypeAssertion,
  isVariableDeclaration,
  type CallExpression,
  type Expression,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import type { UnresolvedReason } from "../types.js";
import { unwrapExpression, type ConstantResolver } from "./constants.js";
import type { ExtractedCall } from "./model.js";

const RANGE_MATCHERS = new Set([
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
]);

interface ResponseCall {
  node: CallExpression;
  call: ExtractedCall;
}

type StatusRead =
  | { variable: Identifier; outcome: "status"; value: number }
  | { variable: Identifier; outcome: "2xx" }
  | { variable: Identifier; outcome: "negative-ok" }
  | { variable: Identifier; outcome: "status-range" };

export function attachStatusExpectations(
  source: SourceFile,
  constants: ConstantResolver,
  responses: readonly ResponseCall[],
  calls: readonly CallExpression[],
): void {
  const byNode = new Map<CallExpression, ExtractedCall>();
  for (const entry of responses) {
    byNode.set(entry.node, entry.call);
    markReassigned(constants, source, entry);
  }
  for (const call of calls) attachExpect(source, constants, byNode, call);
}

function markReassigned(constants: ConstantResolver, source: SourceFile, entry: ResponseCall): void {
  const name = assignedName(entry.node);
  if (!name) return;
  const binding = constants.assignment(name.text, name.getStart(source));
  if (!binding || binding.assignments <= 1) return;
  addUnresolved(entry.call, entry.call.line, entry.call.column, "reassigned-response");
}

function attachExpect(
  source: SourceFile,
  constants: ConstantResolver,
  byNode: Map<CallExpression, ExtractedCall>,
  node: CallExpression,
): void {
  const read = readStatus(constants, node);
  if (!read) return;
  const call = responseCall(source, constants, byNode, read.variable);
  if (!call) return;
  const at = location(source, node);
  if (read.outcome === "negative-ok" || read.outcome === "status-range") {
    addUnresolved(call, at.line, at.column, read.outcome);
    return;
  }
  const statuses: Array<number | "2xx"> = read.outcome === "2xx" ? ["2xx"] : [read.value];
  call.expectations.push({
    responseVar: read.variable.text,
    line: at.line,
    column: at.column,
    statuses,
    contentTypes: [],
    fields: [],
    assertions: [],
  });
}

function responseCall(
  source: SourceFile,
  constants: ConstantResolver,
  byNode: Map<CallExpression, ExtractedCall>,
  variable: Identifier,
): ExtractedCall | undefined {
  const binding = constants.assignment(variable.text, variable.getStart(source));
  if (!binding || binding.assignments !== 1 || !binding.expression) return undefined;
  const expression = unwrapExpression(binding.expression);
  if (!isCallExpression(expression)) return undefined;
  return byNode.get(expression);
}

function readStatus(constants: ConstantResolver, node: CallExpression): StatusRead | undefined {
  if (!isPropertyAccessExpression(node.expression)) return undefined;
  const matcher = node.expression.name.text;
  const target = unwrapExpression(node.expression.expression);
  if (!isCallExpression(target) || !isIdentifier(target.expression) || !constants.isExpect(target.expression)) {
    return undefined;
  }
  const actual = target.arguments[0];
  if (!actual) return undefined;
  const probe = responseProbe(actual);
  if (!probe) return undefined;
  if (probe.method === "status") return statusMatcher(constants, matcher, node, probe.variable);
  return okMatcher(constants, matcher, node, probe.variable);
}

function statusMatcher(
  constants: ConstantResolver,
  matcher: string,
  node: CallExpression,
  variable: Identifier,
): StatusRead | undefined {
  if (RANGE_MATCHERS.has(matcher)) return { variable, outcome: "status-range" };
  if (matcher !== "toBe" && matcher !== "toEqual") return undefined;
  const value = resolvedNumber(constants, node.arguments[0]);
  if (value === undefined) return undefined;
  return { variable, outcome: "status", value };
}

function okMatcher(
  constants: ConstantResolver,
  matcher: string,
  node: CallExpression,
  variable: Identifier,
): StatusRead | undefined {
  if (matcher === "toBeTruthy") return { variable, outcome: "2xx" };
  if (matcher === "toBeFalsy") return { variable, outcome: "negative-ok" };
  if (matcher !== "toBe" && matcher !== "toEqual") return undefined;
  const value = resolvedBoolean(constants, node.arguments[0]);
  if (value === undefined) return undefined;
  return { variable, outcome: value ? "2xx" : "negative-ok" };
}

function responseProbe(expression: Expression): { variable: Identifier; method: "status" | "ok" } | undefined {
  const node = unwrapExpression(expression);
  if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return undefined;
  const method = node.expression.name.text;
  if (method !== "status" && method !== "ok") return undefined;
  const object = unwrapExpression(node.expression.expression);
  if (!isIdentifier(object)) return undefined;
  return { variable: object, method };
}

function resolvedNumber(constants: ConstantResolver, expression: Expression | undefined): number | undefined {
  if (!expression) return undefined;
  const resolved = constants.resolve(expression, "ambiguous-constant");
  if (!resolved.ok || typeof resolved.value !== "number" || !Number.isInteger(resolved.value)) return undefined;
  return resolved.value;
}

function resolvedBoolean(constants: ConstantResolver, expression: Expression | undefined): boolean | undefined {
  if (!expression) return undefined;
  const resolved = constants.resolve(expression, "ambiguous-constant");
  if (!resolved.ok || typeof resolved.value !== "boolean") return undefined;
  return resolved.value;
}

function assignedName(call: CallExpression): Identifier | undefined {
  let current: Node = call;
  while (true) {
    const parent = current.parent;
    if (parent === current) return undefined;
    const wrapped = wrapperExpression(parent);
    if (wrapped === current) {
      current = parent;
      continue;
    }
    if (isVariableDeclaration(parent) && parent.initializer === current && isIdentifier(parent.name)) {
      return parent.name;
    }
    if (isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind) && parent.right === current) {
      const left = unwrapExpression(parent.left);
      if (isIdentifier(left)) return left;
    }
    return undefined;
  }
}

function wrapperExpression(node: Node): Expression | undefined {
  if (
    isAwaitExpression(node) ||
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isTypeAssertion(node) ||
    isNonNullExpression(node)
  ) {
    return node.expression;
  }
  return undefined;
}

function addUnresolved(call: ExtractedCall, line: number, column: number, reason: UnresolvedReason): void {
  if (call.unresolved.some((item) => item.reason === reason)) return;
  call.unresolved.push({ file: call.file, line, column, callee: call.callee, reason });
}

function location(source: SourceFile, node: Node): { line: number; column: number } {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: point.line + 1, column: point.character + 1 };
}
