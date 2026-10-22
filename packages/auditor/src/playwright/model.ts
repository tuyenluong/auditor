import type { HttpMethod } from "../spec/model.js";
import type { UnresolvedCall, UnresolvedReason } from "../types.js";

export interface ExtractedCall {
  file: string;
  line: number;
  column: number;
  callee: string;
  method?: HttpMethod; // omitted when the method did not resolve
  path?: string; // stripped path, query removed; omitted when unresolved
  dynamicSegments?: readonly number[]; // indexes of segments filled by one unresolved expression
  pathParams: Record<string, Literal | { unresolved: UnresolvedReason }>;
  query: Record<string, Literal | { unresolved: UnresolvedReason }>;
  headers: Record<string, Literal | { unresolved: UnresolvedReason }>;
  body?: JsonValue | { unresolved: UnresolvedReason };
  expectations: ResponseExpectation[];
  unresolved: UnresolvedCall[]; // parts of this call that were skipped
}

export type Literal = string | number | boolean | null;

export type JsonValue =
  | Literal
  | JsonValue[]
  | { [key: string]: JsonValue }
  | { spread: true };

export interface ResponseExpectation {
  responseVar: string;
  line: number;
  column: number;
  statuses: Array<number | "2xx">;
  contentTypes: string[];
  fields: JsonFieldAccess[];
  assertions: Assertion[];
}

export interface JsonFieldAccess {
  path: Array<string | number>; // ["items", 0, "sku"]
  line: number;
  column: number;
}

export interface Assertion {
  path: Array<string | number>;
  line: number;
  column: number;
  kind: "literal" | "type";
  literal?: Literal;
  typeName?: "string" | "number" | "boolean" | "object" | "array";
}
