import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  AuditorError,
  type Finding,
  type RuleId,
  type UnresolvedCall,
  type UnresolvedReason,
} from "../src/index.js";

it("constructs a Finding", () => {
  const finding: Finding = {
    file: "orders.spec.ts",
    line: 10,
    column: 4,
    ruleId: "auditor/unknown-operation",
    message: "POST /orders is not in the spec",
    severity: "error",
  };

  expect(finding).toEqual({
    file: "orders.spec.ts",
    line: 10,
    column: 4,
    ruleId: "auditor/unknown-operation",
    message: "POST /orders is not in the spec",
    severity: "error",
  });
});

it("constructs an UnresolvedCall", () => {
  const call: UnresolvedCall = {
    file: "orders.spec.ts",
    line: 22,
    column: 8,
    callee: "request.post",
    reason: "helper-call",
    detail: "buildUrl()",
  };

  expect(call).toEqual({
    file: "orders.spec.ts",
    line: 22,
    column: 8,
    callee: "request.post",
    reason: "helper-call",
    detail: "buildUrl()",
  });
});

it("rejects a ruleId typo", () => {
  // @ts-expect-error ruleId typos are not assignable to RuleId
  const ruleId: RuleId = "auditor/unknown-operaton";

  expect(ruleId).toBe("auditor/unknown-operaton");
});

it("rejects a reason typo", () => {
  // @ts-expect-error reason typos are not assignable to UnresolvedReason
  const reason: UnresolvedReason = "helper-calls";

  expect(reason).toBe("helper-calls");
});

it("reads src/index.ts and rejects a CLI import", () => {
  const indexPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../src/index.ts",
  );
  const source = readFileSync(indexPath, "utf8");

  expect(source).not.toMatch(/cli\//);
});

it("constructs an AuditorError with exit code 2", () => {
  const error = new AuditorError("Spec not found: openapi.yaml", "SPEC_NOT_FOUND");
  const exitCode: 2 = error.exitCode;

  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(AuditorError);
  expect(error.name).toBe("AuditorError");
  expect(error.message).toBe("Spec not found: openapi.yaml");
  expect(error.code).toBe("SPEC_NOT_FOUND");
  expect(exitCode).toBe(2);
});
