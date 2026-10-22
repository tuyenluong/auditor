import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AuditorError } from "../../src/index.js";
import { loadSpec, type LoadSpecOptions } from "../../src/spec/load.js";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return resolve(fixtureDir, name);
}

it("saves a fetched spec and loads the pin after the server closes", async () => {
  const body = await readFile(fixture("orders.openapi.json"));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  const dir = await mkdtemp(join(tmpdir(), "auditor-pin-"));
  const pinPath = join(dir, "orders.openapi.json");

  try {
    await listen(server);
    const url = urlOf(server);
    const live = await loadSpec(url, {
      allowHosts: ["127.0.0.1"],
      savePinPath: pinPath,
    });

    expect(live.source).toBe("live");
    expect(live.location).toBe(url);
    expect(live.document.openapi).toBe("3.0.3");
    expect(live.document.info.title).toBe("Orders API");
    expect(requests).toEqual(["/openapi.json"]);

    await closeServer(server);

    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls.push(String(args[0]));
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      const pinned = await loadSpec(url, {
        allowHosts: ["127.0.0.1"],
        specAuthHeader: "Bearer secret",
        pinPath,
      });

      expect(pinned.source).toBe("pinned");
      expect(pinned.location).toBe(pinPath);
      expect(pinned.document).toEqual(live.document);
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const pinBytes = await readFile(pinPath);
    const meta = JSON.parse(await readFile(`${pinPath}.meta.json`, "utf8")) as {
      url: string;
      fetchedAt: string;
      sha256: string;
      openapi: string;
      version: string;
      title: string;
    };
    expect(pinBytes.equals(body)).toBe(true);
    expect(meta.sha256).toBe(createHash("sha256").update(pinBytes).digest("hex"));
    expect(meta.url).toBe(url);
    expect(meta.openapi).toBe("3.0.3");
    expect(meta.version).toBe("1.0.0");
    expect(meta.title).toBe("Orders API");
    expect(meta.fetchedAt).toBe(new Date(meta.fetchedAt).toISOString());
  } finally {
    await closeQuietly(server);
    await rm(dir, { recursive: true, force: true });
  }
});

it("throws SPEC_PIN when the pinned spec is missing", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const dir = await mkdtemp(join(tmpdir(), "auditor-pin-"));
  const pinPath = join(dir, "missing.openapi.json");

  try {
    await listen(server);
    const error = await rejected(urlOf(server), {
      allowHosts: ["127.0.0.1"],
      pinPath,
    });

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_PIN");
    expect(error.message.startsWith("Pinned spec not found:")).toBe(true);
    expect(error.message).toContain(pinPath);
    expect(requests).toEqual([]);
  } finally {
    await closeQuietly(server);
    await rm(dir, { recursive: true, force: true });
  }
});

it("throws SPEC_PIN for a remote $ref in a pinned spec before any request", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "object", properties: { sku: { type: "string" } } }));
  });
  const dir = await mkdtemp(join(tmpdir(), "auditor-pin-"));
  const pinPath = join(dir, "remote.openapi.yaml");

  try {
    await listen(server);
    const ref = urlOf(server).replace(/\/openapi\.json$/, "/sku.json");
    await writeFile(
      pinPath,
      `openapi: 3.0.3
info:
  title: Pinned
  version: "1.0.0"
paths:
  /items:
    get:
      responses:
        "200":
          description: An item
          content:
            application/json:
              schema:
                $ref: ${ref}
`,
    );

    const error = await rejected("http://127.0.0.1/ignored", {
      allowHosts: ["127.0.0.1"],
      pinPath,
    });

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_PIN");
    expect(error.message).toBe(`Pinned spec has a remote $ref: ${ref}`);
    expect(error.message).not.toContain("allow-host");
    expect(requests).toEqual([]);
  } finally {
    await closeQuietly(server);
    await rm(dir, { recursive: true, force: true });
  }
});

it("loads a file path as source file without reading the environment", async () => {
  const specPath = fixture("orders.openapi.yaml");
  const previousToken = process.env.AUDITOR_SPEC_TOKEN;
  process.env.AUDITOR_SPEC_TOKEN = "super-secret-token";
  const envReads: string[] = [];
  const realEnv = process.env;
  process.env = new Proxy(realEnv, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        envReads.push(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string") {
        envReads.push(prop);
      }
      return Reflect.has(target, prop);
    },
    set(target, prop, value, receiver) {
      if (typeof prop === "string") {
        envReads.push(prop);
      }
      return Reflect.set(target, prop, value, receiver);
    },
  });

  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls.push(String(args[0]));
    return originalFetch(...args);
  }) as typeof fetch;

  try {
    const loaded = await loadSpec(specPath);

    expect(loaded.source).toBe("file");
    expect(loaded.location).toBe(specPath);
    expect(loaded.document.openapi).toBe("3.0.3");
    expect(loaded.document.info.title).toBe("Orders API");
    expect(envReads).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(JSON.stringify(loaded.document)).not.toContain("super-secret-token");
  } finally {
    process.env = realEnv;
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) {
      delete realEnv.AUDITOR_SPEC_TOKEN;
    } else {
      realEnv.AUDITOR_SPEC_TOKEN = previousToken;
    }
  }
});

it("loads a URL as source live", async () => {
  const body = await readFile(fixture("health.openapi.yaml"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/yaml" });
    response.end(body);
  });

  try {
    await listen(server);
    const url = urlOf(server);
    const loaded = await loadSpec(url, { allowHosts: ["127.0.0.1"] });

    expect(loaded.source).toBe("live");
    expect(loaded.location).toBe(url);
    expect(loaded.document.openapi).toBe("3.1.0");
    expect(loaded.document.info.title).toBe("Health");
  } finally {
    await closeQuietly(server);
  }
});

it("throws SPEC_PIN when savePinPath is set for a file location", async () => {
  const dir = await mkdtemp(join(tmpdir(), "auditor-pin-"));
  const savePinPath = join(dir, "saved.openapi.json");

  try {
    const error = await rejected(join(dir, "missing.yaml"), { savePinPath });

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_PIN");
    expect(error.message).toBe("--save-pin requires --spec to be a URL");
    await expect(readFile(savePinPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function rejected(location: string, options?: LoadSpecOptions): Promise<unknown> {
  try {
    await loadSpec(location, options);
  } catch (error) {
    return error;
  }
  throw new Error(`expected loadSpec to reject ${location}`);
}

function urlOf(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP server address");
  }
  return `http://127.0.0.1:${address.port}/openapi.json`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function closeQuietly(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await closeServer(server);
}
