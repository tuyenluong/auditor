import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { AuditorError } from "../errors.js";
import type { OpenApiDocument } from "./parse.js";

type SchemaObject = OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject;
type ReferenceObject = OpenAPIV3.ReferenceObject | OpenAPIV3_1.ReferenceObject;
type ParameterObject = OpenAPIV3.ParameterObject;
type RequestBodyObject = OpenAPIV3.RequestBodyObject | OpenAPIV3_1.RequestBodyObject;
type ResponseObject = OpenAPIV3.ResponseObject | OpenAPIV3_1.ResponseObject;
type OperationObject = OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;
type PathItemObject = OpenAPIV3.PathItemObject | OpenAPIV3_1.PathItemObject;
type MediaTypeObject = OpenAPIV3.MediaTypeObject | OpenAPIV3_1.MediaTypeObject;

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options"
  | "trace";

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

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const satisfies readonly HttpMethod[];

const SCHEMA_TYPE_ORDER = ["string", "number", "integer", "boolean", "object", "array", "null"];

export function toSpecModel(
  doc: OpenApiDocument,
  source: { source: SpecModel["source"]; location: string },
): SpecModel {
  return {
    openapi: doc.openapi,
    title: doc.info.title,
    version: doc.info.version,
    source: source.source,
    location: source.location,
    operations: mapOperations("paths" in doc ? doc.paths : undefined),
    servers: mapServers(doc.servers),
  };
}

function mapOperations(paths: OpenApiDocument["paths"]): SpecOperation[] {
  const operations: SpecOperation[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(paths ?? {})) {
    if (pathItem === undefined) continue;
    const item = deref<PathItemObject>(pathItem);
    const pathParameters = mapParameterList(item.parameters);
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      operations.push(mapOperation(method, pathTemplate, pathParameters, operation));
    }
  }
  return operations;
}

function mapOperation(
  method: HttpMethod,
  pathTemplate: string,
  pathParameters: readonly SpecParameter[],
  operation: OperationObject,
): SpecOperation {
  const mapped: SpecOperation = {
    method,
    pathTemplate,
    parameters: mergeParameters(pathParameters, mapParameterList(operation.parameters)),
    responses: mapResponses(operation.responses),
  };
  if (operation.operationId !== undefined) mapped.operationId = operation.operationId;
  if (operation.requestBody !== undefined) {
    mapped.requestBody = mapRequestBody(deref(operation.requestBody));
  }
  return mapped;
}

function mergeParameters(
  pathParameters: readonly SpecParameter[],
  operationParameters: readonly SpecParameter[],
): SpecParameter[] {
  const merged = [...pathParameters];
  for (const parameter of operationParameters) {
    const index = merged.findIndex((item) => item.name === parameter.name && item.in === parameter.in);
    if (index === -1) merged.push(parameter);
    else merged[index] = parameter;
  }
  return merged;
}

function mapParameterList(parameters: ReadonlyArray<ReferenceObject | ParameterObject> | undefined): SpecParameter[] {
  if (parameters === undefined) return [];
  return parameters.map((parameter) => mapParameter(deref(parameter)));
}

function mapParameter(parameter: ParameterObject): SpecParameter {
  const mapped: SpecParameter = {
    name: parameter.name,
    in: parameter.in as SpecParameter["in"],
    // OpenAPI path parameters are required.
    required: parameter.in === "path" || parameter.required === true,
  };
  if (parameter.schema !== undefined) mapped.schema = mapSchema(deref(parameter.schema));
  return mapped;
}

function mapRequestBody(body: RequestBodyObject): NonNullable<SpecOperation["requestBody"]> {
  return {
    required: body.required === true,
    content: mapContent(body.content),
  };
}

function mapResponses(
  responses: OpenAPIV3.ResponsesObject | OpenAPIV3_1.ResponsesObject | undefined,
): SpecOperation["responses"] {
  const mapped: SpecOperation["responses"] = {};
  if (responses === undefined) return mapped;
  for (const [status, response] of Object.entries(responses)) {
    if (response === undefined) continue;
    mapped[status] = { content: mapContent(deref<ResponseObject>(response).content) };
  }
  return mapped;
}

function mapContent(content: Readonly<Record<string, MediaTypeObject>> | undefined): Record<string, JsonSchema> {
  if (content === undefined) return {};
  const mapped: Record<string, JsonSchema> = {};
  for (const [mediaType, entry] of Object.entries(content)) {
    mapped[mediaType] = entry.schema === undefined ? {} : mapSchema(deref(entry.schema));
  }
  return mapped;
}

function mapSchema(schema: SchemaObject): JsonSchema {
  const mapped = mapSchemaFields(schema);
  if (schema.allOf === undefined) return mapped;
  return schema.allOf.reduce(
    (current, member) => mergeSchemas(current, mapSchema(deref(member))),
    mapped,
  );
}

function mapSchemaFields(schema: SchemaObject): JsonSchema {
  const mapped: JsonSchema = {};
  if (schema.type !== undefined) mapped.type = schema.type;
  if (schema.enum !== undefined) mapped.enum = [...schema.enum];
  if (schema.properties !== undefined) mapped.properties = mapProperties(schema.properties);
  if (schema.required !== undefined) mapped.required = [...schema.required];
  if ("items" in schema && schema.items !== undefined) mapped.items = mapSchema(deref(schema.items));
  if (schema.additionalProperties !== undefined) {
    mapped.additionalProperties =
      typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : mapSchema(deref(schema.additionalProperties));
  }
  if (schema.oneOf !== undefined) mapped.oneOf = schema.oneOf.map((entry) => mapSchema(deref(entry)));
  if (schema.anyOf !== undefined) mapped.anyOf = schema.anyOf.map((entry) => mapSchema(deref(entry)));
  if ("nullable" in schema && schema.nullable !== undefined) mapped.nullable = schema.nullable;
  if (schema.format !== undefined) mapped.format = schema.format;
  return mapped;
}

function mapProperties(properties: Readonly<Record<string, ReferenceObject | SchemaObject>>): Record<string, JsonSchema> {
  const mapped: Record<string, JsonSchema> = {};
  for (const [name, property] of Object.entries(properties)) {
    mapped[name] = mapSchema(deref(property));
  }
  return mapped;
}

function deref<T>(value: T | ReferenceObject): T {
  return value as T;
}

function mergeSchemas(left: JsonSchema, right: JsonSchema): JsonSchema {
  const merged: JsonSchema = {};
  const type = intersectTypes(left.type, right.type);
  if (type !== undefined) merged.type = type;
  const values = mergeEnum(left.enum, right.enum);
  if (values !== undefined) merged.enum = values;
  const properties = mergeProperties(left.properties, right.properties);
  if (properties !== undefined) merged.properties = properties;
  const required = unionRequired(left.required, right.required);
  if (required !== undefined) merged.required = required;
  const items = mergeItems(left.items, right.items);
  if (items !== undefined) merged.items = items;
  const additionalProperties = mergeAdditional(left.additionalProperties, right.additionalProperties);
  if (additionalProperties !== undefined) merged.additionalProperties = additionalProperties;
  const oneOf = mergeBranches(left.oneOf, right.oneOf, "oneOf");
  if (oneOf !== undefined) merged.oneOf = oneOf;
  const anyOf = mergeBranches(left.anyOf, right.anyOf, "anyOf");
  if (anyOf !== undefined) merged.anyOf = anyOf;
  if (left.nullable === true && right.nullable === true) merged.nullable = true;
  const format = mergeFormat(left.format, right.format);
  if (format !== undefined) merged.format = format;
  return merged;
}

function intersectTypes(
  left: string | string[] | undefined,
  right: string | string[] | undefined,
): string | string[] | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;

  const leftList = listTypes(left);
  const rightList = listTypes(right);
  const leftSet = expandNumbers(leftList);
  const rightSet = expandNumbers(rightList);
  const result: string[] = [];

  // integer is a subset of number, so the two intersect as integer.
  if (leftSet.has("integer") && rightSet.has("integer")) {
    result.push(leftList.includes("number") && rightList.includes("number") ? "number" : "integer");
  }
  for (const type of SCHEMA_TYPE_ORDER) {
    if (type === "number" || type === "integer") continue;
    if (leftSet.has(type) && rightSet.has(type)) result.push(type);
  }
  for (const type of leftSet) {
    if (!SCHEMA_TYPE_ORDER.includes(type) && rightSet.has(type)) result.push(type);
  }

  if (result.length === 0) {
    throw new AuditorError(
      `Conflicting allOf types: ${showType(left)} and ${showType(right)}`,
      "SPEC_INVALID",
    );
  }
  const [only] = result;
  return result.length === 1 && only !== undefined ? only : result;
}

function listTypes(type: string | string[]): string[] {
  return Array.isArray(type) ? type : [type];
}

function expandNumbers(types: readonly string[]): Set<string> {
  const set = new Set(types);
  if (set.has("number")) set.add("integer");
  return set;
}

function showType(type: string | string[]): string {
  return Array.isArray(type) ? type.join("|") : type;
}

function mergeEnum(left?: readonly unknown[], right?: readonly unknown[]): unknown[] | undefined {
  if (left === undefined) return right === undefined ? undefined : [...right];
  if (right === undefined) return [...left];
  const rightKeys = new Set(right.map((value) => JSON.stringify(value)));
  return left.filter((value) => rightKeys.has(JSON.stringify(value)));
}

function mergeProperties(
  left?: Readonly<Record<string, JsonSchema>>,
  right?: Readonly<Record<string, JsonSchema>>,
): Record<string, JsonSchema> | undefined {
  if (left === undefined) return right === undefined ? undefined : { ...right };
  if (right === undefined) return { ...left };
  // A property declared by only one member stays. Shared names intersect their schemas.
  const properties: Record<string, JsonSchema> = {};
  for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const leftSchema = left[name];
    const rightSchema = right[name];
    if (leftSchema !== undefined && rightSchema !== undefined) {
      properties[name] = mergeSchemas(leftSchema, rightSchema);
    } else if (leftSchema !== undefined) {
      properties[name] = leftSchema;
    } else if (rightSchema !== undefined) {
      properties[name] = rightSchema;
    }
  }
  return properties;
}

function unionRequired(left?: readonly string[], right?: readonly string[]): string[] | undefined {
  if (left === undefined && right === undefined) return undefined;
  const required: string[] = [];
  for (const name of [...(left ?? []), ...(right ?? [])]) {
    if (!required.includes(name)) required.push(name);
  }
  return required;
}

function mergeItems(left?: JsonSchema, right?: JsonSchema): JsonSchema | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return mergeSchemas(left, right);
}

function mergeAdditional(
  left: boolean | JsonSchema | undefined,
  right: boolean | JsonSchema | undefined,
): boolean | JsonSchema | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (left === false || right === false) return false;
  if (left === true) return right;
  if (right === true) return left;
  return mergeSchemas(left, right);
}

function mergeBranches(
  left: readonly JsonSchema[] | undefined,
  right: readonly JsonSchema[] | undefined,
  keyword: "oneOf" | "anyOf",
): JsonSchema[] | undefined {
  if (left === undefined) return right === undefined ? undefined : [...right];
  if (right === undefined) return [...left];
  throw new AuditorError(`Conflicting allOf composition: ${keyword}`, "SPEC_INVALID");
}

function mergeFormat(left?: string, right?: string): string | undefined {
  if (left === undefined) return right;
  if (right === undefined || left === right) return left;
  throw new AuditorError(`Conflicting allOf format: ${left} and ${right}`, "SPEC_INVALID");
}

function mapServers(servers: OpenApiDocument["servers"]): string[] {
  const urls: string[] = [];
  for (const server of servers ?? []) {
    if (typeof server.url === "string") urls.push(server.url);
  }
  return urls;
}
