import { expect, it } from "vitest";
import { extractCalls } from "../../src/playwright/extract.js";

function at(text: string, needle: string): { line: number; column: number } {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`missing ${needle}`);
  let line = 1;
  let column = 1;
  for (const char of text.slice(0, offset)) {
    if (char === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

it("extracts a literal post with its call line", () => {
  const text = [
    "test('a', async ({ request }) => {",
    "  await request.post('/orders', { data: { sku: 'a' } })",
    "})",
  ].join("\n");
  const position = at(text, "request.post");

  expect(extractCalls({ path: "orders.spec.ts", text })).toEqual([
    {
      file: "orders.spec.ts",
      line: position.line,
      column: position.column,
      callee: "request.post",
      method: "post",
      path: "/orders",
      pathParams: {},
      query: {},
      headers: {},
      body: { sku: "a" },
      expectations: [],
      unresolved: [],
    },
  ]);
});

it("follows a renamed request fixture", () => {
  const text = "test('a', async ({ request: api }) => { await api.get('/orders') })";
  const position = at(text, "api.get");

  expect(extractCalls({ path: "orders.spec.ts", text })).toEqual([
    {
      file: "orders.spec.ts",
      line: position.line,
      column: position.column,
      callee: "api.get",
      method: "get",
      path: "/orders",
      pathParams: {},
      query: {},
      headers: {},
      expectations: [],
      unresolved: [],
    },
  ]);
});

it("reads delete from request.newContext", () => {
  const text =
    "import { request } from '@playwright/test'; const ctx = await request.newContext(); await ctx.delete('/orders/1')";
  const position = at(text, "ctx.delete");

  expect(extractCalls({ path: "orders.spec.ts", text })).toEqual([
    {
      file: "orders.spec.ts",
      line: position.line,
      column: position.column,
      callee: "ctx.delete",
      method: "delete",
      path: "/orders/1",
      pathParams: {},
      query: {},
      headers: {},
      expectations: [],
      unresolved: [
        {
          file: "orders.spec.ts",
          line: position.line,
          column: position.column,
          callee: "ctx.delete",
          reason: "outside-test",
        },
      ],
    },
  ]);
});

it("reads a literal fetch method", () => {
  const text = "test('a', async ({ request }) => { await request.fetch('/orders', { method: 'HEAD' }) })";
  const position = at(text, "request.fetch");

  expect(extractCalls({ path: "orders.spec.ts", text })).toEqual([
    {
      file: "orders.spec.ts",
      line: position.line,
      column: position.column,
      callee: "request.fetch",
      method: "head",
      path: "/orders",
      pathParams: {},
      query: {},
      headers: {},
      expectations: [],
      unresolved: [],
    },
  ]);
});

it("defaults fetch without a method to get", () => {
  const text = "test('a', async ({ request }) => { await request.fetch('/orders') })";

  expect(extractCalls({ path: "orders.spec.ts", text })[0]).toMatchObject({
    method: "get",
    path: "/orders",
    callee: "request.fetch",
    expectations: [],
    unresolved: [],
  });
});

it("records a non-literal fetch method", () => {
  const text = "test('a', async ({ request }) => { await request.fetch('/orders', { method: variable }) })";
  const position = at(text, "request.fetch");

  expect(extractCalls({ path: "orders.spec.ts", text })).toEqual([
    {
      file: "orders.spec.ts",
      line: position.line,
      column: position.column,
      callee: "request.fetch",
      path: "/orders",
      pathParams: {},
      query: {},
      headers: {},
      expectations: [],
      unresolved: [
        {
          file: "orders.spec.ts",
          line: position.line,
          column: position.column,
          callee: "request.fetch",
          reason: "non-literal-method",
        },
      ],
    },
  ]);
});

it("records a helper call used as the url", () => {
  const text = [
    "function buildUrl() { return '/orders'; }",
    "test('a', async ({ request }) => { await request.post(buildUrl()) })",
  ].join("\n");
  const position = at(text, "request.post");

  expect(extractCalls({ path: "orders.spec.ts", text })).toEqual([
    {
      file: "orders.spec.ts",
      line: position.line,
      column: position.column,
      callee: "request.post",
      method: "post",
      pathParams: {},
      query: {},
      headers: {},
      expectations: [],
      unresolved: [
        {
          file: "orders.spec.ts",
          line: position.line,
          column: position.column,
          callee: "request.post",
          reason: "helper-call",
        },
      ],
    },
  ]);
});

it("records a form body", () => {
  const text = "test('a', async ({ request }) => { await request.post('/orders', { data: formData, form: formData }) })";
  const call = extractCalls({ path: "orders.spec.ts", text })[0];

  expect(call?.method).toBe("post");
  expect(call?.path).toBe("/orders");
  expect(call?.body).toEqual({ unresolved: "form-body" });
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["form-body"]);
});

it("records a raw string body", () => {
  const text = `test('a', async ({ request }) => { await request.post('/orders', { data: '{"a":1}' }) })`;
  const call = extractCalls({ path: "orders.spec.ts", text })[0];

  expect(call?.body).toEqual({ unresolved: "raw-string-body" });
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["raw-string-body"]);
  expect(call?.method).toBe("post");
  expect(call?.path).toBe("/orders");
});

it("records a module-scope call as outside-test", () => {
  const text = [
    "import { request } from '@playwright/test';",
    "const ctx = await request.newContext();",
    "await ctx.post('/orders');",
  ].join("\n");
  const call = extractCalls({ path: "orders.spec.ts", text })[0];

  expect(call?.method).toBe("post");
  expect(call?.path).toBe("/orders");
  expect(call?.callee).toBe("ctx.post");
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["outside-test"]);
});

it("merges params and the url query", () => {
  const text = "test('a', async ({ request }) => { await request.get('/orders?foo=2', { params: { limit: 1 } }) })";
  const call = extractCalls({ path: "orders.spec.js", text })[0];

  expect(call?.method).toBe("get");
  expect(call?.path).toBe("/orders");
  expect(call?.query).toEqual({ foo: "2", limit: 1 });
  expect(call?.unresolved).toEqual([]);
});

it("does not parse jsx files", () => {
  const text = "test('a', async ({ request }) => { await request.post('/orders') })";

  expect(extractCalls({ path: "page.tsx", text })).toEqual([]);
  expect(extractCalls({ path: "page.jsx", text })).toEqual([]);
});

it("parses typescript and javascript extensions", () => {
  const text = "test('a', async ({ request }) => { await request.get('/orders') })";

  for (const path of ["a.ts", "a.mts", "a.cts", "a.js", "a.mjs", "a.cjs"]) {
    expect(extractCalls({ path, text }).map((call) => call.method)).toEqual(["get"]);
  }
});

it.each(["only", "skip", "fixme"])("reads a request fixture from test.%s", (modifier) => {
  const text = `test.${modifier}('a', async ({ request }) => { await request.get('/health') })`;

  expect(extractCalls({ path: "health.spec.ts", text }).map((call) => call.method)).toEqual(["get"]);
});

it("follows a renamed request import", () => {
  const text = [
    "import { request as apiRequest, test } from '@playwright/test';",
    "test('a', async () => {",
    "  const ctx = await apiRequest.newContext();",
    "  await ctx.get('/orders');",
    "});",
  ].join("\n");

  expect(extractCalls({ path: "orders.spec.ts", text }).map((call) => call.method)).toEqual(["get"]);
});

it("follows a renamed playwright test import", () => {
  const text = [
    "import { test as check } from '@playwright/test';",
    "check('a', async ({ request }) => { await request.get('/orders') });",
  ].join("\n");

  expect(extractCalls({ path: "orders.spec.ts", text }).map((call) => call.callee)).toEqual(["request.get"]);
});

it("ignores the imported request until newContext", () => {
  const text = [
    "import { request, test } from '@playwright/test';",
    "test('a', async () => { await request.delete('/orders/1') });",
  ].join("\n");

  expect(extractCalls({ path: "orders.spec.ts", text })).toEqual([]);
});

it("ignores a test imported from another module", () => {
  const text = [
    "import { test } from './local';",
    "test('a', async ({ request }) => { await request.get('/orders') });",
  ].join("\n");

  expect(extractCalls({ path: "orders.spec.ts", text })).toEqual([]);
});

it("reads a params query string and URLSearchParams", () => {
  const text = [
    "test('a', async ({ request }) => {",
    "  await request.get('/orders', { params: 'limit=1&foo=2' });",
    "  await request.get('/orders', { params: new URLSearchParams({ limit: '1' }) });",
    "})",
  ].join("\n");
  const found = extractCalls({ path: "orders.spec.ts", text });

  expect(found.map((call) => call.query)).toEqual([{ limit: "1", foo: "2" }, { limit: "1" }]);
});

it("records a query key that disagrees with params", () => {
  const text = "test('a', async ({ request }) => { await request.get('/orders?limit=2', { params: { limit: 1 } }) })";
  const call = extractCalls({ path: "orders.spec.ts", text })[0];

  expect(call?.path).toBe("/orders");
  expect(call?.query).toEqual({ limit: { unresolved: "ambiguous-constant" } });
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["ambiguous-constant"]);
});

it("keeps a query key when params repeats its value", () => {
  const text = "test('a', async ({ request }) => { await request.get('/orders?foo=2', { params: { foo: '2' } }) })";
  const call = extractCalls({ path: "orders.spec.ts", text })[0];

  expect(call?.query).toEqual({ foo: "2" });
  expect(call?.unresolved).toEqual([]);
});

it("reads literal headers", () => {
  const text =
    "test('a', async ({ request }) => { await request.get('/orders', { headers: { accept: 'application/json' } }) })";

  expect(extractCalls({ path: "orders.spec.ts", text })[0]?.headers).toEqual({
    accept: "application/json",
  });
});

it("leaves expectations empty", () => {
  const text = [
    "test('a', async ({ request }) => {",
    "  const res = await request.get('/orders');",
    "  expect(res.status()).toBe(200);",
    "})",
  ].join("\n");

  expect(extractCalls({ path: "orders.spec.ts", text })[0]?.expectations).toEqual([]);
});

it("records multipart as a form body", () => {
  const text = "test('a', async ({ request }) => { await request.put('/orders', { multipart: formData }) })";
  const call = extractCalls({ path: "orders.spec.ts", text })[0];

  expect(call?.method).toBe("put");
  expect(call?.body).toEqual({ unresolved: "form-body" });
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["form-body"]);
});
