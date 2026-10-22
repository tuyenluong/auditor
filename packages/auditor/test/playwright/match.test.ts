import { expect, it } from "vitest";
import { extractCalls } from "../../src/playwright/extract.js";
import { matchOperation } from "../../src/playwright/match.js";
import type { ExtractedCall } from "../../src/playwright/model.js";
import type { HttpMethod, SpecModel, SpecOperation } from "../../src/spec/model.js";

function operation(method: HttpMethod, pathTemplate: string): SpecOperation {
  return { method, pathTemplate, parameters: [], responses: {} };
}

function spec(operations: SpecOperation[], servers: string[] = []): SpecModel {
  return {
    openapi: "3.0.3",
    source: "file",
    location: "openapi.yaml",
    operations,
    servers,
  };
}

function call(method: HttpMethod, path: string, dynamicSegments?: readonly number[]): ExtractedCall {
  const extracted: ExtractedCall = {
    file: "orders.spec.ts",
    line: 1,
    column: 1,
    callee: `request.${method}`,
    method,
    path,
    pathParams: {},
    query: {},
    headers: {},
    expectations: [],
    unresolved: [],
  };
  if (dynamicSegments !== undefined) extracted.dynamicSegments = dynamicSegments;
  return extracted;
}

function sourceCall(text: string): ExtractedCall {
  const extracted = extractCalls({ path: "orders.spec.ts", text })[0];
  if (!extracted) throw new Error("missing call");
  return extracted;
}

it("matches GET /orders/1 to GET /orders/{id} and not GET /orders", () => {
  const list = operation("get", "/orders");
  const byId = operation("get", "/orders/{id}");

  expect(matchOperation(call("get", "/orders/1"), spec([list, byId]))).toEqual({ operation: byId });
});

it("matches GET /orders/${orderId} from source text when the identifier is not a constant", () => {
  const extracted = sourceCall("test('a', async ({ request }) => { await request.get(`/orders/${orderId}`) })");
  const byId = operation("get", "/orders/{id}");

  expect(extracted.method).toBe("get");
  expect(extracted.path).toBe("/orders/{}");
  expect(extracted.dynamicSegments).toEqual([1]);
  expect(extracted.unresolved).toEqual([]);
  expect(matchOperation(extracted, spec([operation("get", "/orders"), byId]))).toEqual({ operation: byId });
});

it("matches a dynamic template stored in a same-file const", () => {
  const extracted = sourceCall(
    [
      "const url = `/orders/${orderId}`;",
      "test('a', async ({ request }) => { await request.get(url) })",
    ].join("\n"),
  );
  const byId = operation("get", "/orders/{id}");

  expect(extracted.path).toBe("/orders/{}");
  expect(extracted.dynamicSegments).toEqual([1]);
  expect(extracted.unresolved).toEqual([]);
  expect(matchOperation(extracted, spec([byId]))).toEqual({ operation: byId });
});

it("does not ignore static segments after a parameter", () => {
  expect(matchOperation(call("get", "/orders/1/nope"), spec([operation("get", "/orders/{id}/items")]))).toEqual({
    operation: undefined,
    concretePath: "/orders/1/nope",
  });
});

it("matches each dynamic segment to its own parameter", () => {
  const extracted = sourceCall(
    "test('a', async ({ request }) => { await request.get(`/orders/${orderId}/items/${itemId}`) })",
  );
  const items = operation("get", "/orders/{id}/items/{sku}");

  expect(extracted.path).toBe("/orders/{}/items/{}");
  expect(extracted.dynamicSegments).toEqual([1, 3]);
  expect(extracted.unresolved).toEqual([]);
  expect(matchOperation(extracted, spec([operation("get", "/orders/{id}"), items]))).toEqual({ operation: items });
});

it("matches GET /orders/1/ to the same template", () => {
  const byId = operation("get", "/orders/{id}");

  expect(matchOperation(call("get", "/orders/1/"), spec([operation("get", "/orders"), byId]))).toEqual({
    operation: byId,
  });
});

it("returns allowed methods when the path matches a different method", () => {
  expect(matchOperation(call("post", "/orders/1"), spec([operation("get", "/orders/{id}")]))).toEqual({
    operation: undefined,
    concretePath: "/orders/1",
    pathTemplate: "/orders/{id}",
    allowedMethods: ["GET"],
  });
});

it("lists allowed methods in canonical order", () => {
  expect(
    matchOperation(
      call("delete", "/orders/1"),
      spec([operation("post", "/orders/{id}"), operation("get", "/orders/{id}")]),
    ),
  ).toEqual({
    operation: undefined,
    concretePath: "/orders/1",
    pathTemplate: "/orders/{id}",
    allowedMethods: ["GET", "POST"],
  });
});

it("returns the concrete path when no template matches", () => {
  expect(matchOperation(call("post", "/nope"), spec([operation("get", "/orders/{id}")]))).toEqual({
    operation: undefined,
    concretePath: "/nope",
  });
});

it("returns ambiguous when two templates match", () => {
  expect(
    matchOperation(
      call("get", "/orders/1"),
      spec([operation("get", "/orders/{id}"), operation("get", "/orders/{orderId}")]),
    ),
  ).toEqual({ ambiguous: true });
});

it("decodes a percent-encoded segment before matching", () => {
  const spaced = operation("get", "/orders/a b");

  expect(matchOperation(call("get", "/orders/a%20b"), spec([spaced]))).toEqual({ operation: spaced });
});

it("decodes a segment after splitting so an encoded slash stays one segment", () => {
  const one = operation("get", "/orders/{id}");
  const two = operation("get", "/orders/{a}/{b}");

  expect(matchOperation(call("get", "/orders/a%2Fb"), spec([two, one]))).toEqual({ operation: one });
});

it("does not match a dynamic segment to a static template segment", () => {
  const extracted = sourceCall("test('a', async ({ request }) => { await request.get(`/orders/${orderId}`) })");

  expect(matchOperation(extracted, spec([operation("get", "/orders/1")]))).toEqual({
    operation: undefined,
    concretePath: "/orders/{}",
  });
});

it("matches literal /orders/AUDITOR_DYNAMIC_1 to the literal operation", () => {
  const byId = operation("get", "/orders/{id}");
  const literal = operation("get", "/orders/AUDITOR_DYNAMIC_1");

  expect(matchOperation(call("get", "/orders/AUDITOR_DYNAMIC_1"), spec([byId, literal]))).toEqual({
    operation: literal,
  });
});

it("shifts a dynamic segment when a server base path is stripped", () => {
  const byId = operation("get", "/orders/{id}");

  expect(
    matchOperation(
      call("get", "https://api.example.com/v1/orders/{}", [2]),
      spec([byId], ["https://api.example.com/v1"]),
    ),
  ).toEqual({ operation: byId });
});

it("strips a server prefix before matching", () => {
  const byId = operation("get", "/orders/{id}");

  expect(
    matchOperation(call("get", "https://api.example.com/v1/orders/1"), spec([byId], ["https://api.example.com/v1"])),
  ).toEqual({ operation: byId });
});

it("strips a server prefix from a dynamic segment path", () => {
  const extracted = sourceCall(
    "test('a', async ({ request }) => { await request.get(`https://api.example.com/v1/orders/${orderId}`) })",
  );
  const byId = operation("get", "/orders/{id}");

  expect(extracted.path).toBe("https://api.example.com/v1/orders/{}");
  expect(extracted.dynamicSegments).toEqual([2]);
  expect(extracted.unresolved).toEqual([]);
  expect(matchOperation(extracted, spec([byId], ["https://api.example.com/v1"]))).toEqual({ operation: byId });
});

it("keeps a static query beside a dynamic path segment", () => {
  const extracted = sourceCall(
    "test('a', async ({ request }) => { await request.get(`/orders/${orderId}?limit=1`) })",
  );

  expect(extracted.path).toBe("/orders/{}");
  expect(extracted.query).toEqual({ limit: "1" });
  expect(extracted.dynamicSegments).toEqual([1]);
  expect(extracted.unresolved).toEqual([]);
});

it("matches a fully literal template expression to the parameter template", () => {
  const extracted = sourceCall("test('a', async ({ request }) => { await request.get(`/orders/${'1'}`) })");
  const byId = operation("get", "/orders/{id}");

  expect(extracted.path).toBe("/orders/1");
  expect(extracted.dynamicSegments).toBeUndefined();
  expect(extracted.unresolved).toEqual([]);
  expect(matchOperation(extracted, spec([byId]))).toEqual({ operation: byId });
});

it("resolves a plus of string constants inside a template", () => {
  const extracted = sourceCall(
    [
      "const prefix = '/orders/';",
      "const id = '1';",
      "test('a', async ({ request }) => { await request.get(`${prefix + id}`) })",
    ].join("\n"),
  );
  const byId = operation("get", "/orders/{id}");

  expect(extracted.path).toBe("/orders/1");
  expect(extracted.unresolved).toEqual([]);
  expect(matchOperation(extracted, spec([byId]))).toEqual({ operation: byId });
});

it("leaves a template expression that shares its segment unresolved", () => {
  const extracted = sourceCall("test('a', async ({ request }) => { await request.get(`/orders/${orderId}-x`) })");

  expect(extracted.path).toBeUndefined();
  expect(extracted.dynamicSegments).toBeUndefined();
  expect(extracted.unresolved.map((item) => item.reason)).toEqual(["non-literal-url"]);
});

it("leaves an unresolved plus expression unresolved", () => {
  const extracted = sourceCall("test('a', async ({ request }) => { await request.get(`/orders/${a + b}`) })");

  expect(extracted.path).toBeUndefined();
  expect(extracted.unresolved.map((item) => item.reason)).toEqual(["non-literal-url"]);
});

it("leaves an imported segment unresolved", () => {
  const extracted = sourceCall(
    [
      "import { orderId } from './ids';",
      "test('a', async ({ request }) => { await request.get(`/orders/${orderId}`) })",
    ].join("\n"),
  );

  expect(extracted.path).toBeUndefined();
  expect(extracted.unresolved.map((item) => item.reason)).toEqual(["imported-value"]);
});

it("leaves a helper call that fills one segment unresolved", () => {
  const extracted = sourceCall(
    [
      "function buildUrl() { return '1'; }",
      "test('a', async ({ request }) => { await request.get(`/orders/${buildUrl()}`) })",
    ].join("\n"),
  );

  expect(extracted.path).toBeUndefined();
  expect(extracted.unresolved.map((item) => item.reason)).toEqual(["helper-call"]);
});
