import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AuditorError } from "../../src/index.js";
import {
  parseSpec,
  type OpenApiDocument,
  type ParseSpecOptions,
} from "../../src/spec/parse.js";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return resolve(fixtureDir, name);
}

async function rejected(specPath: string, options?: ParseSpecOptions): Promise<unknown> {
  try {
    await parseSpec(specPath, options);
  } catch (error) {
    return error;
  }
  throw new Error(`expected parseSpec to reject ${specPath}`);
}

function schemaProperties(doc: OpenApiDocument, specPath: string): Record<string, unknown> | undefined {
  const loaded = doc as {
    paths?: Record<
      string,
      {
        get?: {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                { schema?: { properties?: Record<string, unknown> } }
              >;
            }
          >;
        };
      }
    >;
  };
  return loaded.paths?.[specPath]?.get?.responses?.["200"]?.content?.["application/json"]?.schema
    ?.properties;
}

it("loads the same 3.0.3 document from YAML and JSON", async () => {
  const yaml = await parseSpec(fixture("orders.openapi.yaml"));
  const json = await parseSpec(fixture("orders.openapi.json"));

  expect(yaml.openapi).toBe("3.0.3");
  expect(json.openapi).toBe("3.0.3");
});

it("dereferences an internal component schema", async () => {
  const doc = await parseSpec(fixture("orders.openapi.yaml"));

  expect(schemaProperties(doc, "/orders/{id}")?.sku).toEqual({ type: "string" });
});

it("loads a minimal OpenAPI 3.1.0 document", async () => {
  const doc = await parseSpec(fixture("health.openapi.yaml"));

  expect(doc.openapi).toBe("3.1.0");
  expect(doc.paths?.["/health"]?.get?.responses?.["200"]).toBeDefined();
});

it("rejects Swagger 2.0", async () => {
  const error = await rejected(fixture("swagger2.yaml"));

  expect(error).toBeInstanceOf(AuditorError);
  if (!(error instanceof AuditorError)) {
    return;
  }
  expect(error.code).toBe("SPEC_INVALID");
  expect(error.message.startsWith("Expected OpenAPI 3.x")).toBe(true);
});

it("rejects a file that is not YAML or JSON", async () => {
  const error = await rejected(fixture("not-a-spec.txt"));

  expect(error).toBeInstanceOf(AuditorError);
  if (!(error instanceof AuditorError)) {
    return;
  }
  expect(error.code).toBe("SPEC_INVALID");
  expect(error.message.startsWith("Spec is not valid YAML or JSON")).toBe(true);
});

it("rejects a missing spec path", async () => {
  const missing = "does-not-exist.openapi.yaml";
  const error = await rejected(missing);

  expect(error).toBeInstanceOf(AuditorError);
  if (!(error instanceof AuditorError)) {
    return;
  }
  expect(error.code).toBe("SPEC_NOT_FOUND");
  expect(error.message).toBe(`Spec file not found: ${missing}`);
});

it("rejects a relative $ref that escapes the spec directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "auditor-spec-"));
  const specDir = join(root, "a", "b", "c");
  const leaked = join(root, "etc", "passwd");
  const sentinel = "AUDITOR_DO_NOT_LEAK_passwd_contents";
  await mkdir(specDir, { recursive: true });
  await mkdir(dirname(leaked), { recursive: true });
  await writeFile(leaked, `${sentinel}\n`);
  const specFile = join(specDir, "escape.openapi.yaml");
  await writeFile(
    specFile,
    `openapi: 3.0.3
info:
  title: Escape
  version: "1.0.0"
paths:
  /x:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "../../../etc/passwd"
`,
  );

  try {
    const error = await rejected(specFile);
    const passwd = await readFile("/etc/passwd", "utf8");
    const passwdLine = passwd.split("\n").find((line) => line.length > 0) ?? "";

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_INVALID");
    expect(error.message).not.toContain(sentinel);
    expect(error.message).not.toContain(passwdLine);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("resolves a relative file $ref inside the spec directory", async () => {
  const doc = await parseSpec(fixture("split.openapi.yaml"));

  expect(schemaProperties(doc, "/items")?.sku).toEqual({ type: "string" });
});

it("rejects a non-allowlisted external $ref", async () => {
  const error = await rejected(fixture("remote-ref.openapi.yaml"));

  expect(error).toBeInstanceOf(AuditorError);
  if (!(error instanceof AuditorError)) {
    return;
  }
  expect(error.code).toBe("SPEC_INVALID");
  expect(error.message).toBe(
    "External $ref https://example.com/schemas/item.yaml is not allowlisted",
  );
});

it("resolves an allowlisted http $ref and sends the auth header", async () => {
  const requests: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "object", properties: { sku: { type: "string" } } }));
  });

  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP server address");
  }

  const root = await mkdtemp(join(tmpdir(), "auditor-spec-"));
  const specFile = join(root, "remote.openapi.yaml");
  const ref = `http://127.0.0.1:${address.port}/sku.json`;
  await writeFile(
    specFile,
    `openapi: 3.0.3
info:
  title: Remote
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

  try {
    const blocked = await rejected(specFile, { allowHosts: [] });
    expect(blocked).toBeInstanceOf(AuditorError);
    if (!(blocked instanceof AuditorError)) {
      return;
    }
    expect(blocked.code).toBe("SPEC_INVALID");
    expect(blocked.message).toBe(`External $ref ${ref} is not allowlisted`);
    expect(requests).toEqual([]);

    const doc = await parseSpec(specFile, {
      allowHosts: ["127.0.0.1"],
      specAuthHeader: "Bearer secret",
    });
    expect(schemaProperties(doc, "/items")?.sku).toEqual({ type: "string" });
    expect(requests).toEqual(["Bearer secret"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await closeServer(server);
  }
});

it("rejects an allowlisted http $ref outside loopback before any request", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    calls.push(String(args[0]));
    return original(...args);
  }) as typeof fetch;

  const root = await mkdtemp(join(tmpdir(), "auditor-spec-"));
  const specFile = join(root, "remote.openapi.yaml");
  const ref = "http://example.com/schemas/item.yaml";
  await writeFile(
    specFile,
    `openapi: 3.0.3
info:
  title: Remote
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

  try {
    const error = await rejected(specFile, {
      allowHosts: ["example.com"],
      specAuthHeader: "Bearer secret",
    });

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_INVALID");
    expect(error.message).toContain(ref);
    expect(error.message).not.toContain("Bearer secret");
    expect(calls).toEqual([]);
  } finally {
    globalThis.fetch = original;
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a relative $ref in spec bytes that have no file path", async () => {
  const bytes = new TextEncoder().encode(`openapi: 3.0.3
info:
  title: Bytes
  version: "1.0.0"
paths:
  /x:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: ./other.yaml
`);

  try {
    await parseSpec(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_INVALID");
    expect(error.message).toContain("cannot be resolved without a spec file path");
    expect(error.message).toContain("./other.yaml");
    return;
  }
  throw new Error("expected parseSpec to reject bytes with a relative $ref");
});

it("rejects a symlink $ref whose real path leaves the spec directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "auditor-spec-"));
  const specDir = join(root, "spec");
  const outside = join(root, "outside");
  const sentinel = "AUDITOR_DO_NOT_LEAK_symlink_contents";
  await mkdir(specDir, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.yaml"), `${sentinel}\n`);
  await symlink(outside, join(specDir, "link"));
  const specFile = join(specDir, "symlink.openapi.yaml");
  await writeFile(
    specFile,
    `openapi: 3.0.3
info:
  title: Symlink
  version: "1.0.0"
paths:
  /x:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: ./link/secret.yaml
`,
  );

  try {
    const error = await rejected(specFile);

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_INVALID");
    expect(error.message).not.toContain(sentinel);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
