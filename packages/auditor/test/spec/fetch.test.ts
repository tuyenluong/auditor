import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AuditorError } from "../../src/index.js";
import { fetchSpec, type FetchSpecOptions } from "../../src/spec/fetch.js";
import { parseSpec } from "../../src/spec/parse.js";

const spec = {
  openapi: "3.0.3",
  info: { title: "Fetched", version: "1.0.0" },
  paths: {
    "/health": {
      get: {
        responses: {
          "200": { description: "ok" },
        },
      },
    },
  },
};

const MAX_SPEC_BYTES = 5 * 1024 * 1024;

it("sends the auth header and parses the served document", async () => {
  const requests: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(spec));
  });
  await listen(server);

  try {
    const fetched = await fetchSpec(urlOf(server), {
      allowHosts: ["127.0.0.1"],
      specAuthHeader: "Bearer secret",
    });

    expect(requests).toEqual(["Bearer secret"]);
    expect(fetched.contentType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(fetched.bytes))).toEqual(spec);
    expect(await parseSpec(fetched.bytes)).toEqual(spec);
  } finally {
    await closeServer(server);
  }
});

it("refuses an empty allowlist before any request", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(spec));
  });
  await listen(server);

  try {
    const error = await rejected(urlOf(server), {
      allowHosts: [],
      specAuthHeader: "Bearer secret",
    });

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_FETCH");
    expect(error.message).toContain("not allowlisted");
    expect(error.message).not.toContain("Bearer secret");
    expect(requests).toEqual([]);
  } finally {
    await closeServer(server);
  }
});

it("does not follow a redirect to a host outside the allowlist", async () => {
  const secondRequests: string[] = [];
  const second = createServer((request, response) => {
    secondRequests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(spec));
  });
  await listen(second, "127.0.0.1");

  const first = createServer((_request, response) => {
    response.writeHead(302, {
      Location: `http://localhost:${portOf(second)}/openapi.json`,
    });
    response.end();
  });
  await listen(first);

  try {
    const error = await rejected(urlOf(first), { allowHosts: ["127.0.0.1"] });

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_FETCH");
    expect(error.message).toContain("not allowlisted");
    expect(secondRequests).toEqual([]);
  } finally {
    await closeServer(first);
    await closeServer(second);
  }
});

it("follows a redirect whose host stays on the allowlist", async () => {
  const requests: Array<string | undefined> = [];
  const second = createServer((request, response) => {
    requests.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(spec));
  });
  await listen(second);
  const first = createServer((request, response) => {
    requests.push(request.headers.authorization);
    response.writeHead(302, { Location: urlOf(second) });
    response.end();
  });
  await listen(first);

  try {
    const fetched = await fetchSpec(urlOf(first), {
      allowHosts: ["127.0.0.1"],
      specAuthHeader: "Bearer secret",
    });

    expect(requests).toEqual(["Bearer secret", "Bearer secret"]);
    expect(await parseSpec(fetched.bytes)).toEqual(spec);
  } finally {
    await closeServer(first);
    await closeServer(second);
  }
});

it("stops after three allowlisted redirects", async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(302, { Location: urlOf(server) });
    response.end();
  });
  await listen(server);

  try {
    const error = await rejected(urlOf(server), { allowHosts: ["127.0.0.1"] });

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_FETCH");
    expect(hits).toBe(4);
  } finally {
    await closeServer(server);
  }
});

it("rejects http URLs other than loopback even when the host is allowlisted", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    calls.push(String(args[0]));
    return original(...args);
  }) as typeof fetch;

  try {
    const error = await rejected("http://example.com/openapi.yaml", {
      allowHosts: ["example.com"],
      specAuthHeader: "Bearer secret",
    });

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_FETCH");
    expect(error.message).not.toContain("Bearer secret");
    expect(calls).toEqual([]);
  } finally {
    globalThis.fetch = original;
  }
});

it("matches an allowlist host with a different case and port", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(spec));
  });
  await listen(server, "localhost");

  try {
    const fetched = await fetchSpec(urlOf(server, "localhost"), {
      allowHosts: ["LocalHost:443"],
    });
    expect(await parseSpec(fetched.bytes)).toEqual(spec);
  } finally {
    await closeServer(server);
  }
});

it("rejects a response body larger than 5 MiB", async () => {
  const server = createServer((request, response) => {
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.alloc(MAX_SPEC_BYTES));
    response.end(Buffer.alloc(1));
  });
  await listen(server);

  try {
    const error = await rejected(urlOf(server), { allowHosts: ["127.0.0.1"] });

    expect(error).toBeInstanceOf(AuditorError);
    if (!(error instanceof AuditorError)) {
      return;
    }
    expect(error.code).toBe("SPEC_FETCH");
    expect(error.message).toContain("5 MiB");
  } finally {
    await closeServer(server);
  }
});

it("accepts a response body of exactly 5 MiB", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(MAX_SPEC_BYTES),
    });
    response.end(Buffer.alloc(MAX_SPEC_BYTES));
  });
  await listen(server);

  try {
    const fetched = await fetchSpec(urlOf(server), { allowHosts: ["127.0.0.1"] });
    expect(fetched.bytes.byteLength).toBe(MAX_SPEC_BYTES);
  } finally {
    await closeServer(server);
  }
});

it("parses spec bytes the same way as a file", async () => {
  const specPath = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/orders.openapi.json");
  const fromFile = await parseSpec(specPath);
  const fromBytes = await parseSpec(await readFile(specPath));

  expect(fromBytes).toEqual(fromFile);
});

async function rejected(url: string, options?: FetchSpecOptions): Promise<unknown> {
  try {
    await fetchSpec(url, options);
  } catch (error) {
    return error;
  }
  throw new Error(`expected fetchSpec to reject ${url}`);
}

function urlOf(server: Server, host = "127.0.0.1"): string {
  return `http://${host}:${portOf(server)}/openapi.json`;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP server address");
  }
  return address.port;
}

function listen(server: Server, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
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
