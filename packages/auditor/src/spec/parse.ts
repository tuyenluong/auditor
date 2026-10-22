import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { load } from "js-yaml";
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

export async function parseSpec(
  specPath: string,
  options: ParseSpecOptions = {},
): Promise<OpenApiDocument> {
  const absolute = await resolveSpecPath(specPath);
  const parsed = parseYaml(await readFile(absolute, "utf8"));
  if (!isOpenApi3(parsed)) {
    throw new AuditorError(
      `Expected OpenAPI 3.x, found ${versionFound(parsed)}`,
      "SPEC_INVALID",
    );
  }

  try {
    return (await SwaggerParser.validate(
      absolute,
      parsed,
      resolverOptions(path.dirname(absolute), options),
    )) as OpenApiDocument;
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

function resolverOptions(specDir: string, options: ParseSpecOptions): SwaggerParser.Options {
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

async function readAllowlistedUrl(options: ParseSpecOptions, file: RefFile): Promise<Buffer> {
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

function isHostAllowed(hostname: string, allowHosts: readonly string[] | undefined): boolean {
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
