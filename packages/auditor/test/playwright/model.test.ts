import { expect, it } from "vitest";
import type { ExtractedCall } from "../../src/index.js";

it("builds a call with a resolved path", () => {
  const call: ExtractedCall = {
    file: "orders.spec.ts",
    line: 12,
    column: 3,
    callee: "request.get",
    method: "get",
    path: "/orders/{id}",
    pathParams: { id: "1" },
    query: {},
    headers: {},
    expectations: [],
    unresolved: [],
  };

  expect(call.path).toBe("/orders/{id}");
  expect(call.method).toBe("get");
  expect(call.unresolved).toEqual([]);
});

it("builds a call with an unresolved helper-call", () => {
  const call: ExtractedCall = {
    file: "orders.spec.ts",
    line: 40,
    column: 3,
    callee: "request.post",
    pathParams: {},
    query: {},
    headers: {},
    expectations: [],
    unresolved: [
      {
        file: "orders.spec.ts",
        line: 40,
        column: 3,
        callee: "request.post",
        reason: "helper-call",
      },
    ],
  };

  expect(call.path).toBeUndefined();
  expect(call.unresolved).toEqual([
    {
      file: "orders.spec.ts",
      line: 40,
      column: 3,
      callee: "request.post",
      reason: "helper-call",
    },
  ]);
});

it("rejects unresolved reason guessed", () => {
  const call: ExtractedCall = {
    file: "orders.spec.ts",
    line: 40,
    column: 3,
    callee: "request.post",
    pathParams: {},
    query: {},
    headers: {},
    expectations: [],
    unresolved: [
      {
        file: "orders.spec.ts",
        line: 40,
        column: 3,
        callee: "request.post",
        // @ts-expect-error "guessed" is not an UnresolvedReason
        reason: "guessed",
      },
    ],
  };

  expect(call.unresolved[0]?.reason).toBe("guessed");
});
