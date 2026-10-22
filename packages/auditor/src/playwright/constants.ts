import {
  ModifierFlags,
  NodeFlags,
  SyntaxKind,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isAsExpression,
  isAssignmentOperator,
  isAwaitExpression,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isBooleanLiteral,
  isCallExpression,
  isCaseBlock,
  isCatchClause,
  isClassDeclaration,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isModuleBlock,
  isNamedImports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isNonNullExpression,
  isNullLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isTypeAssertion,
  isVariableDeclarationList,
  isVariableStatement,
  type ArrayLiteralExpression,
  type BinaryExpression,
  type BindingName,
  type Expression,
  type ForInitializer,
  type FunctionLikeDeclaration,
  type Identifier,
  type ImportDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type PrefixUnaryExpression,
  type PropertyName,
  type SourceFile,
  type TemplateExpression,
  type VariableDeclaration,
  type VariableDeclarationList,
} from "typescript/unstable/ast";
import type { UnresolvedReason } from "../types.js";
import type { JsonValue } from "./model.js";

const MAX_CONSTANT_DEPTH = 10;

export interface ConstantResolver {
  resolve(expression: Expression, fallback: UnresolvedReason): ResolveResult;
}

export type ResolveResult = { ok: true; value: JsonValue } | { ok: false; reason: UnresolvedReason };

interface Scope {
  parent?: Scope;
  functionScoped: boolean;
  start: number;
  end: number;
  bindings: Map<string, Binding>;
  children: Scope[];
}

interface ValueBinding {
  kind: "value";
  assignments: number;
  expression?: Expression;
}

type Binding = { kind: "import" } | { kind: "other" } | ValueBinding;

export function createConstantResolver(source: SourceFile): ConstantResolver {
  const root = createScope(undefined, source, source, true);
  const collector = new Collector(source, root);
  collector.collect();
  return {
    resolve(expression, fallback) {
      return read(source, root, expression, fallback, 0, new Set());
    },
  };
}

export function unwrapExpression(expression: Expression): Expression {
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

class Collector {
  private current: Scope;

  constructor(
    private readonly source: SourceFile,
    private readonly root: Scope,
  ) {
    this.current = root;
  }

  collect(): void {
    this.visit(this.source);
    this.noteAssignments(this.source);
  }

  private visit(node: Node): void {
    if (isFunctionLikeDeclaration(node)) {
      this.visitFunction(node);
      return;
    }
    if (isClassDeclaration(node)) {
      if (node.name) this.current.bindings.set(node.name.text, { kind: "other" });
      this.visitChildren(node);
      return;
    }
    if (isBlock(node) || isModuleBlock(node) || isCaseBlock(node)) {
      this.push(node, false);
      this.visitChildren(node);
      this.pop();
      return;
    }
    if (isCatchClause(node)) {
      this.push(node, false);
      if (node.variableDeclaration) this.bindPattern(node.variableDeclaration.name, this.current);
      this.visit(node.block);
      this.pop();
      return;
    }
    if (isForStatement(node)) {
      this.push(node, false);
      if (node.initializer) this.visit(node.initializer);
      if (node.condition) this.visit(node.condition);
      if (node.incrementor) this.visit(node.incrementor);
      this.visit(node.statement);
      this.pop();
      return;
    }
    if (isForInStatement(node) || isForOfStatement(node)) {
      this.push(node, false);
      this.bindForBinding(node.initializer);
      this.visit(node.expression);
      this.visit(node.statement);
      this.pop();
      return;
    }
    if (isVariableStatement(node)) {
      if ((node.modifierFlags & ModifierFlags.Ambient) === 0) this.visit(node.declarationList);
      return;
    }
    if (isVariableDeclarationList(node)) {
      this.bindList(node);
      return;
    }
    if (isImportDeclaration(node)) {
      this.bindImport(node);
      return;
    }
    if (isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly) this.bindImportName(node.name.text);
      return;
    }
    this.visitChildren(node);
  }

  private visitChildren(node: Node): void {
    node.forEachChild((child) => {
      this.visit(child);
    });
  }

  private visitFunction(node: FunctionLikeDeclaration): void {
    if (isFunctionDeclaration(node) && node.name) this.current.bindings.set(node.name.text, { kind: "other" });
    this.push(node, true);
    if (isFunctionExpression(node) && node.name) this.current.bindings.set(node.name.text, { kind: "other" });
    for (const param of node.parameters) {
      this.bindPattern(param.name, this.current);
      if (param.initializer) this.visit(param.initializer);
    }
    if (node.body) this.visit(node.body);
    this.pop();
  }

  private bindList(list: VariableDeclarationList): void {
    const scope = (list.flags & NodeFlags.BlockScoped) !== 0 ? this.current : functionScopeOf(this.current);
    for (const declaration of list.declarations) this.bindDeclaration(scope, declaration);
    for (const declaration of list.declarations) {
      this.visitPatternInitializers(declaration.name);
      if (declaration.initializer) this.visit(declaration.initializer);
    }
  }

  private bindDeclaration(scope: Scope, declaration: VariableDeclaration): void {
    if (!isIdentifier(declaration.name)) {
      this.bindPattern(declaration.name, scope);
      return;
    }
    const name = declaration.name.text;
    if (scope.bindings.has(name)) {
      scope.bindings.set(name, { kind: "value", assignments: 2 });
      return;
    }
    if (declaration.initializer) {
      scope.bindings.set(name, { kind: "value", assignments: 1, expression: declaration.initializer });
      return;
    }
    scope.bindings.set(name, { kind: "value", assignments: 0 });
  }

  private bindForBinding(initializer: ForInitializer): void {
    if (!isVariableDeclarationList(initializer)) return;
    const scope = (initializer.flags & NodeFlags.BlockScoped) !== 0 ? this.current : functionScopeOf(this.current);
    for (const declaration of initializer.declarations) this.bindPattern(declaration.name, scope);
  }

  private bindPattern(name: BindingName, scope: Scope): void {
    if (isIdentifier(name)) {
      scope.bindings.set(name.text, { kind: "other" });
      return;
    }
    if (!isObjectBindingPattern(name) && !isArrayBindingPattern(name)) return;
    for (const element of name.elements) {
      if (isBindingElement(element) && element.name) this.bindPattern(element.name, scope);
    }
  }

  private visitPatternInitializers(name: BindingName): void {
    if (isIdentifier(name) || (!isObjectBindingPattern(name) && !isArrayBindingPattern(name))) return;
    for (const element of name.elements) {
      if (!isBindingElement(element)) continue;
      if (element.name) this.visitPatternInitializers(element.name);
      if (element.initializer) this.visit(element.initializer);
    }
  }

  private bindImport(node: ImportDeclaration): void {
    const clause = node.importClause;
    if (!clause || clause.phaseModifier === SyntaxKind.TypeKeyword) return;
    if (clause.name) this.bindImportName(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) return;
    if (isNamespaceImport(bindings)) {
      this.bindImportName(bindings.name.text);
      return;
    }
    if (!isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) this.bindImportName(element.name.text);
    }
  }

  private bindImportName(name: string): void {
    if (!this.current.bindings.has(name)) this.current.bindings.set(name, { kind: "import" });
  }

  private noteAssignments(node: Node): void {
    if (isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const compound = node.operatorToken.kind !== SyntaxKind.EqualsToken;
      this.noteTarget(node.left, compound ? undefined : node.right, compound);
      this.noteAssignments(node.right);
      return;
    }
    if (
      (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
      (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken)
    ) {
      this.noteTarget(node.operand, undefined, true);
      return;
    }
    node.forEachChild((child) => {
      this.noteAssignments(child);
    });
  }

  private noteTarget(target: Expression, expression: Expression | undefined, reassign: boolean): void {
    const node = unwrapExpression(target);
    if (isIdentifier(node)) {
      this.noteWrite(node, expression, reassign);
      return;
    }
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      this.noteTarget(node.left, undefined, true);
      return;
    }
    if (isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
          this.noteWrite(property.name, undefined, true);
        }
        else if (isPropertyAssignment(property)) this.noteTarget(property.initializer, undefined, true);
      }
      return;
    }
    if (isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!isOmittedExpression(element) && !isSpreadElement(element)) this.noteTarget(element, undefined, true);
      }
    }
  }

  private noteWrite(name: Identifier, expression: Expression | undefined, reassign: boolean): void {
    const binding = lookup(scopeAt(this.root, name.getStart(this.source)), name.text);
    if (!binding || binding.kind !== "value") return;
    if (reassign) {
      binding.assignments += 2;
      return;
    }
    binding.assignments += 1;
    if (binding.assignments === 1 && expression) binding.expression = expression;
  }

  private push(node: Node, functionScope: boolean): void {
    this.current = createScope(this.current, node, this.source, functionScope);
  }

  private pop(): void {
    const parent = this.current.parent;
    if (!parent) throw new Error("scope stack empty");
    this.current = parent;
  }
}

function read(
  source: SourceFile,
  root: Scope,
  expression: Expression,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<ValueBinding>,
): ResolveResult {
  const node = unwrapExpression(expression);
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return { ok: true, value: node.text };
  if (isNumericLiteral(node)) {
    const value = numberValue(node.text);
    return value === undefined ? { ok: false, reason: fallback } : { ok: true, value };
  }
  if (isBooleanLiteral(node)) return { ok: true, value: node.kind === SyntaxKind.TrueKeyword };
  if (isNullLiteral(node)) return { ok: true, value: null };
  if (isPrefixUnaryExpression(node)) return readUnary(source, root, node, fallback, depth, stack);
  if (isPostfixUnaryExpression(node)) return { ok: false, reason: "ambiguous-constant" };
  if (isTemplateExpression(node)) return readTemplate(source, root, node, fallback, depth, stack);
  if (isArrayLiteralExpression(node)) return readArray(source, root, node, fallback, depth, stack);
  if (isObjectLiteralExpression(node)) return readObject(source, root, node, fallback, depth, stack);
  if (isCallExpression(node)) return { ok: false, reason: "helper-call" };
  if (isConditionalExpression(node)) return { ok: false, reason: "ambiguous-constant" };
  if (isIdentifier(node)) return readIdentifier(source, root, node, fallback, depth, stack);
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    return { ok: false, reason: importedChain(source, root, node) ? "imported-value" : fallback };
  }
  if (isBinaryExpression(node)) return readBinary(source, root, node, fallback, depth, stack);
  return { ok: false, reason: fallback };
}

function readUnary(
  source: SourceFile,
  root: Scope,
  node: PrefixUnaryExpression,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<ValueBinding>,
): ResolveResult {
  if (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken) {
    return { ok: false, reason: "ambiguous-constant" };
  }
  const operand = read(source, root, node.operand, fallback, depth, stack);
  if (!operand.ok) return operand;
  if (typeof operand.value !== "number") return { ok: false, reason: fallback };
  if (node.operator === SyntaxKind.MinusToken) return { ok: true, value: -operand.value };
  if (node.operator === SyntaxKind.PlusToken) return { ok: true, value: operand.value };
  return { ok: false, reason: fallback };
}

function readTemplate(
  source: SourceFile,
  root: Scope,
  node: TemplateExpression,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<ValueBinding>,
): ResolveResult {
  let text = node.head.text;
  for (const span of node.templateSpans) {
    const part = read(source, root, span.expression, fallback, depth, stack);
    if (!part.ok) return part;
    const piece = interpolated(part.value);
    if (piece === undefined) return { ok: false, reason: fallback };
    text += piece + span.literal.text;
  }
  return { ok: true, value: text };
}

function readArray(
  source: SourceFile,
  root: Scope,
  node: ArrayLiteralExpression,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<ValueBinding>,
): ResolveResult {
  const items: JsonValue[] = [];
  for (const element of node.elements) {
    if (isSpreadElement(element)) return { ok: false, reason: "spread" };
    if (isOmittedExpression(element)) return { ok: false, reason: fallback };
    const item = read(source, root, element, fallback, depth, stack);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return { ok: true, value: items };
}

function readObject(
  source: SourceFile,
  root: Scope,
  node: ObjectLiteralExpression,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<ValueBinding>,
): ResolveResult {
  const value: { [key: string]: JsonValue } = {};
  for (const property of node.properties) {
    if (isSpreadAssignment(property)) return { ok: false, reason: "spread" };
    if (isShorthandPropertyAssignment(property)) {
      if (property.objectAssignmentInitializer || !isIdentifier(property.name)) {
        return { ok: false, reason: fallback };
      }
      const item = read(source, root, property.name, fallback, depth, stack);
      if (!item.ok) return item;
      value[property.name.text] = item.value;
      continue;
    }
    if (!isPropertyAssignment(property)) return { ok: false, reason: fallback };
    if (isComputedPropertyName(property.name)) return { ok: false, reason: "computed-key" };
    const key = staticKey(property.name);
    if (key === undefined) return { ok: false, reason: fallback };
    const item = read(source, root, property.initializer, fallback, depth, stack);
    if (!item.ok) return item;
    value[key] = item.value;
  }
  return { ok: true, value };
}

function readIdentifier(
  source: SourceFile,
  root: Scope,
  node: Identifier,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<ValueBinding>,
): ResolveResult {
  const binding = lookup(scopeAt(root, node.getStart(source)), node.text);
  if (!binding) return { ok: false, reason: fallback };
  if (binding.kind === "import") return { ok: false, reason: "imported-value" };
  if (binding.kind !== "value") return { ok: false, reason: fallback };
  if (binding.assignments !== 1 || binding.expression === undefined) {
    return { ok: false, reason: binding.assignments > 1 ? "ambiguous-constant" : fallback };
  }
  if (stack.has(binding)) return { ok: false, reason: "ambiguous-constant" };
  if (depth >= MAX_CONSTANT_DEPTH) return { ok: false, reason: "ambiguous-constant" };
  stack.add(binding);
  const result = read(source, root, binding.expression, fallback, depth + 1, stack);
  stack.delete(binding);
  return result;
}

function readBinary(
  source: SourceFile,
  root: Scope,
  node: BinaryExpression,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<ValueBinding>,
): ResolveResult {
  if (node.operatorToken.kind !== SyntaxKind.PlusToken) return { ok: false, reason: fallback };
  const left = read(source, root, node.left, fallback, depth, stack);
  if (!left.ok) return left;
  const right = read(source, root, node.right, fallback, depth, stack);
  if (!right.ok) return right;
  if (typeof left.value === "string" && typeof right.value === "string") {
    return { ok: true, value: left.value + right.value };
  }
  return { ok: false, reason: fallback };
}

function importedChain(source: SourceFile, root: Scope, expression: Expression): boolean {
  let current = unwrapExpression(expression);
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  if (!isIdentifier(current)) return false;
  return lookup(scopeAt(root, current.getStart(source)), current.text)?.kind === "import";
}

function createScope(parent: Scope | undefined, node: Node, source: SourceFile, functionScoped: boolean): Scope {
  const scope: Scope = {
    ...(parent ? { parent } : {}),
    functionScoped: functionScoped || !parent,
    start: node.getStart(source),
    end: node.end,
    bindings: new Map(),
    children: [],
  };
  parent?.children.push(scope);
  return scope;
}

function functionScopeOf(scope: Scope): Scope {
  let current = scope;
  while (!current.functionScoped && current.parent) current = current.parent;
  return current;
}

function scopeAt(root: Scope, position: number): Scope {
  let current = root;
  while (current.children.length > 0) {
    const nested = current.children.find((child) => position >= child.start && position < child.end);
    if (!nested) return current;
    current = nested;
  }
  return current;
}

function lookup(scope: Scope, name: string): Binding | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return undefined;
}

function staticKey(name: PropertyName): string | undefined {
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

function interpolated(value: JsonValue): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return undefined;
}

function numberValue(text: string): number | undefined {
  const value = Number(text.replaceAll("_", ""));
  return Number.isFinite(value) ? value : undefined;
}
