import { expect, it } from "vitest";
import type { SpecOperation } from "../../src/index.js";

it("round-trips a POST /orders operation", () => {
  const operation: SpecOperation = {
    method: "post",
    pathTemplate: "/orders",
    parameters: [],
    responses: {},
  };

  expect(operation.method).toBe("post");
  expect(operation.pathTemplate).toBe("/orders");
});

it("accepts method head", () => {
  const operation: SpecOperation = {
    method: "head",
    pathTemplate: "/orders",
    parameters: [],
    responses: {},
  };

  expect(operation.method).toBe("head");
});

it("rejects method query", () => {
  const operation: SpecOperation = {
    // @ts-expect-error "query" is not an HttpMethod
    method: "query",
    pathTemplate: "/orders",
    parameters: [],
    responses: {},
  };

  expect(operation.method).toBe("query");
});
