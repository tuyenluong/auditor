import type { ExtractedCall } from "./playwright/model.js";
import type { SpecModel } from "./spec/model.js";

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
