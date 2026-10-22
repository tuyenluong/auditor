import { AuditorError } from "../errors.js";
import type { OpenApiDocument } from "./parse.js";

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

const PARAMETER_LOCATIONS = ["path", "query", "header", "cookie"] as const;

const SCHEMA_TYPE_ORDER = ["string", "number", "integer", "boolean", "object", "array", "null"];

export function toSpecModel(
  doc: OpenApiDocument,
  source: { source: SpecModel["source"]; location: string },
): SpecModel {
  const record = asRecord(doc, "document");
  if (typeof record.openapi !== "string") {
    throw new AuditorError("Invalid OpenAPI: missing openapi version", "SPEC_INVALID");
  }

  const model: SpecModel = {
    openapi: record.openapi,
    source: source.source,
    location: source.location,
    operations: mapOperations(record.paths),
    servers: mapServers(record.servers),
  };
  const info = isRecord(record.info) ? record.info : undefined;
  if (info !== undefined && typeof info.title === "string") model.title = info.title;
  if (info !== undefined && typeof info.version === "string") model.version = info.version;
  return model;
}

function mapOperations(paths: unknown): SpecOperation[] {
  if (paths === undefined) return [];
  const record = asRecord(paths, "paths");
  const operations: SpecOperation[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(record)) {
    if (pathItem === undefined) continue;
    const item = asRecord(pathItem, `path ${pathTemplate}`);
    const pathParameters = mapParameterList(item.parameters);
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      operations.push(
        mapOperation(
          method,
          pathTemplate,
          pathParameters,
          asRecord(operation, `${method.toUpperCase()} ${pathTemplate}`),
        ),
      );
    }
  }
  return operations;
}

function mapOperation(
  method: HttpMethod,
  pathTemplate: string,
  pathParameters: readonly SpecParameter[],
  operation: Record<string, unknown>,
): SpecOperation {
  const mapped: SpecOperation = {
    method,
    pathTemplate,
    parameters: mergeParameters(pathParameters, mapParameterList(operation.parameters)),
    responses: mapResponses(operation.responses),
  };
  if (typeof operation.operationId === "string") mapped.operationId = operation.operationId;
  if (operation.requestBody !== undefined) mapped.requestBody = mapRequestBody(operation.requestBody);
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

function mapParameterList(value: unknown): SpecParameter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AuditorError("Invalid OpenAPI: parameters are not an array", "SPEC_INVALID");
  }
  return value.map((parameter) => mapParameter(parameter));
}

function mapParameter(value: unknown): SpecParameter {
  const record = asRecord(value, "parameter");
  if (typeof record.name !== "string" || typeof record.in !== "string" || !isParameterLocation(record.in)) {
    throw new AuditorError("Invalid OpenAPI: parameter is missing name or in", "SPEC_INVALID");
  }
  const parameter: SpecParameter = {
    name: record.name,
    in: record.in,
    // OpenAPI path parameters are required.
    required: record.in === "path" || record.required === true,
  };
  if (record.schema !== undefined) parameter.schema = mapSchema(record.schema);
  return parameter;
}

function isParameterLocation(value: string): value is SpecParameter["in"] {
  return (PARAMETER_LOCATIONS as readonly string[]).includes(value);
}

function mapRequestBody(value: unknown): NonNullable<SpecOperation["requestBody"]> {
  const record = asRecord(value, "request body");
  return {
    required: record.required === true,
    content: mapContent(record.content),
  };
}

function mapResponses(value: unknown): SpecOperation["responses"] {
  if (value === undefined) return {};
  const record = asRecord(value, "responses");
  const responses: SpecOperation["responses"] = {};
  for (const [status, response] of Object.entries(record)) {
    const body = asRecord(response, `response ${status}`);
    responses[status] = { content: mapContent(body.content) };
  }
  return responses;
}

function mapContent(value: unknown): Record<string, JsonSchema> {
  if (value === undefined) return {};
  const record = asRecord(value, "content");
  const content: Record<string, JsonSchema> = {};
  for (const [mediaType, entry] of Object.entries(record)) {
    const media = asRecord(entry, `content ${mediaType}`);
    content[mediaType] = media.schema === undefined ? {} : mapSchema(media.schema);
  }
  return content;
}

function mapSchema(value: unknown): JsonSchema {
  const record = asRecord(value, "schema");
  const mapped = mapSchemaFields(record);
  if (record.allOf === undefined) return mapped;
  if (!Array.isArray(record.allOf)) {
    throw new AuditorError("Invalid OpenAPI: allOf is not an array", "SPEC_INVALID");
  }
  return record.allOf.reduce(
    (schema: JsonSchema, member: unknown) => mergeSchemas(schema, mapSchema(member)),
    mapped,
  );
}

function mapSchemaFields(schema: Record<string, unknown>): JsonSchema {
  const mapped: JsonSchema = {};
  if (schema.type !== undefined) mapped.type = readType(schema.type);
  if (schema.enum !== undefined) mapped.enum = readEnum(schema.enum);
  if (schema.properties !== undefined) mapped.properties = readProperties(schema.properties);
  if (schema.required !== undefined) mapped.required = readStringArray(schema.required, "required");
  if (schema.items !== undefined) mapped.items = mapSchema(schema.items);
  if (schema.additionalProperties !== undefined) {
    mapped.additionalProperties =
      typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : mapSchema(schema.additionalProperties);
  }
  if (schema.oneOf !== undefined) mapped.oneOf = readSchemaArray(schema.oneOf, "oneOf");
  if (schema.anyOf !== undefined) mapped.anyOf = readSchemaArray(schema.anyOf, "anyOf");
  if (schema.nullable !== undefined) mapped.nullable = readBoolean(schema.nullable, "nullable");
  if (schema.format !== undefined) mapped.format = readString(schema.format, "format");
  return mapped;
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

function mapServers(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AuditorError("Invalid OpenAPI: servers are not an array", "SPEC_INVALID");
  }
  const urls: string[] = [];
  for (const server of value) {
    if (isRecord(server) && typeof server.url === "string") urls.push(server.url);
  }
  return urls;
}

function readType(value: unknown): string | string[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length === 0) {
    throw new AuditorError("Invalid OpenAPI: schema type is not a string", "SPEC_INVALID");
  }
  const types: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new AuditorError("Invalid OpenAPI: schema type is not a string", "SPEC_INVALID");
    }
    types.push(item);
  }
  const [only] = types;
  return types.length === 1 && only !== undefined ? only : types;
}

function readEnum(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new AuditorError("Invalid OpenAPI: enum is not an array", "SPEC_INVALID");
  }
  return [...value];
}

function readProperties(value: unknown): Record<string, JsonSchema> {
  const record = asRecord(value, "properties");
  const properties: Record<string, JsonSchema> = {};
  for (const [name, property] of Object.entries(record)) {
    properties[name] = mapSchema(property);
  }
  return properties;
}

function readStringArray(value: unknown, keyword: string): string[] {
  if (!Array.isArray(value)) {
    throw new AuditorError(`Invalid OpenAPI: ${keyword} must be an array of strings`, "SPEC_INVALID");
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new AuditorError(`Invalid OpenAPI: ${keyword} must be an array of strings`, "SPEC_INVALID");
    }
    if (!names.includes(item)) names.push(item);
  }
  return names;
}

function readSchemaArray(value: unknown, keyword: string): JsonSchema[] {
  if (!Array.isArray(value)) {
    throw new AuditorError(`Invalid OpenAPI: ${keyword} is not an array`, "SPEC_INVALID");
  }
  return value.map((entry) => mapSchema(entry));
}

function readBoolean(value: unknown, keyword: string): boolean {
  if (typeof value !== "boolean") {
    throw new AuditorError(`Invalid OpenAPI: ${keyword} is not a boolean`, "SPEC_INVALID");
  }
  return value;
}

function readString(value: unknown, keyword: string): string {
  if (typeof value !== "string") {
    throw new AuditorError(`Invalid OpenAPI: ${keyword} is not a string`, "SPEC_INVALID");
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AuditorError(`Invalid OpenAPI: ${label} is not an object`, "SPEC_INVALID");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
