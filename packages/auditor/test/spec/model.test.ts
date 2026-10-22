import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AuditorError, type SpecModel, type SpecOperation } from "../../src/index.js";
import { toSpecModel } from "../../src/spec/model.js";
import { parseSpec, type OpenApiDocument } from "../../src/spec/parse.js";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return resolve(fixtureDir, name);
}

async function loadModel(name: string): Promise<SpecModel> {
  const location = fixture(name);
  return toSpecModel(await parseSpec(location), { source: "file", location });
}

function findOperation(
  model: SpecModel,
  method: SpecOperation["method"],
  pathTemplate: string,
): SpecOperation {
  const found = model.operations.find(
    (item) => item.method === method && item.pathTemplate === pathTemplate,
  );
  if (found === undefined) {
    throw new Error(`missing ${method} ${pathTemplate}`);
  }
  return found;
}

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

it("maps the orders contract to three operations", async () => {
  const location = fixture("orders.openapi.yaml");
  const model = await loadModel("orders.openapi.yaml");

  expect(model.openapi).toBe("3.0.3");
  expect(model.title).toBe("Orders API");
  expect(model.version).toBe("1.0.0");
  expect(model.source).toBe("file");
  expect(model.location).toBe(location);
  expect(model.servers).toEqual(["http://127.0.0.1:3000"]);
  expect(model.operations).toHaveLength(3);
  expect(
    model.operations.map((item) => `${item.method} ${item.pathTemplate}`).sort(),
  ).toEqual(["get /orders", "get /orders/{id}", "post /orders"]);
});

it("maps the POST /orders body as required sku and qty", async () => {
  const model = await loadModel("orders.openapi.yaml");
  const post = findOperation(model, "post", "/orders");

  expect(post.requestBody?.required).toBe(true);
  expect(post.requestBody?.content["application/json"]?.required).toEqual(["sku", "qty"]);
});

it("maps GET /orders/{id} responses 200 and 404", async () => {
  const model = await loadModel("orders.openapi.yaml");
  const get = findOperation(model, "get", "/orders/{id}");

  expect(Object.keys(get.responses).sort()).toEqual(["200", "404"]);
  expect(get.responses["404"]).toEqual({ content: {} });
  expect(get.responses["200"]?.content["application/json"]?.properties?.sku).toEqual({
    type: "string",
  });
});

it("maps GET /orders required query parameter limit", async () => {
  const model = await loadModel("orders.openapi.yaml");
  const list = findOperation(model, "get", "/orders");
  const limit = list.parameters.find((parameter) => parameter.name === "limit" && parameter.in === "query");

  expect(limit).toEqual({
    name: "limit",
    in: "query",
    required: true,
    schema: { type: "integer" },
  });
});

it("lets an operation parameter override a path parameter with the same name and in", async () => {
  const model = await loadModel("param-override.openapi.yaml");
  const get = findOperation(model, "get", "/items/{id}");

  expect(get.parameters.filter((parameter) => parameter.name === "limit" && parameter.in === "query")).toEqual([
    { name: "limit", in: "query", required: true, schema: { type: "integer" } },
  ]);
  expect(get.parameters).toContainEqual({
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string" },
  });
  expect(get.parameters).toContainEqual({
    name: "id",
    in: "query",
    required: false,
    schema: { type: "string" },
  });
  expect(get.parameters).toContainEqual({
    name: "q",
    in: "query",
    required: false,
    schema: { type: "string" },
  });
  expect(get.parameters).toHaveLength(4);
});

it("merges allOf required fields and property schemas", async () => {
  const model = await loadModel("allof-merge.openapi.yaml");
  const post = findOperation(model, "post", "/items");

  expect(post.requestBody?.content["application/json"]).toEqual({
    type: "object",
    required: ["sku", "qty"],
    properties: {
      sku: { type: "string" },
      qty: { type: "integer" },
      note: { type: "string" },
    },
  });
});

it("throws SPEC_INVALID when allOf types conflict", async () => {
  const location = fixture("allof-conflict.openapi.yaml");
  const doc = await parseSpec(location);
  let error: unknown;
  try {
    toSpecModel(doc, { source: "file", location });
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(AuditorError);
  if (!(error instanceof AuditorError)) return;
  expect(error.code).toBe("SPEC_INVALID");
  expect(error.message).toContain("string");
  expect(error.message).toContain("integer");
});

it("keeps oneOf and anyOf branches", async () => {
  const model = await loadModel("oneof.openapi.yaml");
  const post = findOperation(model, "post", "/items");
  const put = findOperation(model, "put", "/items");

  expect(post.requestBody?.content["application/json"]).toEqual({
    oneOf: [
      {
        type: "object",
        properties: { sku: { type: "string" } },
        required: ["sku"],
      },
      {
        type: "object",
        properties: { qty: { type: "integer" } },
        required: ["qty"],
      },
    ],
  });
  expect(put.requestBody?.content["application/json"]).toEqual({
    anyOf: [
      {
        type: "object",
        properties: { sku: { type: "string" } },
        required: ["sku"],
      },
      {
        type: "object",
        properties: { id: { type: "string" } },
      },
    ],
  });
});

it("ignores server urls that are not strings", () => {
  const doc = {
    openapi: "3.0.3",
    info: { title: "Servers", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }, { url: 12 }, { url: null }, { description: "missing url" }],
    paths: {},
  } as OpenApiDocument;

  const model = toSpecModel(doc, { source: "pinned", location: "servers.yaml" });

  expect(model.source).toBe("pinned");
  expect(model.location).toBe("servers.yaml");
  expect(model.servers).toEqual(["https://api.example.com"]);
});
