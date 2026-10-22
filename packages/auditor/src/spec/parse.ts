import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { AuditorError } from "../errors.js";

export type OpenApiDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

export interface ParseSpecOptions {
  allowHosts?: readonly string[];
  specAuthHeader?: string;
}

interface RefFile {
  url: string;
  reference?: string;
}

/**
 * `SwaggerParser.parse` accepts Swagger 2.0 and rejects other non-OpenAPI
 * documents with its own wording. The parent parse returns the document so
 * Auditor can apply the OpenAPI 3.x check first.
 */
type UntypedParse = (
  this: SwaggerParser,
  schema: string,
  parserOptions: SwaggerParser.Options,
) => Promise<unknown>;

export async function parseSpec(
  specPath: string,
  options: ParseSpecOptions = {},
): Promise<OpenApiDocument> {
  const absolute = await resolveSpecPath(specPath);
  const specDir = path.dirname(absolute);
  const parserOptions = createParserOptions(specDir, options);
  const parsed = await parseDocument(absolute, parserOptions);

  if (!isOpenApi3(parsed)) {
    throw new AuditorError(
      `Expected OpenAPI 3.x, found ${versionFound(parsed)}`,
      "SPEC_INVALID",
    );
  }

  try {
    const dereferenced = await SwaggerParser.validate(absolute, parserOptions);
    if (!isOpenApi3(dereferenced)) {
      throw new AuditorError(
        `Expected OpenAPI 3.x, found ${versionFound(dereferenced)}`,
        "SPEC_INVALID",
      );
    }
    return dereferenced;
  } catch (error) {
    if (error instanceof AuditorError) {
      throw error;
    }
    throw asSpecError(error) ?? invalidOpenApi(error);
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

async function parseDocument(
  absolute: string,
  parserOptions: SwaggerParser.Options,
): Promise<unknown> {
  const parse = (Object.getPrototypeOf(SwaggerParser.prototype) as { parse?: UntypedParse })
    .parse;
  if (typeof parse !== "function") {
    throw new Error("OpenAPI parser is missing parse");
  }

  try {
    return await parse.call(new SwaggerParser(), absolute, parserOptions);
  } catch (error) {
    throw asSpecError(error) ?? error;
  }
}

function createParserOptions(
  specDir: string,
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
  if (file.url.startsWith("file://")) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(file.url);
}

function isHttpRef(file: RefFile): boolean {
  return /^https?:\/\//i.test(file.url);
}

async function readContainedFile(specDir: string, file: RefFile): Promise<Buffer> {
  const candidate = await nearestRealPath(toFilePath(file.url));
  if (!isInside(specDir, candidate)) {
    throw new AuditorError(
      `Relative $ref escapes the spec directory: ${refLabel(file)}`,
      "SPEC_INVALID",
    );
  }
  return readFile(candidate);
}

async function readAllowlistedUrl(
  options: ParseSpecOptions,
  file: RefFile,
): Promise<Buffer> {
  const ref = refLabel(file);
  let hostname: string;
  try {
    hostname = new URL(file.url).hostname;
  } catch {
    throw new AuditorError(`External $ref ${ref} is not allowlisted`, "SPEC_INVALID");
  }

  if (!isHostAllowed(hostname, options.allowHosts)) {
    throw new AuditorError(`External $ref ${ref} is not allowlisted`, "SPEC_INVALID");
  }

  const headers = new Headers();
  if (options.specAuthHeader !== undefined) {
    headers.set("Authorization", options.specAuthHeader);
  }

  const response = await fetch(file.url, { headers, redirect: "manual" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuditorError(
      `Invalid OpenAPI: failed to read $ref ${ref}: HTTP ${response.status}`,
      "SPEC_INVALID",
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function refLabel(file: RefFile): string {
  if (typeof file.reference === "string" && file.reference.length > 0) {
    return file.reference;
  }
  return file.url;
}

function toFilePath(fileUrl: string): string {
  if (fileUrl.startsWith("file://")) {
    return fileURLToPath(fileUrl);
  }
  return fileUrl;
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
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isHostAllowed(
  hostname: string,
  allowHosts: readonly string[] | undefined,
): boolean {
  const host = hostname.toLowerCase();
  return (allowHosts ?? []).some((entry) => hostEntry(entry) === host);
}

function hostEntry(entry: string): string {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end !== -1) {
      return trimmed.slice(1, end);
    }
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
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
  if (value === undefined) {
    return "undefined";
  }
  return String(value);
}

function asSpecError(error: unknown): AuditorError | undefined {
  const auditor = findAuditorError(error);
  if (auditor) {
    return auditor;
  }
  const syntax = findNamedError(error, ["ParserError", "UnmatchedParserError"], [
    "EPARSER",
    "EUNMATCHEDPARSER",
  ]);
  if (syntax) {
    return new AuditorError(
      `Spec is not valid YAML or JSON: ${syntax.message}`,
      "SPEC_INVALID",
    );
  }
  if (findMessage(error, "is not a valid JSON Schema")) {
    return new AuditorError("Expected OpenAPI 3.x, found undefined", "SPEC_INVALID");
  }
  const unmatched = findNamedError(error, ["UnmatchedResolverError"], ["EUNMATCHEDRESOLVER"]);
  if (unmatched) {
    const source =
      "source" in unmatched && typeof unmatched.source === "string"
        ? unmatched.source
        : unmatched.message;
    return new AuditorError(`External $ref ${source} is not allowlisted`, "SPEC_INVALID");
  }
  return undefined;
}

function invalidOpenApi(error: unknown): AuditorError {
  return new AuditorError(`Invalid OpenAPI: ${firstErrorText(error)}`, "SPEC_INVALID");
}

function firstErrorText(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as { details?: unknown }).details;
    if (Array.isArray(details)) {
      const first: unknown = details[0];
      if (isRecord(first) && typeof first.message === "string") {
        const instancePath =
          typeof first.instancePath === "string" && first.instancePath.length > 0
            ? first.instancePath
            : "/";
        return `${instancePath} ${first.message}`;
      }
    }
    const line = error.message
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    return line ?? "unknown error";
  }
  return "unknown error";
}

function findAuditorError(error: unknown): AuditorError | undefined {
  let found: AuditorError | undefined;
  walkErrors(error, (current) => {
    if (current instanceof AuditorError) {
      found = current;
      return true;
    }
    return false;
  });
  return found;
}

function findNamedError(
  error: unknown,
  names: readonly string[],
  codes: readonly string[],
): (Error & { source?: unknown }) | undefined {
  let found: (Error & { source?: unknown }) | undefined;
  walkErrors(error, (current) => {
    if (!(current instanceof Error)) {
      return false;
    }
    const code = "code" in current ? current.code : undefined;
    if (names.includes(current.name) || (typeof code === "string" && codes.includes(code))) {
      found = current;
      return true;
    }
    return false;
  });
  return found;
}

function findMessage(error: unknown, fragment: string): boolean {
  let found = false;
  walkErrors(error, (current) => {
    if (current instanceof Error && current.message.includes(fragment)) {
      found = true;
      return true;
    }
    return false;
  });
  return found;
}

function walkErrors(error: unknown, visit: (current: object) => boolean): void {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (visit(current)) {
      return;
    }
    const record = current as { cause?: unknown; error?: unknown };
    current = record.cause ?? record.error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
