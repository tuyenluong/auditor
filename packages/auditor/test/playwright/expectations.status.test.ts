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

function source(body: string): string {
  return ["test('a', async ({ request }) => {", body, "})"].join("\n");
}

function callOf(text: string) {
  return extractCalls({ path: "orders.spec.ts", text })[0];
}

it("records status 200 on that call at the expect line", () => {
  const text = source("  const res = await request.get('/orders/1');\n  expect(res.status()).toBe(200);");
  const position = at(text, "expect(res.status())");
  const call = callOf(text);

  expect(call?.line).toBe(at(text, "request.get").line);
  expect(call?.expectations).toEqual([
    {
      responseVar: "res",
      line: position.line,
      column: position.column,
      statuses: [200],
      contentTypes: [],
      fields: [],
      assertions: [],
    },
  ]);
  expect(call?.unresolved).toEqual([]);
});

it("records 2xx when expect(res.ok()).toBe(true)", () => {
  const text = source("  const res = await request.get('/orders/1');\n  expect(res.ok()).toBe(true);");
  const position = at(text, "expect(res.ok())");

  expect(callOf(text)?.expectations).toEqual([
    {
      responseVar: "res",
      line: position.line,
      column: position.column,
      statuses: ["2xx"],
      contentTypes: [],
      fields: [],
      assertions: [],
    },
  ]);
});

it("records 2xx for toEqual(true) and toBeTruthy", () => {
  for (const assertion of ["toEqual(true)", "toBeTruthy()"]) {
    const text = source(`  const res = await request.get('/orders/1');\n  expect(res.ok()).${assertion};`);
    expect(callOf(text)?.expectations[0]?.statuses).toEqual(["2xx"]);
    expect(callOf(text)?.unresolved).toEqual([]);
  }
});

it("records 2xx for a same-file boolean const", () => {
  const text = ["const OK = true;", source("  const res = await request.get('/orders/1');\n  expect(res.ok()).toBe(OK);")].join(
    "\n",
  );

  expect(callOf(text)?.expectations[0]?.statuses).toEqual(["2xx"]);
});

it("records negative-ok and no status when expect(res.ok()).toBe(false)", () => {
  const text = source("  const res = await request.get('/orders/1');\n  expect(res.ok()).toBe(false);");
  const position = at(text, "expect(res.ok())");
  const call = callOf(text);

  expect(call?.expectations).toEqual([]);
  expect(call?.unresolved).toEqual([
    {
      file: "orders.spec.ts",
      line: position.line,
      column: position.column,
      callee: "request.get",
      reason: "negative-ok",
    },
  ]);
});

it("records negative-ok for toBeFalsy and toEqual(false)", () => {
  for (const assertion of ["toBeFalsy()", "toEqual(false)"]) {
    const text = source(`  const res = await request.get('/orders/1');\n  expect(res.ok()).${assertion};`);
    const call = callOf(text);
    expect(call?.expectations).toEqual([]);
    expect(call?.unresolved.map((item) => item.reason)).toEqual(["negative-ok"]);
  }
});

it("records 201 when expect(res.status()).toBe(CREATED)", () => {
  const text = [
    "const CREATED = 201;",
    source("  const res = await request.get('/orders/1');\n  expect(res.status()).toBe(CREATED);"),
  ].join("\n");
  const position = at(text, "expect(res.status())");

  expect(callOf(text)?.expectations).toEqual([
    {
      responseVar: "res",
      line: position.line,
      column: position.column,
      statuses: [201],
      contentTypes: [],
      fields: [],
      assertions: [],
    },
  ]);
});

it("records a status passed to toEqual", () => {
  const text = source("  const res = await request.post('/orders');\n  expect(res.status()).toEqual(201);");

  expect(callOf(text)?.expectations[0]?.statuses).toEqual([201]);
  expect(callOf(text)?.method).toBe("post");
});

it("records status-range and no status for toBeGreaterThanOrEqual", () => {
  const text = source(
    "  const res = await request.get('/orders/1');\n  expect(res.status()).toBeGreaterThanOrEqual(200);",
  );
  const position = at(text, "expect(res.status())");
  const call = callOf(text);

  expect(call?.expectations).toEqual([]);
  expect(call?.unresolved).toEqual([
    {
      file: "orders.spec.ts",
      line: position.line,
      column: position.column,
      callee: "request.get",
      reason: "status-range",
    },
  ]);
});

it("records status-range for the other range matchers", () => {
  for (const matcher of ["toBeGreaterThan(199)", "toBeLessThan(300)", "toBeLessThanOrEqual(299)"]) {
    const text = source(`  const res = await request.get('/orders/1');\n  expect(res.status()).${matcher};`);
    const call = callOf(text);
    expect(call?.expectations).toEqual([]);
    expect(call?.unresolved.map((item) => item.reason)).toEqual(["status-range"]);
  }
});

it("records reassigned-response and no expectations when res is assigned twice", () => {
  const text = source(
    [
      "  let res = await request.get('/orders/1');",
      "  res = await request.get('/orders/2');",
      "  expect(res.status()).toBe(200);",
    ].join("\n"),
  );
  const calls = extractCalls({ path: "orders.spec.ts", text });

  expect(calls.map((call) => [call.method, call.path])).toEqual([
    ["get", "/orders/1"],
    ["get", "/orders/2"],
  ]);
  expect(calls.map((call) => call.expectations)).toEqual([[], []]);
  expect(calls.map((call) => call.unresolved)).toEqual([
    [
      {
        file: "orders.spec.ts",
        line: calls[0]?.line,
        column: calls[0]?.column,
        callee: "request.get",
        reason: "reassigned-response",
      },
    ],
    [
      {
        file: "orders.spec.ts",
        line: calls[1]?.line,
        column: calls[1]?.column,
        callee: "request.get",
        reason: "reassigned-response",
      },
    ],
  ]);
});

it("records reassigned-response for a compound write to res", () => {
  const text = source(
    ["  let res;", "  res += await request.get('/orders/1');", "  expect(res.status()).toBe(200);"].join("\n"),
  );
  const call = callOf(text);

  expect(call?.path).toBe("/orders/1");
  expect(call?.expectations).toEqual([]);
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["reassigned-response"]);
});

it("collects an expect inside if (false)", () => {
  const text = source(
    [
      "  const res = await request.get('/orders/1');",
      "  if (false) {",
      "    expect(res.status()).toBe(200);",
      "  }",
    ].join("\n"),
  );
  const position = at(text, "expect(res.status())");

  expect(callOf(text)?.expectations).toEqual([
    {
      responseVar: "res",
      line: position.line,
      column: position.column,
      statuses: [200],
      contentTypes: [],
      fields: [],
      assertions: [],
    },
  ]);
});

it("links a response assigned without await", () => {
  const text = source("  const res = request.get('/orders/1');\n  expect(res.status()).toBe(200);");

  expect(callOf(text)?.expectations[0]?.statuses).toEqual([200]);
});

it("links the single assignment of a bare let", () => {
  const text = source(
    ["  let res;", "  res = await request.get('/orders/1');", "  expect(res.status()).toBe(204);"].join("\n"),
  );

  expect(callOf(text)?.expectations[0]?.statuses).toEqual([204]);
  expect(callOf(text)?.unresolved).toEqual([]);
});

it("links an expect inside test.step", () => {
  const text = source(
    [
      "  const res = await request.get('/orders/1');",
      "  await test.step('status', async () => {",
      "    expect(res.status()).toBe(200);",
      "  });",
    ].join("\n"),
  );

  expect(callOf(text)?.expectations[0]?.statuses).toEqual([200]);
  expect(callOf(text)?.expectations[0]?.responseVar).toBe("res");
});

it("keeps a status when the url is an unresolved helper", () => {
  const text = [
    "function buildUrl() { return '/orders/1'; }",
    source("  const res = await request.get(buildUrl());\n  expect(res.status()).toBe(200);"),
  ].join("\n");
  const call = callOf(text);

  expect(call?.expectations[0]?.statuses).toEqual([200]);
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["helper-call"]);
});

it("keeps expectations inside their own test callback", () => {
  const text = [
    "test('a', async ({ request }) => {",
    "  const res = await request.get('/orders/1');",
    "  expect(res.status()).toBe(200);",
    "});",
    "test('b', async ({ request }) => {",
    "  const res = await request.get('/orders/2');",
    "  expect(res.status()).toBe(404);",
    "});",
  ].join("\n");
  const calls = extractCalls({ path: "orders.spec.ts", text });

  expect(calls.map((call) => call.expectations[0]?.statuses)).toEqual([[200], [404]]);
});

it("links each expect to the response variable it names", () => {
  const text = source(
    [
      "  const first = await request.get('/orders/1');",
      "  const second = await request.get('/orders/2');",
      "  expect(second.status()).toBe(404);",
      "  expect(first.ok()).toBe(true);",
    ].join("\n"),
  );
  const calls = extractCalls({ path: "orders.spec.ts", text });

  expect(calls[0]?.expectations.map((item) => [item.responseVar, item.statuses])).toEqual([["first", ["2xx"]]]);
  expect(calls[1]?.expectations.map((item) => [item.responseVar, item.statuses])).toEqual([["second", [404]]]);
});

it("uses the binding in scope when res is shadowed", () => {
  const text = source(
    [
      "  const res = await request.get('/orders/1');",
      "  {",
      "    const res = await request.get('/orders/2');",
      "    expect(res.status()).toBe(404);",
      "  }",
      "  expect(res.status()).toBe(200);",
    ].join("\n"),
  );
  const calls = extractCalls({ path: "orders.spec.ts", text });

  expect(calls[0]?.expectations[0]?.statuses).toEqual([200]);
  expect(calls[1]?.expectations[0]?.statuses).toEqual([404]);
});

it("follows an expect imported from @playwright/test", () => {
  const text = [
    "import { expect, test } from '@playwright/test';",
    source("  const res = await request.get('/orders/1');\n  expect(res.status()).toBe(200);"),
  ].join("\n");

  expect(callOf(text)?.expectations[0]?.statuses).toEqual([200]);
});

it("follows a renamed expect import", () => {
  const text = [
    "import { expect as check } from '@playwright/test';",
    source("  const res = await request.get('/orders/1');\n  check(res.status()).toBe(201);"),
  ].join("\n");

  expect(callOf(text)?.expectations[0]?.statuses).toEqual([201]);
  expect(callOf(text)?.expectations[0]?.responseVar).toBe("res");
});

it("ignores an expect imported from another module", () => {
  const text = [
    "import { expect } from './local';",
    source("  const res = await request.get('/orders/1');\n  expect(res.status()).toBe(200);"),
  ].join("\n");

  expect(callOf(text)?.expectations).toEqual([]);
  expect(callOf(text)?.path).toBe("/orders/1");
});

it("ignores a local binding named expect", () => {
  const text = source(
    [
      "  const res = await request.get('/orders/1');",
      "  const expect = () => ({ toBe() {} });",
      "  expect(res.status()).toBe(200);",
    ].join("\n"),
  );

  expect(callOf(text)?.expectations).toEqual([]);
});

it("does not link a response declared outside the test", () => {
  const text = [
    "import { request } from '@playwright/test';",
    "const ctx = await request.newContext();",
    "const res = await ctx.get('/orders/1');",
    "test('a', async () => { expect(res.status()).toBe(200); });",
  ].join("\n");
  const call = callOf(text);

  expect(call?.expectations).toEqual([]);
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["outside-test"]);
});

it("records no status when the expected value is not an integer", () => {
  const unresolved = source("  const res = await request.get('/orders/1');\n  expect(res.status()).toBe(code);");
  const fraction = source("  const res = await request.get('/orders/1');\n  expect(res.status()).toBe(200.5);");

  expect(callOf(unresolved)?.expectations).toEqual([]);
  expect(callOf(unresolved)?.unresolved).toEqual([]);
  expect(callOf(fraction)?.expectations).toEqual([]);
  expect(callOf(fraction)?.unresolved).toEqual([]);
});

it("does not record a status from not.toBe", () => {
  const text = source("  const res = await request.get('/orders/1');\n  expect(res.status()).not.toBe(200);");

  expect(callOf(text)?.expectations).toEqual([]);
  expect(callOf(text)?.unresolved).toEqual([]);
});

it("ignores expect.poll", () => {
  const text = source(
    "  const res = await request.get('/orders/1');\n  await expect.poll(() => res.status()).toBe(200);",
  );

  expect(callOf(text)?.expectations).toEqual([]);
  expect(callOf(text)?.unresolved).toEqual([]);
});

it("reads the first expect argument when a message is present", () => {
  const text = source("  const res = await request.get('/orders/1');\n  expect(res.status(), 'created').toBe(201);");

  expect(callOf(text)?.expectations[0]?.statuses).toEqual([201]);
});

it("keeps a concrete status beside negative-ok from another expect", () => {
  const text = source(
    [
      "  const res = await request.get('/orders/1');",
      "  expect(res.status()).toBe(200);",
      "  expect(res.ok()).toBe(false);",
    ].join("\n"),
  );
  const call = callOf(text);

  expect(call?.expectations.map((item) => item.statuses)).toEqual([[200]]);
  expect(call?.unresolved.map((item) => item.reason)).toEqual(["negative-ok"]);
});

it("leaves fields, assertions, and content types empty", () => {
  const text = source(
    [
      "  const res = await request.get('/orders/1');",
      "  const body = await res.json();",
      "  body.id;",
      "  expect(res.headers()['content-type']).toBe('text/plain');",
      "  expect(res.status()).toBe(200);",
    ].join("\n"),
  );
  const expectation = callOf(text)?.expectations[0];

  expect(expectation?.statuses).toEqual([200]);
  expect(expectation?.contentTypes).toEqual([]);
  expect(expectation?.fields).toEqual([]);
  expect(expectation?.assertions).toEqual([]);
  expect(callOf(text)?.expectations).toHaveLength(1);
});
