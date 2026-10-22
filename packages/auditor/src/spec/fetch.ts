import { AuditorError } from "../errors.js";
import type { CheckOptions } from "../types.js";

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchedSpec {
  bytes: Uint8Array;
  contentType: string | undefined;
}

export type FetchSpecOptions = Pick<CheckOptions, "allowHosts" | "specAuthHeader">;

export async function fetchSpec(
  url: string,
  options: FetchSpecOptions = {},
): Promise<FetchedSpec> {
  let current = parseSpecUrl(url);
  assertAllowed(current, options.allowHosts);

  let followed = 0;
  for (;;) {
    const response = await request(current, options.specAuthHeader);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return readBody(response, options.specAuthHeader);
    }

    const next = await redirectTarget(current, response);
    assertAllowed(next, options.allowHosts);
    if (followed >= MAX_REDIRECTS) {
      throw new AuditorError("Spec URL redirected more than 3 times", "SPEC_FETCH");
    }
    current = next;
    followed += 1;
  }
}

export function isHostAllowlisted(
  hostname: string,
  allowHosts: readonly string[] | undefined,
): boolean {
  const host = hostname.toLowerCase();
  return (allowHosts ?? []).some((entry) => hostEntry(entry) === host);
}

function parseSpecUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new AuditorError("Invalid spec URL", "SPEC_FETCH");
  }
}

function assertAllowed(target: URL, allowHosts: readonly string[] | undefined): void {
  const host = target.hostname.toLowerCase();
  if (!isFetchable(target.protocol, host)) {
    throw new AuditorError(`Spec URL scheme is not allowed for host ${host}`, "SPEC_FETCH");
  }
  if (!isHostAllowlisted(host, allowHosts)) {
    throw new AuditorError(`Host ${host} is not allowlisted; pass --allow-host`, "SPEC_FETCH");
  }
}

function isFetchable(protocol: string, host: string): boolean {
  if (protocol === "https:") {
    return true;
  }
  return protocol === "http:" && (host === "127.0.0.1" || host === "localhost");
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

async function request(target: URL, specAuthHeader: string | undefined): Promise<Response> {
  const headers = new Headers();
  if (specAuthHeader !== undefined) {
    headers.set("Authorization", specAuthHeader);
  }
  try {
    return await fetch(target, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError(error, specAuthHeader);
  }
}

async function redirectTarget(current: URL, response: Response): Promise<URL> {
  const location = response.headers.get("location");
  await cancel(response);
  if (location === null || location.trim() === "") {
    throw new AuditorError("Spec redirect is missing a Location header", "SPEC_FETCH");
  }
  try {
    return new URL(location, current);
  } catch {
    throw new AuditorError("Spec redirect Location is invalid", "SPEC_FETCH");
  }
}

async function readBody(
  response: Response,
  specAuthHeader: string | undefined,
): Promise<FetchedSpec> {
  try {
    if (!response.ok) {
      throw new AuditorError(`Spec fetch failed: HTTP ${response.status}`, "SPEC_FETCH");
    }
    if (exceedsDeclaredCap(response.headers.get("content-length"))) {
      throw new AuditorError("Spec response exceeds 5 MiB", "SPEC_FETCH");
    }
    const bytes = await readCapped(response);
    return { bytes, contentType: response.headers.get("content-type") ?? undefined };
  } catch (error) {
    if (error instanceof AuditorError) {
      throw error;
    }
    throw networkError(error, specAuthHeader);
  } finally {
    await cancel(response);
  }
}

function exceedsDeclaredCap(header: string | null): boolean {
  if (header === null || !/^\d+$/.test(header)) {
    return false;
  }
  return Number(header) > MAX_BYTES;
}

async function readCapped(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined || value.byteLength === 0) {
        continue;
      }
      total += value.byteLength;
      if (total > MAX_BYTES) {
        throw new AuditorError("Spec response exceeds 5 MiB", "SPEC_FETCH");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function networkError(error: unknown, specAuthHeader: string | undefined): AuditorError {
  if (error instanceof AuditorError) {
    return error;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new AuditorError("Spec fetch timed out", "SPEC_FETCH");
  }
  const message = error instanceof Error ? error.message : "unknown error";
  return new AuditorError(`Spec fetch failed: ${redact(message, specAuthHeader)}`, "SPEC_FETCH");
}

function redact(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) {
    return message;
  }
  return message.replaceAll(secret, "[redacted]");
}
