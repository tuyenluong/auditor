import { expect, it } from "vitest";
import { extractCalls } from "../../src/playwright/extract.js";

function callOf(text: string) {
  return extractCalls({ path: "orders.spec.ts", text })[0];
}

it("resolves a same-file string const used as the path", () => {
  const call = callOf(
    ["const PATH = '/orders';", "test('a', async ({ request }) => { await request.get(PATH) })"].join("\n"),
  );

  expect(call?.method).toBe("get");
  expect(call?.path).toBe("/orders");
  expect(call?.unresolved).toEqual([]);
});

it("resolves a template path with a same-file const", () => {
  const call = callOf(
    ["const id = '1';", "test('a', async ({ request }) => { await request.get(`/orders/${id}`) })"].join("\n"),
  );

  expect(call?.path).toBe("/orders/1");
  expect(call?.unresolved).toEqual([]);
});

it("resolves shorthand properties from same-file consts", () => {
  const call = callOf(
    [
      "const sku = 'a';",
      "const qty = 1;",
      "test('a', async ({ request }) => { await request.post('/orders', { data: { sku, qty } }) })",
    ].join("\n"),
  );

  expect(call?.body).toEqual({ sku: "a", qty: 1 });
  expect(call?.unresolved).toEqual([]);
});

it("resolves a const passed to URLSearchParams", () => {
  const call = callOf(
    [
      "const params = { limit: '1' };",
      "test('a', async ({ request }) => { await request.get('/orders', { params: new URLSearchParams(params) }) })",
    ].join("\n"),
  );

  expect(call?.query).toEqual({ limit: "1" });
  expect(call?.unresolved).toEqual([]);
});

it("resolves a same-file object const used as the body", () => {
  const call = callOf(
    [
      "const body = { sku: 'a', qty: 1 };",
      "test('a', async ({ request }) => { await request.post('/orders', { data: body }) })",
    ].join("\n"),
  );

  expect(call?.method).toBe("post");
  expect(call?.path).toBe("/orders");
  expect(call?.body).toEqual({ sku: "a", qty: 1 });
  expect(call?.unresolved).toEqual([]);
});

it("resolves string concatenation in the path", () => {
  const call = callOf("test('a', async ({ request }) => { await request.get('/orders' + '/1') })");

  expect(call?.path).toBe("/orders/1");
  expect(call?.unresolved).toEqual([]);
});

it("records an imported binding as imported-value", () => {
  const call = callOf(
    [
      "import { PATH } from './paths';",
      "test('a', async ({ request }) => { await request.get(PATH) })",
    ].join("\n"),
  );

  expect(call?.method).toBe("get");
  expect(call?.path).toBeUndefined();
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["imported-value"]);
});

it("records a let assigned twice as ambiguous-constant", () => {
  const moduleLet = callOf(
    [
      "let path = '/orders';",
      "path = '/other';",
      "test('a', async ({ request }) => { await request.get(path) })",
    ].join("\n"),
  );
  const localLet = callOf(
    [
      "test('a', async ({ request }) => {",
      "  let path = '/orders';",
      "  path = '/other';",
      "  await request.get(path);",
      "})",
    ].join("\n"),
  );

  expect(moduleLet?.path).toBeUndefined();
  expect(moduleLet?.unresolved.map((item) => item.reason)).toEqual(["ambiguous-constant"]);
  expect(localLet?.path).toBeUndefined();
  expect(localLet?.unresolved.map((item) => item.reason)).toEqual(["ambiguous-constant"]);
});

it("resolves a let whose only write is after the declaration", () => {
  const call = callOf(
    [
      "let path;",
      "path = '/orders';",
      "test('a', async ({ request }) => { await request.get(path) })",
    ].join("\n"),
  );

  expect(call?.path).toBe("/orders");
  expect(call?.unresolved).toEqual([]);
});

it("records an object spread as spread", () => {
  const call = callOf(
    [
      "const extra = { qty: 1 };",
      "const body = { sku: 'a', ...extra };",
      "test('a', async ({ request }) => { await request.post('/orders', { data: body }) })",
    ].join("\n"),
  );

  expect(call?.body).toEqual({ unresolved: "spread" });
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["spread"]);
});

it("records a const cycle as ambiguous-constant", () => {
  const call = callOf(
    [
      "const left = right;",
      "const right = left;",
      "test('a', async ({ request }) => { await request.get(left) })",
    ].join("\n"),
  );

  expect(call?.path).toBeUndefined();
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["ambiguous-constant"]);
});

it("resolves a let with a single assignment", () => {
  const call = callOf(
    ["let path = '/orders';", "test('a', async ({ request }) => { await request.get(path) })"].join("\n"),
  );

  expect(call?.path).toBe("/orders");
  expect(call?.unresolved).toEqual([]);
});

it("resolves as const and satisfies", () => {
  const call = callOf(
    [
      "const path = '/orders' as const;",
      "const id = '1' satisfies string;",
      "test('a', async ({ request }) => { await request.get(`${path}/${id}`) })",
    ].join("\n"),
  );

  expect(call?.path).toBe("/orders/1");
  expect(call?.unresolved).toEqual([]);
});

it("resolves a chain of ten constants and rejects the eleventh", () => {
  const source = (length: number) => {
    const lines = [`const c${length} = '/orders';`];
    for (let index = length - 1; index >= 1; index -= 1) lines.push(`const c${index} = c${index + 1};`);
    lines.push("test('a', async ({ request }) => { await request.get(c1) });");
    return lines.join("\n");
  };

  expect(callOf(source(10))?.path).toBe("/orders");
  expect(callOf(source(10))?.unresolved).toEqual([]);
  expect(callOf(source(11))?.path).toBeUndefined();
  expect(callOf(source(11))?.unresolved.map((item) => item.reason)).toEqual(["ambiguous-constant"]);
});

it("does not let a block-scoped const escape its block", () => {
  const call = callOf(
    [
      "const id = '1';",
      "test('a', async ({ request }) => {",
      "  { const id = '2'; }",
      "  await request.get(`/orders/${id}`);",
      "})",
    ].join("\n"),
  );

  expect(call?.path).toBe("/orders/1");
  expect(call?.unresolved).toEqual([]);
});

it("uses the inner const when a name is shadowed", () => {
  const call = callOf(
    [
      "const id = '1';",
      "test('a', async ({ request }) => {",
      "  const id = '2';",
      "  await request.get(`/orders/${id}`);",
      "})",
    ].join("\n"),
  );

  expect(call?.path).toBe("/orders/2");
  expect(call?.unresolved).toEqual([]);
});

it("does not resolve a parameter that shadows a const", () => {
  const call = callOf(
    [
      "test('a', async ({ request }) => {",
      "  const path = '/orders';",
      "  const send = (path: string) => request.get(path);",
      "  send('/nope');",
      "})",
    ].join("\n"),
  );

  expect(call?.path).toBeUndefined();
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["non-literal-url"]);
});

it("resolves a same-file string const used as the fetch method", () => {
  const call = callOf(
    [
      "const method = 'HEAD';",
      "test('a', async ({ request }) => { await request.fetch('/orders', { method }) })",
    ].join("\n"),
  );

  expect(call?.method).toBe("head");
  expect(call?.path).toBe("/orders");
  expect(call?.unresolved).toEqual([]);
});

it("resolves a const params object and shorthand values", () => {
  const text = [
    "const params = { limit: 1 };",
    "const foo = '2';",
    "test('a', async ({ request }) => {",
    "  await request.get('/orders?bar=3', { params });",
    "  await request.get('/orders', { params: { foo } });",
    "})",
  ].join("\n");
  const found = extractCalls({ path: "orders.spec.ts", text });

  expect(found.map((call) => call.query)).toEqual([{ bar: "3", limit: 1 }, { foo: "2" }]);
  expect(found.every((call) => call.unresolved.length === 0)).toBe(true);
});

it("resolves literal boolean, null, and negative number bodies", () => {
  const call = callOf(
    "test('a', async ({ request }) => { await request.post('/orders', { data: { ok: true, note: null, qty: -1 } }) })",
  );

  expect(call?.body).toEqual({ ok: true, note: null, qty: -1 });
  expect(call?.unresolved).toEqual([]);
});

it("records a ternary as ambiguous-constant", () => {
  const call = callOf(
    "test('a', async ({ request }) => { await request.get(flag ? '/orders' : '/nope') })",
  );

  expect(call?.path).toBeUndefined();
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["ambiguous-constant"]);
});

it("records a helper call reached through a const", () => {
  const call = callOf(
    [
      "function buildUrl() { return '/orders'; }",
      "const path = buildUrl();",
      "test('a', async ({ request }) => { await request.get(path) })",
    ].join("\n"),
  );

  expect(call?.path).toBeUndefined();
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["helper-call"]);
});

it("records a computed key as computed-key", () => {
  const call = callOf(
    "test('a', async ({ request }) => { await request.post('/orders', { data: { ['sku']: 'a' } }) })",
  );

  expect(call?.body).toEqual({ unresolved: "computed-key" });
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["computed-key"]);
});

it("resolves an options object const", () => {
  const call = callOf(
    [
      "const options = { method: 'HEAD', data: { sku: 'a' } };",
      "test('a', async ({ request }) => { await request.fetch('/orders', options) })",
    ].join("\n"),
  );

  expect(call?.method).toBe("head");
  expect(call?.body).toEqual({ sku: "a" });
  expect(call?.unresolved).toEqual([]);
});
