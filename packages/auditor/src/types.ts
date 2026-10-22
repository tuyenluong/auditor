export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options"
  | "trace";

export type RuleId =
  | "auditor/unknown-operation"
  | "auditor/unknown-body-field"
  | "auditor/missing-required-body-field"
  | "auditor/unknown-param"
  | "auditor/missing-required-param"
  | "auditor/undocumented-status"
  | "auditor/unknown-response-field"
  | "auditor/asserted-value"
  | "auditor/content-type";

export type Severity = "error" | "warning";

export interface Finding {
  file: string;
  line: number; // 1-based
  column: number; // 1-based, ts.getLineAndCharacterOfPosition column + 1
  ruleId: RuleId;
  message: string;
  severity: Severity;
  suggestion?: string; // schema spelling, when the message has a "Did you mean" hint
}

export type UnresolvedReason =
  | "non-literal-url"
  | "non-literal-method"
  | "non-literal-data"
  | "non-literal-param"
  | "non-literal-header"
  | "helper-call"
  | "imported-value"
  | "spread"
  | "computed-key"
  | "ambiguous-constant"
  | "reassigned-response"
  | "negative-ok"
  | "status-range"
  | "ambiguous-response-schema"
  | "ambiguous-content-type"
  | "raw-string-body"
  | "form-body"
  | "outside-test"
  | "ambiguous-path";

export interface UnresolvedCall {
  file: string;
  line: number;
  column: number;
  callee: string; // e.g. "request.post" or "api.fetch"
  reason: UnresolvedReason;
  detail?: string;
}

export interface SpecParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema?: JsonSchema;
}

export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
  format?: string;
}

export interface SpecOperation {
  method: HttpMethod;
  pathTemplate: string; // "/orders/{id}"
  operationId?: string;
  parameters: SpecParameter[];
  requestBody?: {
    required: boolean;
    content: Record<string, JsonSchema>; // media type to schema
  };
  responses: Record<string, { content: Record<string, JsonSchema> }>;
}

export interface SpecModel {
  openapi: string; // "3.0.3" or "3.1.0"
  title?: string;
  version?: string; // info.version
  source: "file" | "live" | "pinned";
  location: string;
  operations: SpecOperation[];
  servers: string[]; // servers[].url values that are strings
}

export interface ExtractedCall {
  file: string;
  line: number;
  column: number;
  callee: string;
  method?: HttpMethod; // omitted when the method did not resolve
  path?: string; // stripped path, query removed; omitted when unresolved
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

export interface CheckOptions {
  cwd?: string;
  baseURL?: string;
  playwrightConfigPath?: string | null; // null skips the config search
  allowHosts?: readonly string[];
  specAuthHeader?: string; // already formatted; library does not read env
  pinPath?: string;
  savePinPath?: string;
  rules?: Partial<Record<RuleId, Severity | "off">>;
}

export interface TestFileInput {
  path: string;
  text?: string; // editor buffer; omit to read from disk
}

export interface CheckResult {
  spec: SpecModel;
  calls: ExtractedCall[];
  findings: Finding[];
  unresolved: UnresolvedCall[];
  summary: {
    checked: number;
    unresolved: number;
    partial: number;
    findings: number;
  };
}
