import { AuditorError } from "../errors.js";
import type { CheckOptions } from "../types.js";
import { fetchSpec } from "./fetch.js";
import type { SpecModel } from "./model.js";
import { parseSpec, type OpenApiDocument } from "./parse.js";
import { readPin, savePin } from "./pin.js";

export type LoadSpecOptions = Pick<
  CheckOptions,
  "allowHosts" | "specAuthHeader" | "pinPath" | "savePinPath"
>;

export interface LoadedSpec {
  document: OpenApiDocument;
  source: SpecModel["source"];
  location: string;
}

export async function loadSpec(location: string, options: LoadSpecOptions = {}): Promise<LoadedSpec> {
  if (options.pinPath !== undefined) {
    const bytes = await readPin(options.pinPath);
    return {
      document: await parseSpec(bytes, options),
      source: "pinned",
      location: options.pinPath,
    };
  }

  if (!isSpecUrl(location)) {
    if (options.savePinPath !== undefined) {
      throw new AuditorError("--save-pin requires --spec to be a URL", "SPEC_PIN");
    }
    return {
      document: await parseSpec(location, options),
      source: "file",
      location,
    };
  }

  const fetched = await fetchSpec(location, options);
  const document = await parseSpec(fetched.bytes, options);
  if (options.savePinPath !== undefined) {
    await savePin(options.savePinPath, fetched.bytes, {
      url: location,
      openapi: document.openapi,
      version: document.info.version,
      title: document.info.title,
    });
  }
  return { document, source: "live", location };
}

function isSpecUrl(location: string): boolean {
  try {
    const protocol = new URL(location).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
