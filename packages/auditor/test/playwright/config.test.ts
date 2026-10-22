import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { findPlaywrightConfig, readBaseURL, stripBase } from "../../src/playwright/config.js";

const BASE = "http://127.0.0.1:3000";

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "auditor-config-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

it("reads baseURL from defineConfig imported from @playwright/test", () => {
  withDir((dir) => {
    const file = write(
      dir,
      "playwright.config.ts",
      [
        "import { defineConfig } from '@playwright/test';",
        `export default defineConfig({ use: { baseURL: '${BASE}' } });`,
      ].join("\n"),
    );

    expect(readBaseURL(file)).toEqual({ literal: true, value: BASE });
  });
});

it("reads baseURL from CommonJS module.exports", () => {
  withDir((dir) => {
    const file = write(
      dir,
      "playwright.config.js",
      [`const baseURL = '${BASE}';`, "module.exports = { use: { baseURL } };"].join("\n"),
    );

    expect(readBaseURL(file)).toEqual({ literal: true, value: BASE });
  });
});

it("returns the non-literal discriminant for process.env.BASE_URL", () => {
  withDir((dir) => {
    const file = write(
      dir,
      "playwright.config.ts",
      [
        "import { defineConfig } from '@playwright/test';",
        "export default defineConfig({ use: { baseURL: process.env.BASE_URL } });",
      ].join("\n"),
    );

    expect(readBaseURL(file)).toEqual({ literal: false });
  });
});

it("returns the non-literal discriminant for a reassigned baseURL binding", () => {
  withDir((dir) => {
    const file = write(
      dir,
      "playwright.config.ts",
      ["let baseURL = 'http://127.0.0.1:3000';", "baseURL = 'http://127.0.0.1:4000';", "export default { use: { baseURL } };"].join(
        "\n",
      ),
    );

    expect(readBaseURL(file)).toEqual({ literal: false });
  });
});

it("returns undefined when the config has no baseURL", () => {
  withDir((dir) => {
    const file = write(
      dir,
      "playwright.config.ts",
      [
        "import { defineConfig } from '@playwright/test';",
        "export default defineConfig({ use: { screenshot: 'on' } });",
      ].join("\n"),
    );

    expect(readBaseURL(file)).toBeUndefined();
  });
});

it("resolves a same-file constant used as baseURL", () => {
  withDir((dir) => {
    const file = write(
      dir,
      "playwright.config.ts",
      [
        "const host = 'http://127.0.0.1:';",
        "const port = '3000';",
        "const use = { baseURL: host + port };",
        "export default { use };",
      ].join("\n"),
    );

    expect(readBaseURL(file)).toEqual({ literal: true, value: BASE });
  });
});

it("reads an explicit baseURL that follows a spread and rejects one a spread can replace", () => {
  withDir((dir) => {
    const after = write(
      dir,
      "after.ts",
      [
        "import { defineConfig, devices } from '@playwright/test';",
        "export default defineConfig({",
        "  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3000' },",
        "});",
      ].join("\n"),
    );
    const before = write(
      dir,
      "before.ts",
      [
        "const devices = { viewport: { width: 1, height: 1 } };",
        "export default { use: { baseURL: 'http://127.0.0.1:3000', ...devices } };",
      ].join("\n"),
    );
    const only = write(dir, "only.ts", "const devices = {};\nexport default { use: { ...devices } };\n");

    expect(readBaseURL(after)).toEqual({ literal: true, value: BASE });
    expect(readBaseURL(before)).toEqual({ literal: false });
    expect(readBaseURL(only)).toEqual({ literal: false });
  });
});

it("follows a renamed defineConfig binding and a const config object", () => {
  withDir((dir) => {
    const renamed = write(
      dir,
      "renamed.ts",
      [
        "import { defineConfig as config } from '@playwright/test';",
        `export default config({ use: { baseURL: '${BASE}' } });`,
      ].join("\n"),
    );
    const forwarded = write(
      dir,
      "forwarded.ts",
      [
        "import { defineConfig } from '@playwright/test';",
        `const config = { use: { baseURL: '${BASE}' } };`,
        "export default defineConfig(config);",
      ].join("\n"),
    );

    expect(readBaseURL(renamed)).toEqual({ literal: true, value: BASE });
    expect(readBaseURL(forwarded)).toEqual({ literal: true, value: BASE });
  });
});

it("reads baseURL from defineConfig required in CommonJS", () => {
  withDir((dir) => {
    const file = write(
      dir,
      "playwright.config.js",
      [
        "const { defineConfig } = require('@playwright/test');",
        `module.exports = defineConfig({ use: { baseURL: '${BASE}' } });`,
      ].join("\n"),
    );

    expect(readBaseURL(file)).toEqual({ literal: true, value: BASE });
  });
});

it("does not unwrap defineConfig unless it is imported from @playwright/test", () => {
  withDir((dir) => {
    const local = write(
      dir,
      "local.ts",
      [
        "function defineConfig(config) { return config; }",
        `export default defineConfig({ use: { baseURL: '${BASE}' } });`,
      ].join("\n"),
    );
    const other = write(
      dir,
      "other.ts",
      [
        "import { defineConfig } from 'playwright/test';",
        `export default defineConfig({ use: { baseURL: '${BASE}' } });`,
      ].join("\n"),
    );

    expect(readBaseURL(local)).toBeUndefined();
    expect(readBaseURL(other)).toBeUndefined();
  });
});

it("strips a baseURL and keeps query limit=1 separate from the path", () => {
  const stripped = stripBase(`${BASE}/orders?limit=1`, [BASE]);

  expect(stripped.path).toBe("/orders");
  expect(stripped.query).toEqual({ limit: "1" });
  expect(new URLSearchParams(stripped.query).toString()).toBe("limit=1");
});

it("leaves a path-absolute URL unchanged", () => {
  expect(stripBase("/orders/1", [BASE, "https://api.example.com/v1"])).toEqual({
    path: "/orders/1",
    query: {},
  });
});

it("strips a server base https://api.example.com/v1 to /orders", () => {
  expect(stripBase("https://api.example.com/v1/orders", ["https://api.example.com/v1"])).toEqual({
    path: "/orders",
    query: {},
  });
});

it("normalizes a trailing slash on the server base before stripping", () => {
  expect(stripBase("https://api.example.com/v1/orders", ["https://api.example.com/v1/"])).toEqual({
    path: "/orders",
    query: {},
  });
  expect(stripBase("https://api.example.com/v1/orders/", ["https://api.example.com/v1"]).path).toBe("/orders/");
});

it("removes only the origin when no prefix matches", () => {
  expect(stripBase("https://other.example/orders/1", [BASE])).toEqual({
    path: "/orders/1",
    query: {},
  });
  expect(stripBase(`${BASE}/`, [BASE]).path).toBe("/");
  expect(stripBase("/", [BASE]).path).toBe("/");
});

it("does not strip a prefix that stops inside a segment", () => {
  expect(stripBase("https://api.example.com/v1orders", ["https://api.example.com/v1"]).path).toBe("/v1orders");
});

it("tries the literal baseURL before later server prefixes", () => {
  expect(
    stripBase("https://api.example.com/v1/orders", ["https://api.example.com"], "https://api.example.com/v1").path,
  ).toBe("/orders");
  expect(stripBase("https://api.example.com/v1/orders", ["https://api.example.com", "https://api.example.com/v1"]).path).toBe(
    "/v1/orders",
  );
});

it("resolves a relative URL against the literal baseURL and not against servers", () => {
  expect(stripBase("orders", ["https://api.example.com/v1"], BASE)).toEqual({
    path: "/orders",
    query: {},
  });
  expect(stripBase("orders?limit=1", ["https://api.example.com/v1"])).toEqual({
    path: "/orders",
    query: { limit: "1" },
  });
  expect(stripBase("orders", [], "https://api.example.com/v1/").path).toBe("/orders");
});

it("searches playwright.config.ts, then .mts, .js, and .mjs", () => {
  withDir((dir) => {
    write(dir, "playwright.config.mjs", "module.exports = {};\n");
    write(dir, "playwright.config.js", "module.exports = {};\n");
    write(dir, "playwright.config.mts", "export default {};\n");
    write(dir, "playwright.config.ts", "export default {};\n");
    expect(findPlaywrightConfig(dir)).toBe(join(dir, "playwright.config.ts"));
  });

  withDir((dir) => {
    write(dir, "playwright.config.js", "module.exports = {};\n");
    write(dir, "playwright.config.mts", "export default {};\n");
    expect(findPlaywrightConfig(dir)).toBe(join(dir, "playwright.config.mts"));
  });

  withDir((dir) => {
    write(dir, "playwright.config.mjs", "module.exports = {};\n");
    expect(findPlaywrightConfig(dir)).toBe(join(dir, "playwright.config.mjs"));
  });

  withDir((dir) => {
    mkdirSync(join(dir, "playwright.config.ts"));
    write(dir, "playwright.config.js", "module.exports = {};\n");
    expect(findPlaywrightConfig(dir)).toBe(join(dir, "playwright.config.js"));
  });

  withDir((dir) => {
    write(dir, "playwright.config.cjs", "module.exports = {};\n");
    expect(findPlaywrightConfig(dir)).toBeUndefined();
  });
});

it("skips the config search when playwrightConfigPath is null", () => {
  withDir((dir) => {
    write(dir, "playwright.config.ts", "export default {};\n");
    expect(findPlaywrightConfig(dir, null)).toBeUndefined();
  });
});

it("uses playwrightConfigPath instead of the searched filenames", () => {
  withDir((dir) => {
    write(
      dir,
      "playwright.config.ts",
      ["import { defineConfig } from '@playwright/test';", "export default defineConfig({ use: {} });"].join("\n"),
    );
    const custom = write(
      dir,
      "custom.config.mts",
      ["import { defineConfig } from '@playwright/test';", `export default defineConfig({ use: { baseURL: '${BASE}' } });`].join(
        "\n",
      ),
    );

    expect(findPlaywrightConfig(dir, "custom.config.mts")).toBe(custom);
    expect(readBaseURL(custom)).toEqual({ literal: true, value: BASE });
  });
});
