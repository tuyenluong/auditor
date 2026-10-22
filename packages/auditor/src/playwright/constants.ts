import {
  ModifierFlags,
  NodeFlags,
  SyntaxKind,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrowFunction,
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
  type ArrowFunction,
  type BinaryExpression,
  type BindingName,
  type CallExpression,
  type Expression,
  type ForInitializer,
  type FunctionExpression,
  type FunctionLikeDeclaration,
  type Identifier,
  type ImportDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PrefixUnaryExpression,
  type PropertyName,
  type SourceFile,
  type TemplateExpression,
  type VariableDeclaration,
  type VariableDeclarationList,
} from "typescript/unstable/ast";
import type { UnresolvedReason } from "../types.js";
import type { JsonValue, Literal } from "./model.js";
import { DYNAMIC_HOLE } from "./url.js";

const MAX_CONSTANT_DEPTH = 10;

export interface ResolveOptions {
  dynamicPath?: boolean;
}

export interface ConstantResolver {
  resolve(expression: Expression, fallback: UnresolvedReason, options?: ResolveOptions): ResolveResult;
  bindingKind(name: string, position: number): BindingKind | undefined;
  isTestCall(node: CallExpression): boolean;
  isDefineConfig(name: string, position: number): boolean;
  boundExpression(expression: Expression): Expression | undefined;
}

export type ResolvedField = Literal | { unresolved: UnresolvedReason };

export type ResolveResult =
  | { ok: true; value: JsonValue }
  | { ok: false; reason: UnresolvedReason; fields?: Record<string, ResolvedField> };

export type BindingKind = Binding["kind"];

interface Scope {
  parent?: Scope;
  functionScoped: boolean;
  start: number;
  end: number;
  bindings: Map<string, Binding>;
  children: Scope[];
}

interface AssignedBinding {
  kind: "value" | "context";
  assignments: number;
  expression?: Expression;
}

type Binding =
  | { kind: "import"; defineConfig?: true }
  | { kind: "imported-request" }
  | { kind: "test" }
  | { kind: "fixture" }
  | { kind: "other" }
  | AssignedBinding;

type ImportKind = "import" | "imported-request" | "test";

export function createConstantResolver(source: SourceFile): ConstantResolver {
  const root = createScope(undefined, source, source, true);
  const collector = new Collector(source, root);
  collector.collect();
  return {
    resolve(expression, fallback, options) {
      const result = read(source, root, expression, fallback, 0, new Set(), options?.dynamicPath === true);
      if (!result.ok && !isObjectLiteralExpression(unwrapExpression(expression))) {
        return { ok: false, reason: result.reason };
      }
      return result;
    },
    bindingKind(name, position) {
      return lookup(scopeAt(root, position), name)?.kind;
    },
    isTestCall(node) {
      return isPlaywrightTestCall(root, source, node);
    },
    isDefineConfig(name, position) {
      const binding = lookup(scopeAt(root, position), name);
      return binding?.kind === "import" && binding.defineConfig === true;
    },
    boundExpression(expression) {
      return followBinding(source, root, expression, 0, new Set());
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

export function propertyKey(name: PropertyName): string | undefined {
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

export function testCallback(node: CallExpression): { index: number; fn?: ArrowFunction | FunctionExpression } {
  for (let index = node.arguments.length - 1; index >= 0; index -= 1) {
    const arg = node.arguments[index];
    if (!arg) continue;
    const fn = unwrapExpression(arg);
    if (isArrowFunction(fn) || isFunctionExpression(fn)) return { index, fn };
  }
  return { index: -1 };
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
      if (!node.isTypeOnly) this.bindImportName(node.name.text, "import");
      return;
    }
    if (isCallExpression(node) && isPlaywrightTestCall(this.root, this.source, node)) {
      this.visitTestCall(node);
      return;
    }
    this.visitChildren(node);
  }

  private visitChildren(node: Node): void {
    node.forEachChild((child) => {
      this.visit(child);
    });
  }

  private visitTestCall(node: CallExpression): void {
    const callback = testCallback(node);
    for (let index = 0; index < node.arguments.length; index += 1) {
      const arg = node.arguments[index];
      if (arg && index !== callback.index) this.visit(arg);
    }
    if (!callback.fn) return;
    this.visitFunction(callback.fn, new Set(fixtureNames(callback.fn.parameters[0])));
  }

  private visitFunction(node: FunctionLikeDeclaration, fixtures?: ReadonlySet<string>): void {
    if (isFunctionDeclaration(node) && node.name) this.current.bindings.set(node.name.text, { kind: "other" });
    this.push(node, true);
    if (isFunctionExpression(node) && node.name) this.current.bindings.set(node.name.text, { kind: "other" });
    for (let index = 0; index < node.parameters.length; index += 1) {
      const param = node.parameters[index];
      if (!param) continue;
      if (index === 0 && fixtures) this.bindFixture(param.name, fixtures);
      else this.bindPattern(param.name, this.current);
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
    const initializer = declaration.initializer;
    const opened = initializer ? unwrapExpression(initializer) : undefined;
    if (!isIdentifier(declaration.name)) {
      if (opened && isPlaywrightRequire(opened)) this.bindDefineConfigRequire(declaration.name, scope);
      else this.bindPattern(declaration.name, scope);
      return;
    }
    const name = declaration.name.text;
    if (opened && isDefineConfigRequire(opened)) {
      this.bindDefineConfigName(scope, name);
      return;
    }
    if (initializer && isNewContext(this.current, initializer)) {
      scope.bindings.set(name, { kind: "context", assignments: scope.bindings.has(name) ? 2 : 1, expression: initializer });
      return;
    }
    if (scope.bindings.has(name)) {
      scope.bindings.set(name, { kind: "value", assignments: 2 });
      return;
    }
    if (initializer) {
      scope.bindings.set(name, { kind: "value", assignments: 1, expression: initializer });
      return;
    }
    scope.bindings.set(name, { kind: "value", assignments: 0 });
  }

  private bindForBinding(initializer: ForInitializer): void {
    if (!isVariableDeclarationList(initializer)) return;
    const scope = (initializer.flags & NodeFlags.BlockScoped) !== 0 ? this.current : functionScopeOf(this.current);
    for (const declaration of initializer.declarations) this.bindPattern(declaration.name, scope);
  }

  private bindFixture(name: BindingName | undefined, fixtures: ReadonlySet<string>): void {
    if (!name) return;
    if (isIdentifier(name)) {
      this.current.bindings.set(name.text, fixtures.has(name.text) ? { kind: "fixture" } : { kind: "other" });
      return;
    }
    if (!isObjectBindingPattern(name) && !isArrayBindingPattern(name)) return;
    for (const element of name.elements) {
      if (!isBindingElement(element) || !element.name) continue;
      if (isIdentifier(element.name) && fixtures.has(element.name.text)) {
        this.current.bindings.set(element.name.text, { kind: "fixture" });
        continue;
      }
      this.bindPattern(element.name, this.current);
    }
  }

  private bindPattern(name: BindingName | undefined, scope: Scope): void {
    if (!name) return;
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
    const fromPlaywright = isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "@playwright/test";
    if (clause.name) this.bindImportName(clause.name.text, "import");
    const bindings = clause.namedBindings;
    if (!bindings) return;
    if (isNamespaceImport(bindings)) {
      this.bindImportName(bindings.name.text, "import");
      return;
    }
    if (!isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      const defineConfig = fromPlaywright && imported === "defineConfig";
      const kind: ImportKind =
        fromPlaywright && imported === "request" ? "imported-request"
        : fromPlaywright && imported === "test" ? "test"
        : "import";
      this.bindImportName(element.name.text, kind, defineConfig);
    }
  }

  private bindDefineConfigRequire(name: BindingName, scope: Scope): void {
    if (!isObjectBindingPattern(name)) {
      this.bindPattern(name, scope);
      return;
    }
    for (const element of name.elements) {
      if (!isBindingElement(element) || !element.name) continue;
      const imported = isIdentifier(element.name)
        ? element.propertyName
          ? propertyKey(element.propertyName)
          : element.name.text
        : undefined;
      if (imported === "defineConfig" && isIdentifier(element.name)) {
        this.bindDefineConfigName(scope, element.name.text);
        continue;
      }
      this.bindPattern(element.name, scope);
    }
  }

  private bindDefineConfigName(scope: Scope, name: string): void {
    if (!scope.bindings.has(name)) scope.bindings.set(name, { kind: "import", defineConfig: true });
  }

  private bindImportName(name: string, kind: ImportKind, defineConfig = false): void {
    if (this.current.bindings.has(name)) return;
    if (defineConfig) this.current.bindings.set(name, { kind: "import", defineConfig: true });
    else this.current.bindings.set(name, { kind });
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
    if (!binding || (binding.kind !== "value" && binding.kind !== "context")) return;
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
  stack: Set<AssignedBinding>,
  dynamicPath = false,
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
  if (isTemplateExpression(node)) return readTemplate(source, root, node, fallback, depth, stack, dynamicPath);
  if (isArrayLiteralExpression(node)) return readArray(source, root, node, fallback, depth, stack);
  if (isObjectLiteralExpression(node)) return readObject(source, root, node, fallback, depth, stack);
  if (isCallExpression(node)) return { ok: false, reason: "helper-call" };
  if (isConditionalExpression(node)) return { ok: false, reason: "ambiguous-constant" };
  if (isIdentifier(node)) return readIdentifier(source, root, node, fallback, depth, stack, dynamicPath);
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
  stack: Set<AssignedBinding>,
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
  stack: Set<AssignedBinding>,
  dynamicPath: boolean,
): ResolveResult {
  const chunks: TemplateChunk[] = [{ kind: "text", text: node.head.text }];
  for (const span of node.templateSpans) {
    const part = read(source, root, span.expression, fallback, depth, stack);
    if (!part.ok) {
      if (!(dynamicPath && allowsDynamicHole(span.expression, part.reason))) return { ok: false, reason: part.reason };
      chunks.push({ kind: "hole", reason: part.reason });
    } else {
      const piece = interpolated(part.value);
      if (piece === undefined) return { ok: false, reason: fallback };
      chunks.push({ kind: "text", text: piece });
    }
    chunks.push({ kind: "text", text: span.literal.text });
  }
  if (!dynamicPath || chunks.every((chunk) => chunk.kind === "text")) {
    return { ok: true, value: chunks.map((chunk) => (chunk.kind === "text" ? chunk.text : "")).join("") };
  }
  return assembleDynamicPath(chunks);
}

type TemplateChunk = { kind: "text"; text: string } | { kind: "hole"; reason: UnresolvedReason };

function assembleDynamicPath(chunks: readonly TemplateChunk[]): ResolveResult {
  let value = "";
  let inSuffix = false;
  let segmentText = false;
  let holes = 0;
  let holeReason: UnresolvedReason | undefined;
  let failure: UnresolvedReason | undefined;

  const finishSegment = (): void => {
    if (holes > 1 || (holes === 1 && segmentText)) failure ??= holeReason ?? "non-literal-url";
    segmentText = false;
    holes = 0;
    holeReason = undefined;
  };

  for (const chunk of chunks) {
    if (chunk.kind === "hole") {
      if (inSuffix) {
        failure ??= chunk.reason;
        continue;
      }
      holes += 1;
      holeReason ??= chunk.reason;
      value += DYNAMIC_HOLE;
      continue;
    }
    for (const char of chunk.text) {
      if (!inSuffix && (char === "?" || char === "#")) {
        finishSegment();
        inSuffix = true;
      } else if (!inSuffix && char === "/") {
        finishSegment();
      } else if (!inSuffix) {
        segmentText = true;
      }
      value += char;
    }
  }
  if (!inSuffix) finishSegment();
  if (failure) return { ok: false, reason: failure };
  return { ok: true, value };
}

// `${a + b}` can expand past one segment. Imports and calls stay unresolved notes.
function allowsDynamicHole(expression: Expression, reason: UnresolvedReason): boolean {
  if (reason === "imported-value" || reason === "helper-call") return false;
  const node = unwrapExpression(expression);
  return !(isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken);
}

function readArray(
  source: SourceFile,
  root: Scope,
  node: ArrayLiteralExpression,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<AssignedBinding>,
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
  stack: Set<AssignedBinding>,
): ResolveResult {
  const value: { [key: string]: JsonValue } = {};
  const fields: Record<string, ResolvedField> = {};
  let failure: UnresolvedReason | undefined;
  for (const property of node.properties) {
    if (isSpreadAssignment(property)) return { ok: false, reason: "spread" };
    if (isComputedName(property)) return { ok: false, reason: "computed-key" };
    if (isShorthandPropertyAssignment(property)) {
      if (property.objectAssignmentInitializer || !isIdentifier(property.name)) return { ok: false, reason: fallback };
      const reason = recordProperty(source, root, value, fields, property.name.text, property.name, fallback, depth, stack);
      if (reason) failure ??= reason;
      continue;
    }
    if (!isPropertyAssignment(property)) return { ok: false, reason: fallback };
    const key = propertyKey(property.name);
    if (key === undefined) return { ok: false, reason: fallback };
    const reason = recordProperty(source, root, value, fields, key, property.initializer, fallback, depth, stack);
    if (reason) failure ??= reason;
  }
  if (failure) return { ok: false, reason: failure, fields };
  return { ok: true, value };
}

function recordProperty(
  source: SourceFile,
  root: Scope,
  value: { [key: string]: JsonValue },
  fields: Record<string, ResolvedField>,
  key: string,
  expression: Expression,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<AssignedBinding>,
): UnresolvedReason | undefined {
  const item = read(source, root, expression, fallback, depth, stack);
  if (!item.ok) {
    fields[key] = { unresolved: item.reason };
    return item.reason;
  }
  value[key] = item.value;
  fields[key] = fieldValue(item.value, fallback);
  return undefined;
}

function followBinding(
  source: SourceFile,
  root: Scope,
  expression: Expression,
  depth: number,
  stack: Set<AssignedBinding>,
): Expression | undefined {
  const node = unwrapExpression(expression);
  if (!isIdentifier(node)) return node;
  const binding = lookup(scopeAt(root, node.getStart(source)), node.text);
  if (!binding || binding.kind !== "value") return undefined;
  if (binding.assignments !== 1 || binding.expression === undefined) return undefined;
  if (stack.has(binding) || depth >= MAX_CONSTANT_DEPTH) return undefined;
  stack.add(binding);
  const followed = followBinding(source, root, binding.expression, depth + 1, stack);
  stack.delete(binding);
  return followed;
}

function isPlaywrightRequire(expression: Expression): boolean {
  if (!isCallExpression(expression) || !isIdentifier(expression.expression) || expression.expression.text !== "require") {
    return false;
  }
  const specifier = expression.arguments[0];
  return specifier !== undefined && isStringLiteral(specifier) && specifier.text === "@playwright/test";
}

function isDefineConfigRequire(expression: Expression): boolean {
  return (
    isPropertyAccessExpression(expression) &&
    expression.name.text === "defineConfig" &&
    isPlaywrightRequire(unwrapExpression(expression.expression))
  );
}

function readIdentifier(
  source: SourceFile,
  root: Scope,
  node: Identifier,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<AssignedBinding>,
  dynamicPath: boolean,
): ResolveResult {
  const binding = lookup(scopeAt(root, node.getStart(source)), node.text);
  if (!binding) return { ok: false, reason: fallback };
  if (binding.kind === "import" || binding.kind === "imported-request" || binding.kind === "test") {
    return { ok: false, reason: "imported-value" };
  }
  if (binding.kind !== "value" && binding.kind !== "context") return { ok: false, reason: fallback };
  if (binding.assignments !== 1 || binding.expression === undefined) {
    return { ok: false, reason: binding.assignments > 1 ? "ambiguous-constant" : fallback };
  }
  if (stack.has(binding)) return { ok: false, reason: "ambiguous-constant" };
  if (depth >= MAX_CONSTANT_DEPTH) return { ok: false, reason: "ambiguous-constant" };
  stack.add(binding);
  const result = read(source, root, binding.expression, fallback, depth + 1, stack, dynamicPath);
  stack.delete(binding);
  if (!result.ok) return { ok: false, reason: result.reason };
  return result;
}

function readBinary(
  source: SourceFile,
  root: Scope,
  node: BinaryExpression,
  fallback: UnresolvedReason,
  depth: number,
  stack: Set<AssignedBinding>,
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

function isPlaywrightTestCall(root: Scope, source: SourceFile, node: CallExpression): boolean {
  const expr = node.expression;
  if (isIdentifier(expr)) return isPlaywrightTest(root, source, expr);
  if (isPropertyAccessExpression(expr) && isIdentifier(expr.expression)) {
    const name = expr.name.text;
    return (name === "only" || name === "skip" || name === "fixme") && isPlaywrightTest(root, source, expr.expression);
  }
  return false;
}

function isPlaywrightTest(root: Scope, source: SourceFile, name: Identifier): boolean {
  const kind = lookup(scopeAt(root, name.getStart(source)), name.text)?.kind;
  return kind === "test" || (kind === undefined && name.text === "test");
}

function isNewContext(scope: Scope, expression: Expression): boolean {
  const node = unwrapExpression(expression);
  if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return false;
  const object = node.expression.expression;
  if (!isIdentifier(object) || node.expression.name.text !== "newContext") return false;
  return lookup(scope, object.text)?.kind === "imported-request";
}

function fixtureNames(parameter: { name?: BindingName } | undefined): string[] {
  if (!parameter?.name || !isObjectBindingPattern(parameter.name)) return [];
  const names: string[] = [];
  for (const element of parameter.name.elements) {
    if (!isBindingElement(element) || !element.name || !isIdentifier(element.name)) continue;
    const renamed = element.propertyName === undefined ? element.name.text : propertyKey(element.propertyName);
    if (renamed === "request") names.push(element.name.text);
  }
  return names;
}

function importedChain(source: SourceFile, root: Scope, expression: Expression): boolean {
  let current = unwrapExpression(expression);
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  if (!isIdentifier(current)) return false;
  const kind = lookup(scopeAt(root, current.getStart(source)), current.text)?.kind;
  return kind === "import" || kind === "imported-request" || kind === "test";
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

function isComputedName(property: ObjectLiteralElementLike): boolean {
  if (isSpreadAssignment(property)) return false;
  return isComputedPropertyName(property.name);
}

function fieldValue(value: JsonValue, fallback: UnresolvedReason): ResolvedField {
  if (value === null || typeof value !== "object") return value;
  return { unresolved: fallback };
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
