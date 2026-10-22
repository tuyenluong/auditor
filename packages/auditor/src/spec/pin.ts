import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { AuditorError } from "../errors.js";

export interface PinMeta {
  url: string;
  openapi: string;
  version: string;
  title: string;
}

interface PinSidecar extends PinMeta {
  fetchedAt: string;
  sha256: string;
}

export async function savePin(pinPath: string, bytes: Uint8Array, meta: PinMeta): Promise<void> {
  const sidecar: PinSidecar = {
    url: meta.url,
    fetchedAt: new Date().toISOString(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    openapi: meta.openapi,
    version: meta.version,
    title: meta.title,
  };
  await writeFile(pinPath, bytes);
  await writeFile(`${pinPath}.meta.json`, `${JSON.stringify(sidecar, null, 2)}\n`);
}

export async function readPin(pinPath: string): Promise<Uint8Array> {
  try {
    return await readFile(pinPath);
  } catch (error) {
    if (isEnoent(error)) {
      throw new AuditorError(`Pinned spec not found: ${pinPath}`, "SPEC_PIN");
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
