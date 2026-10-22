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
