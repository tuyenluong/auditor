import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { load } from "js-yaml";
import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { AuditorError } from "../errors.js";
import { fetchSpec } from "./fetch.js";

export type OpenApiDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

export interface ParseSpecOptions {
  allowHosts?: readonly string[];
  specAuthHeader?: string;
  pinned?: boolean;
}

interface RefFile {
  url: string;
  reference?: string;
}

export async function parseSpec(
  specPath: string,
  options?: ParseSpecOptions,
): Promise<OpenApiDocument>;
export async function parseSpec(
  bytes: Uint8Array,
  options?: ParseSpecOptions,
): Promise<OpenApiDocument>;
export async function parseSpec(
  spec: string | Uint8Array,
  options: ParseSpecOptions = {},
): Promise<OpenApiDocument> {
  if (typeof spec !== "string") {
    return parseDocument(new TextDecoder().decode(spec), undefined, options);
  }
  const absolute = await resolveSpecPath(spec);
  return parseDocument(await readFile(absolute, "utf8"), absolute, options);
}

async function parseDocument(
  text: string,
  filePath: string | undefined,
  options: ParseSpecOptions,
): Promise<OpenApiDocument> {
  const parsed = parseYaml(text);
  if (!isOpenApi3(parsed)) {
    throw new AuditorError(
      `Expected OpenAPI 3.x, found ${versionFound(parsed)}`,
      "SPEC_INVALID",
    );
  }

  const specDir = filePath === undefined ? undefined : path.dirname(filePath);
  const resolver = resolverOptions(specDir, options);
  try {
    const validated =
      filePath === undefined
        ? await SwaggerParser.validate(parsed, resolver)
        : await SwaggerParser.validate(filePath, parsed, resolver);
    return validated as OpenApiDocument;
  } catch (error) {
    throw parserError(error);
  }
}

async function resolveSpecPath(specPath: string): Promise<string> {
  try {
    return await realpath(path.resolve(specPath));
  } catch (error) {
    if (isEnoent(error)) {
      throw new AuditorError(`Spec file not found: ${specPath}`, "SPEC_NOT_FOUND");
    }
    throw error;
  }
}

function parseYaml(text: string): unknown {
  try {
    return load(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new AuditorError(`Spec is not valid YAML or JSON: ${message}`, "SPEC_INVALID");
  }
}

function resolverOptions(
  specDir: string | undefined,
  options: ParseSpecOptions,
): SwaggerParser.Options {
  return {
    parse: {
      text: false,
      binary: false,
    },
    resolve: {
      file: {
        order: 100,
        canRead: isLocalRef,
        read: (file: RefFile) => readContainedFile(specDir, file),
      },
      http: {
        order: 200,
        canRead: isHttpRef,
        read: (file: RefFile) => readAllowlistedUrl(options, file),
      },
    },
  };
}

function isLocalRef(file: RefFile): boolean {
  return file.url.startsWith("file://") || !/^[a-z][a-z0-9+.-]*:/i.test(file.url);
}

function isHttpRef(file: RefFile): boolean {
  return /^https?:\/\//i.test(file.url);
}

async function readContainedFile(specDir: string | undefined, file: RefFile): Promise<Buffer> {
  if (specDir === undefined) {
    throw new AuditorError(
      `Relative $ref ${refLabel(file)} cannot be resolved without a spec file path`,
      "SPEC_INVALID",
    );
  }
  const candidate = await nearestRealPath(toFilePath(file.url));
  if (!isInside(specDir, candidate)) {
    throw new AuditorError(
      `Relative $ref escapes the spec directory: ${refLabel(file)}`,
      "SPEC_INVALID",
    );
  }
  return readFile(candidate);
}

async function readAllowlistedUrl(options: ParseSpecOptions, file: RefFile): Promise<Buffer> {
  if (options.pinned === true) {
    throw new AuditorError(`Pinned spec has a remote $ref: ${file.url}`, "SPEC_PIN");
  }
  const ref = refLabel(file);
  try {
    const fetched = await fetchSpec(file.url, options);
    return Buffer.from(fetched.bytes);
  } catch (error) {
    throw refFetchError(ref, error, options.specAuthHeader);
  }
}

function refFetchError(
  ref: string,
  error: unknown,
  specAuthHeader: string | undefined,
): AuditorError {
  const detail = withoutAuthHeader(
    error instanceof Error ? error.message : "unknown error",
    specAuthHeader,
  );
  if (
    error instanceof AuditorError &&
    error.code === "SPEC_FETCH" &&
    detail.includes("not allowlisted")
  ) {
    return new AuditorError(`External $ref ${ref} is not allowlisted`, "SPEC_INVALID");
  }
  return new AuditorError(`Invalid OpenAPI: failed to read $ref ${ref}: ${detail}`, "SPEC_INVALID");
}

function withoutAuthHeader(message: string, specAuthHeader: string | undefined): string {
  if (specAuthHeader === undefined || specAuthHeader.length === 0) {
    return message;
  }
  return message.replaceAll(specAuthHeader, "[redacted]");
}

function refLabel(file: RefFile): string {
  return typeof file.reference === "string" && file.reference.length > 0
    ? file.reference
    : file.url;
}

function toFilePath(fileUrl: string): string {
  return fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
}

async function nearestRealPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isOpenApi3(doc: unknown): doc is OpenApiDocument {
  return isRecord(doc) && typeof doc.openapi === "string" && doc.openapi.startsWith("3.");
}

function versionFound(doc: unknown): string {
  if (!isRecord(doc)) {
    return "undefined";
  }
  if ("openapi" in doc) {
    return formatVersion(doc.openapi);
  }
  if ("swagger" in doc) {
    return formatVersion(doc.swagger);
  }
  return "undefined";
}

function formatVersion(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return value === undefined ? "undefined" : String(value);
}

function parserError(error: unknown): AuditorError {
  const seen = new Set<unknown>();
  let unmatched: Error | undefined;
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AuditorError) {
      return current;
    }
    if (!unmatched && isUnmatchedResolver(current)) {
      unmatched = current;
    }
    const record = current as { cause?: unknown; error?: unknown };
    current = record.cause ?? record.error;
  }
  if (unmatched) {
    const source =
      "source" in unmatched && typeof unmatched.source === "string"
        ? unmatched.source
        : unmatched.message;
    return new AuditorError(`External $ref ${source} is not allowlisted`, "SPEC_INVALID");
  }
  return new AuditorError(`Invalid OpenAPI: ${firstErrorText(error)}`, "SPEC_INVALID");
}

function isUnmatchedResolver(error: object): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  return error.name === "UnmatchedResolverError" || code === "EUNMATCHEDRESOLVER";
}

function firstErrorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown error";
  }
  const details = (error as { details?: unknown }).details;
  const first = Array.isArray(details) ? details[0] : undefined;
  if (isRecord(first) && typeof first.message === "string") {
    const instancePath =
      typeof first.instancePath === "string" && first.instancePath.length > 0
        ? first.instancePath
        : "/";
    return `${instancePath} ${first.message}`;
  }
  return error.message.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
