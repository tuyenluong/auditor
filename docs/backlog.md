# Auditor implementation backlog

Refinement of the approved product backlog (Portfolios 1–3, 22 Oct 2026 draft). This file is the work breakdown. Normative behavior, types, message text, and the dependency graph are in `docs/architecture.md`. Contributor commit and branch rules are in `CONTRIBUTING.md`.

This refinement does not implement the product. The next change is pull request 1 in the delivery order (`F-01`).

## How to read a task

Every task lists its id, title, inputs, dependencies, outputs, acceptance check, and size. S is under a day of focused work for someone who already knows the repo. M is a single reviewable change with one module and its tests. Anything that would have been L is already split. There is no L task.

Dependencies are task ids that must be merged first. "None" means it starts from the repository as this refinement left it, plus `F-01` when the task needs the workspace.

The acceptance check is a command run from the repo root after `npm ci`. The expected result is part of the check. Tests live in `packages/auditor/test/` and use vitest. Fixtures live next to the test that owns them.

Shared rules:

- Implement the recommended default of any open question the task names. If the decision changes, update the open question, `docs/architecture.md`, and the task before starting.
- Commit with a Conventional Commits message. Branch names follow `CONTRIBUTING.md`.
- `npm test` and `npm run typecheck` pass. A task that adds a workflow also leaves the existing workflows passing.
- Do not call the API under test and do not run Playwright. Spec URL tests use a local `node:http` server.
- The library does not read `process.argv` or `process.env`. The CLI does.

## Starting point

`main` at `48e129e` contains `README.md` (`# auditor`), an Apache-2.0 `LICENSE`, and a Visual Studio `.gitignore`. There is no TypeScript, no package manifest, and no workflow. The Cloud Agent environment from "Set up auditor environment" only checks that those two files exist. Node on that image is v22.23.3. Details are in `docs/architecture.md` under "Repository starting point".

`CONTRIBUTING.md` landed with this refinement. Enforcement (`F-02`, `F-03`, `F-04`) has not landed, so until pull request 2 the convention is followed by hand.

## Counts

| Group | Tasks | Ids |
| --- | --- | --- |
| Foundation | 5 | `F-01` … `F-05` |
| Portfolio 1 | 29 | `P1-01` … `P1-29` |
| Portfolio 2 | 5 | `P2-01` … `P2-05` |
| Portfolio 3 | 3 | `P3-01` … `P3-03` |
| Total | 42 | |

The example project the launch needs is `P1-28`. It is counted once, in Portfolio 1, because the core proof depends on it. `P3-01` documents it. Portfolio 3 does not add a second example.

## Foundation

These land before product code so later commits and pull requests are checked.

### F-01. Scaffold the TypeScript workspace

- **Size:** M
- **Inputs:** the three tracked files on `main`. Node `>=22.19.0` (OQ-13). Package name default `@tuyenluong/auditor` (OQ-1).
- **Dependencies:** none
- **Outputs:**
  - Root `package.json` private, `"workspaces": ["packages/*"]`, `"engines": { "node": ">=22.19.0" }`, scripts `typecheck`, `test`, and `build` that forward to the workspace with `npm run <script> -w @tuyenluong/auditor`.
  - `packages/auditor/package.json` name `@tuyenluong/auditor`, version `0.0.0`, `"private": true`, `"type": "module"`, `"license": "Apache-2.0"`, same engines. Scripts: `typecheck` is `tsc --noEmit`, `test` is `vitest run`, `build` is `tsc -p tsconfig.build.json`. No `dependencies` yet.
  - `packages/auditor/tsconfig.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module` and `moduleResolution` `NodeNext`, `target` `ES2022`, `verbatimModuleSyntax`, `esModuleInterop`. `tsconfig.build.json` extends it, includes `src`, emits declarations and source maps to `dist`.
  - `packages/auditor/vitest.config.ts` with `passWithNoTests: true` and include `test/**/*.test.ts`.
  - `packages/auditor/src/index.ts` exporting an empty `export {}` so the build has an entry. No CLI import.
  - Dev dependencies at the auditor package: `typescript` `^7.0.2`, `vitest` `^5.0.5`, `@types/node` `^22.19.0`. `P1-08` moves `typescript` from `devDependencies` to `dependencies`. Until then it stays a dev dependency so `tsc` can run.
  - `package-lock.json` from `npm install`.
  - `.gitignore` replaced. Patterns: `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`, `.env`, `.env.*`, `.auditor/`, `*.log`, `.DS_Store`. Do not ignore `docs/` or `examples/`.
- **Acceptance check:** `npm ci && npm run typecheck && npm test && npm run build`. Expected: all four exit 0. `node -p "require('./packages/auditor/package.json').name"` is not used (the package is ESM). `node --input-type=module -e "import {readFileSync} from 'node:fs'; const p=JSON.parse(readFileSync('packages/auditor/package.json','utf8')); if(p.name!=='@tuyenluong/auditor'||p.version!=='0.0.0') process.exit(1)"` exits 0. `test ! -d node_modules/playwright && test ! -d node_modules/@playwright` exits 0.

### F-02. Add commitlint with config-conventional

- **Size:** S
- **Inputs:** Conventional Commits 1.0.0. Types and scopes in `CONTRIBUTING.md`. `@commitlint/cli`, `@commitlint/config-conventional`, `@commitlint/lint`, and `@commitlint/load` at `^21.2.4`.
- **Dependencies:** `F-01`
- **Outputs:**
  - Root dev dependencies on those four packages.
  - `commitlint.config.mjs` extends `@commitlint/config-conventional` and sets `type-enum` to `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `build`, `perf`. It sets `scope-enum` to `spec`, `playwright`, `rules`, `cli`, `eslint`, `examples`, `release`, `deps`, `repo`. It does not set `scope-empty`, so a missing scope stays valid. It does not add `style` or `revert` (OQ-12).
  - No other rule overrides. Subject case and header length stay on the preset defaults.
- **Acceptance check:** from the root, after `npm ci`:
  - `echo 'feat(spec): load openapi from a file' | npx commitlint` exits 0.
  - `echo 'feat: add a path matcher' | npx commitlint` exits 0.
  - `echo 'wip: stuff' | npx commitlint` exits 1.
  - `echo 'feat(nope): add a matcher' | npx commitlint` exits 1.
  - `echo 'style: format' | npx commitlint` exits 1.
  - `printf 'feat(spec)!: drop openapi 3.0\n\nBREAKING CHANGE: specs must be OpenAPI 3.1.\n' | npx commitlint` exits 0.

### F-03. Add a local commit-msg hook

- **Size:** S
- **Inputs:** the commitlint config from `F-02`.
- **Dependencies:** `F-02`
- **Outputs:**
  - `.githooks/commit-msg`, executable, containing `npx --no-install commitlint --edit "$1"`.
  - Root `package.json` script `"prepare": "git config core.hooksPath .githooks || true"`.
  - `CONTRIBUTING.md` already describes this. Do not contradict it.
- **Acceptance check:** `npm ci` (runs `prepare`). `git config --get core.hooksPath` prints `.githooks`. `echo 'wip: stuff' > /tmp/bad-msg.txt && .githooks/commit-msg /tmp/bad-msg.txt` exits 1. `echo 'docs(repo): add refined backlog' > /tmp/good-msg.txt && .githooks/commit-msg /tmp/good-msg.txt` exits 0. A real `git commit` in a throwaway clone of this repo with message `wip: stuff` exits non-zero and leaves the index uncommitted.

### F-04. Check pull request titles in CI

- **Size:** S
- **Inputs:** the same commitlint rules as `F-02`. GitHub event `pull_request` title.
- **Dependencies:** `F-02`
- **Outputs:**
  - `scripts/lint-pr-title.mjs`. It reads `PR_TITLE`, loads the root commitlint config through `@commitlint/load`, and lints that string with `@commitlint/lint` using the loaded rules and parser options. Empty `PR_TITLE` exits 2. Invalid title exits 1 and prints the commitlint problems to stderr. Valid title exits 0. It does not use `echo` to pipe the title.
  - Root script `"lint:pr-title": "node scripts/lint-pr-title.mjs"`.
  - `.github/workflows/pr-title.yml` on `pull_request` types `opened`, `edited`, `synchronize`, `reopened`. The job checks out, sets up Node 22, runs `npm ci`, then `npm run lint:pr-title` with `PR_TITLE` set from `github.event.pull_request.title`.
- **Acceptance check:** `PR_TITLE='docs(repo): add refined backlog' npm run lint:pr-title` exits 0. `PR_TITLE='Add backlog' npm run lint:pr-title` exits 1. `PR_TITLE='feat(nope): x' npm run lint:pr-title` exits 1. `PR_TITLE='' npm run lint:pr-title` exits 2. `grep -q lint:pr-title .github/workflows/pr-title.yml` exits 0.

### F-05. Run typecheck and unit tests in CI

- **Size:** S
- **Inputs:** the workspace scripts from `F-01`.
- **Dependencies:** `F-01`
- **Outputs:** `.github/workflows/ci.yml` on `push` and `pull_request`. One job, `ubuntu-latest`, Node 22, `npm ci`, `npm run typecheck`, `npm test`. It does not run the example yet (`P1-29` adds that). It does not publish.
- **Acceptance check:** `npm test` exits 0 on the scaffold. The workflow file contains `npm run typecheck` and `npm test` and does not contain `npm publish`. After the first feature PR, a green `ci` check on the pull request is the ongoing proof.

## Portfolio 1

Slice one. Playwright API tests against an OpenAPI 3.x spec. The engine is the library. The CLI wraps it.

### P1-01. Define the public result types

- **Size:** S
- **Inputs:** the type blocks in `docs/architecture.md` under "Core types" for `Finding`, `UnresolvedCall`, `UnresolvedReason`, `RuleId`, `Severity`, `CheckResult`, `CheckOptions`, `TestFileInput`, and `AuditorError`.
- **Dependencies:** `F-01`
- **Outputs:** `packages/auditor/src/types.ts`, `packages/auditor/src/errors.ts`, and exports from `src/index.ts`. No functions yet. `AuditorError` codes are `SPEC_NOT_FOUND`, `SPEC_INVALID`, `SPEC_FETCH`, `SPEC_PIN`, `NO_TESTS`, `CONFIG`, and `exitCode` is the literal `2`.
- **Acceptance check:** `npm run typecheck` exits 0. `packages/auditor/test/types.test.ts` constructs one `Finding` and one `UnresolvedCall` and expects `ruleId` and `reason` to reject a typo under `tsc`. A source test reads `src/index.ts` and fails if it matches `cli/`.

### P1-02. Define the spec model

- **Size:** S
- **Inputs:** `SpecModel`, `SpecOperation`, `SpecParameter`, `JsonSchema`, `HttpMethod` in `docs/architecture.md`.
- **Dependencies:** `P1-01`
- **Outputs:** those types in `packages/auditor/src/spec/model.ts`, exported from `src/index.ts`. No parser yet.
- **Acceptance check:** `npm run typecheck` exits 0. A fixture object in `test/spec/model.test.ts` assigns a `POST /orders` operation and expects `method` and `pathTemplate` to round-trip. Assigning `method: "HEAD"` typechecks. Assigning `method: "query"` does not.

### P1-03. Load a local OpenAPI 3.x file and resolve refs

- **Size:** M
- **Inputs:** a path to YAML or JSON. `@apidevtools/swagger-parser` `^13.1.0` and `openapi-types` `^12.1.3`. The `$ref` rules in `docs/architecture.md` under "Spec loading".
- **Dependencies:** `P1-02`
- **Outputs:**
  - `packages/auditor/src/spec/parse.ts` with `parseSpec(path, options) -> dereferenced document`.
  - Runtime dependencies on those two packages. Do not add `@playwright/test`. Do not move `typescript` in this task. `P1-08` does that.
  - Custom `$ref` resolver. Internal refs and relative files inside the spec directory resolve. Escaping relative refs and non-allowlisted URLs throw `AuditorError` `SPEC_INVALID`.
- **Acceptance check:** `npm test -- test/spec/parse.test.ts` exits 0. The test file covers all of the following, and each assertion is one `expect`:
  - A YAML fixture and a JSON fixture of the same 3.0.3 document both return `openapi === "3.0.3"`.
  - A 3.0.3 document with `$ref: "#/components/schemas/Order"` on a response schema loads, and the dereferenced response has `properties.sku`.
  - A minimal 3.1.0 document (`openapi: 3.1.0`, one `GET /health` returning 200) loads. If swagger-parser 13.1.0 rejects that document, stop and replace the parser. Do not skip the test.
  - `swagger: "2.0"` throws `SPEC_INVALID` and the message starts with `Expected OpenAPI 3.x`.
  - A file that is not YAML or JSON throws `SPEC_INVALID` and the message starts with `Spec is not valid YAML or JSON`.
  - A missing path throws `SPEC_NOT_FOUND`.
  - `$ref: "../../../etc/passwd"` throws `SPEC_INVALID` and does not contain the file's contents in the error.

### P1-04. Map a dereferenced document into SpecModel

- **Size:** M
- **Inputs:** the object returned by `P1-03`. Mapping rules for `allOf`, `oneOf`, `anyOf`, and servers in "Spec loading".
- **Dependencies:** `P1-03`
- **Outputs:** `packages/auditor/src/spec/model.ts` function `toSpecModel(doc, source) -> SpecModel`. Operations cover every path and every HTTP method key. Parameters from the path item and the operation are concatenated, operation parameters overriding path parameters of the same `name` and `in`. Request body and responses keep media-type to schema maps. `allOf` is merged. Conflicting `allOf` types throw `SPEC_INVALID`.
- **Acceptance check:** `npm test -- test/spec/model.test.ts` exits 0. Fixture `orders.openapi.yaml` (the example contract's three operations, including the `#/components/schemas/Order` ref) maps to three operations. `POST /orders` request body is required and its schema `required` array contains `sku` and `qty`. `GET /orders/{id}` responses include `200` and `404`. `GET /orders` has required query parameter `limit`. A fixture whose `allOf` members set `type: string` and `type: integer` on the same schema throws `SPEC_INVALID`.

### P1-05. Fetch a spec URL with an allowlist and an auth header

- **Size:** M
- **Inputs:** `CheckOptions.allowHosts` and `specAuthHeader`. Fetch rules in "URL fetch and pins". Global `fetch`. No env reads inside the library.
- **Dependencies:** `P1-03`
- **Outputs:** `packages/auditor/src/spec/fetch.ts` with `fetchSpec(url, options) -> { bytes, contentType }`. `parse.ts` accepts those bytes the same way it accepts a file. `https:` URLs and `http://127.0.0.1` / `http://localhost` only.
- **Acceptance check:** `npm test -- test/spec/fetch.test.ts` exits 0. The test starts a `node:http` server on `127.0.0.1` and checks:
  - A fetch with `allowHosts: ["127.0.0.1"]` and `specAuthHeader: "Bearer secret"` sends `Authorization: Bearer secret` and the parsed document matches the served JSON.
  - The same URL with `allowHosts: []` throws `SPEC_FETCH` and the message contains `not allowlisted`. The server sees no request.
  - A redirect `Location` pointing at a second host not in the allowlist throws `SPEC_FETCH` and the second server sees no request.
  - `http://example.com/openapi.yaml` throws `SPEC_FETCH` even if `example.com` is allowlisted.
  - A body larger than 5 MiB throws `SPEC_FETCH`.

### P1-06. Pin a fetched spec and record the source

- **Size:** M
- **Inputs:** raw bytes from `P1-05`. Pin rules in "URL fetch and pins". Source words `file`, `live`, `pinned`.
- **Dependencies:** `P1-05`
- **Outputs:** `packages/auditor/src/spec/pin.ts` and `packages/auditor/src/spec/load.ts`. `loadSpec(location, options) -> { model inputs, source, location }`. `savePin(path, bytes, meta)` writes the bytes and `<path>.meta.json` with `url`, `fetchedAt` (ISO-8601), `sha256`, `openapi`, `version`, and `title`. `pinPath` reads the file and does not call `fetch`. `savePinPath` without a URL location throws `SPEC_PIN` with message `--save-pin requires --spec to be a URL` (the library uses that message even though it has no `--spec` flag, so the CLI can print it unchanged). When `pinPath` is set it wins over `location`.
- **Acceptance check:** `npm test -- test/spec/pin.test.ts` exits 0.
  - Save then load against the local server: the second load does not connect (close the server before the pin load). `source` is `pinned`. The sidecar `sha256` matches the bytes.
  - A missing pin throws `SPEC_PIN` and the message starts with `Pinned spec not found:`.
  - A file path load reports `source` `file` and does not read the environment.

### P1-07. Define the extracted-call model

- **Size:** S
- **Inputs:** `ExtractedCall`, `ResponseExpectation`, `JsonFieldAccess`, `Assertion`, `JsonValue`, `Literal` in `docs/architecture.md`.
- **Dependencies:** `P1-01`
- **Outputs:** `packages/auditor/src/playwright/model.ts` exporting those types from `src/index.ts`.
- **Acceptance check:** `npm run typecheck` exits 0. `test/playwright/model.test.ts` builds one call with a resolved path and one with `unresolved: [{ reason: "helper-call", ... }]` and expects the unresolved reason type to reject `"guessed"`.

### P1-08. Extract literal Playwright request calls

- **Size:** M
- **Inputs:** test file text. Recognition rules in "Playwright extraction" for receivers, methods, `fetch` method, and `outside-test`. No constant folding yet (`P1-09`). No expectations yet (`P1-12`).
- **Dependencies:** `P1-07`
- **Outputs:** `packages/auditor/src/playwright/extract.ts` with `extractCalls(file) -> ExtractedCall[]`. Move `typescript` `^7.0.2` from `devDependencies` to `dependencies`. Extensions and script kinds as in the architecture. JSX files are not parsed by this function. The CLI skip behavior is `P1-26`.
- **Acceptance check:** `npm test -- test/playwright/extract.test.ts` exits 0. Fixtures are `.ts` and `.js` source strings, not executed:
  - `test('a', async ({ request }) => { await request.post('/orders', { data: { sku: 'a' } }) })` yields one call, method `post`, path `/orders`, body `{ sku: "a" }`, line of the `request.post` call.
  - Rename `{ request: api }` then `api.get('/orders')` yields method `get`.
  - `import { request } from '@playwright/test'; const ctx = await request.newContext(); await ctx.delete('/orders/1')` yields method `delete`.
  - `request.fetch('/orders', { method: 'HEAD' })` yields `head`. `fetch` with no method yields `get`. `fetch` with `method: variable` yields an unresolved call reason `non-literal-method` and no method.
  - `request.post(buildUrl())` with a function declaration in the file yields unresolved `helper-call`.
  - `data: formData` where the argument uses `form:` yields `form-body` (OQ-7). `data: '{"a":1}'` yields `raw-string-body`.
  - A call at module scope yields `outside-test`.
  - `params: { limit: 1 }` and URL `'/orders?foo=2'` both appear in `query`.

### P1-09. Resolve same-file constants

- **Size:** M
- **Inputs:** the constant rules and depth limit in "Playwright extraction".
- **Dependencies:** `P1-08`
- **Outputs:** `packages/auditor/src/playwright/constants.ts`, used by `extract.ts` before the call is returned. Depth limit 10.
- **Acceptance check:** `npm test -- test/playwright/constants.test.ts` exits 0.
  - `const PATH = '/orders'; request.get(PATH)` resolves path `/orders`.
  - `const id = '1'; request.get(\`/orders/${id}\`)` resolves path `/orders/1`.
  - `const body = { sku: 'a', qty: 1 }; request.post('/orders', { data: body })` resolves the body.
  - `'/orders' + '/1'` resolves path `/orders/1`.
  - An imported `PATH` yields `imported-value` and does not read the other file.
  - A `let` assigned twice yields `ambiguous-constant`.
  - A spread in the object yields `spread`.
  - A cycle of two consts yields `ambiguous-constant` and finishes (no infinite loop).

### P1-10. Read playwright.config baseURL and strip it

- **Size:** M
- **Inputs:** config search and strip algorithm in "baseURL and servers". `SpecModel.servers` may be passed in once `P1-04` exists; this task accepts `servers: readonly string[]` as an argument so it can be tested without the matcher.
- **Dependencies:** `P1-09`
- **Outputs:** `packages/auditor/src/playwright/config.ts` with `readBaseURL(path) -> string | undefined` and `stripBase(url, bases) -> string`. A non-literal `baseURL` returns `undefined` and the caller prints the stderr sentence from the architecture. That print stays in the CLI (`P1-26`); this module returns a discriminant `{ literal: false }`.
- **Acceptance check:** `npm test -- test/playwright/config.test.ts` exits 0.
  - `export default defineConfig({ use: { baseURL: 'http://127.0.0.1:3000' } })` with `defineConfig` imported from `@playwright/test` reads that URL. The CommonJS `module.exports = { use: { baseURL } }` form reads it too.
  - `baseURL: process.env.BASE_URL` returns the non-literal discriminant.
  - `stripBase('http://127.0.0.1:3000/orders?limit=1', ['http://127.0.0.1:3000'])` returns `/orders` and the query is available separately as `limit=1`.
  - `stripBase('/orders/1', [...])` returns `/orders/1`.
  - A server base `https://api.example.com/v1` strips `https://api.example.com/v1/orders` to `/orders`.

### P1-11. Match calls to operations by method and path template

- **Size:** M
- **Inputs:** a checked call's method and stripped path, and `SpecModel.operations`. Template rules in "Path templates".
- **Dependencies:** `P1-04`, `P1-10`
- **Outputs:** `packages/auditor/src/playwright/match.ts` with `matchOperation(call, spec) -> { operation } | { ambiguous: true } | { operation: undefined, concretePath: string, allowedMethods?: string[] }`. Template literals with one expression per dynamic segment match `{param}` regardless of the identifier's name. Decoding and trailing-slash rules apply.
- **Acceptance check:** `npm test -- test/playwright/match.test.ts` exits 0.
  - `GET /orders/1` matches `GET /orders/{id}` and not `GET /orders`.
  - `` GET `/orders/${orderId}` `` after constant resolution of a non-literal identifier still matches `GET /orders/{id}` when the segment is dynamic. A fully unresolved URL never reaches this function (`P1-08` already marked it unresolved).
  - `GET /orders/1/` matches the same template.
  - `POST /orders/1` against a spec that only has `GET /orders/{id}` returns `allowedMethods: ["GET"]`.
  - `POST /nope` returns no operation and concrete path `/nope`.
  - Two templates that both match produce `{ ambiguous: true }`.

### P1-12. Extract expected statuses

- **Size:** M
- **Inputs:** expectation table in "Expectations", rows for `status()`, `ok()`, and ranges. OQ-5 and OQ-14.
- **Dependencies:** `P1-09`
- **Outputs:** `packages/auditor/src/playwright/expectations.ts` filling `ExtractedCall.expectations`. Status numbers and `2xx` only in this task. Field paths and assertions can be empty arrays until `P1-13` and `P1-14`.
- **Acceptance check:** `npm test -- test/playwright/expectations.status.test.ts` exits 0.
  - `const res = await request.get('/orders/1'); expect(res.status()).toBe(200)` records status `200` on that call, at the `expect` line.
  - `expect(res.ok()).toBe(true)` records `2xx`.
  - `expect(res.ok()).toBe(false)` adds unresolved `negative-ok` and records no status.
  - `expect(res.status()).toBe(CREATED)` with `const CREATED = 201` records `201`.
  - `expect(res.status()).toBeGreaterThanOrEqual(200)` adds `status-range` and records no status.
  - Two assignments to `res` add `reassigned-response` and no expectations.
  - An `expect` inside `if (false)` is still collected (OQ-14).

### P1-13. Extract response JSON field paths

- **Size:** M
- **Inputs:** the `res.json()` rows of the expectation table.
- **Dependencies:** `P1-12`
- **Outputs:** field accesses on the expectation: member access, string literal index, numeric literal index. Computed indexes add `computed-key` and omit that access.
- **Acceptance check:** `npm test -- test/playwright/expectations.fields.test.ts` exits 0.
  - `const body = await res.json(); body.items[0].sku` records path `["items", 0, "sku"]`.
  - `expect((await res.json()).id)` records path `["id"]`.
  - `body[key]` records `computed-key` and no field access for that expression.
  - A field read on a different variable is ignored.

### P1-14. Extract literal assertions and expect.any types

- **Size:** M
- **Inputs:** the assertion rows of the expectation table. `toBe`, `toEqual`, `toStrictEqual`, `toMatchObject`, `expect.any(String|Number|Boolean|Object|Array)`.
- **Dependencies:** `P1-13`
- **Outputs:** `Assertion` records on the expectation. Nested object and array literals become assertions on dotted paths. `toBeDefined` and `toContain` produce no assertion.
- **Acceptance check:** `npm test -- test/playwright/expectations.assert.test.ts` exits 0.
  - `expect(body.status).toBe('cancelled')` is a literal assertion `"cancelled"` at path `["status"]`.
  - `expect(body.qty).toBe('1')` is literal `"1"` (a string).
  - `expect(body.id).toEqual(expect.any(String))` is a type assertion `string`.
  - `expect(body).toMatchObject({ id: expect.any(String), qty: 1 })` yields two assertions.
  - `expect(body.id).toBeDefined()` yields no assertion.

### P1-15. Extract Content-Type assertions

- **Size:** S
- **Inputs:** the headers row of the expectation table.
- **Dependencies:** `P1-12`
- **Outputs:** `contentTypes` on the expectation from `res.headers()['content-type']` and `res.headers()["Content-Type"]` compared later case-insensitively. The stored value keeps the source spelling.
- **Acceptance check:** `npm test -- test/playwright/expectations.content-type.test.ts` exits 0. `expect(res.headers()['content-type']).toBe('text/plain')` records `text/plain`. `expect(res.headers()['content-type']).toContain('json')` records nothing. A non-literal expected value adds `non-literal-header` and records no content type.

### P1-16. Rule auditor/unknown-operation

- **Size:** S
- **Inputs:** match result from `P1-11`. Messages in the rules table. Severity `error`. Finding points at the call.
- **Dependencies:** `P1-11`
- **Outputs:** `packages/auditor/src/rules/unknown-operation.ts` exporting a pure function `(call, match) -> Finding[]`. Ambiguous matches return no finding (the unresolved record is the matcher's job, attached in `P1-25`).
- **Acceptance check:** `npm test -- test/rules/unknown-operation.test.ts` exits 0.
  - `DELETE` against `GET /orders/{id}` produces one finding whose message is `No DELETE /orders/{id} in the spec. Spec allows GET.`
  - `POST /nope` produces `No POST /nope in the spec.`
  - A matched `GET /orders/{id}` produces no finding.
  - File, line, and column equal the call fixture.

### P1-17. Rule auditor/unknown-body-field and the schema walker

- **Size:** M
- **Inputs:** OQ-4, the did-you-mean algorithm, nested objects and arrays. Messages in the rules table.
- **Dependencies:** `P1-11`, `P1-09`
- **Outputs:**
  - `packages/auditor/src/schema/fields.ts` with `knownProperties`, `requiredProperties`, `locate`, and `suggest`.
  - `packages/auditor/src/rules/unknown-body-field.ts`. Media type selection as in the architecture. A spread skips nothing about explicit unknown keys.
- **Acceptance check:** `npm test -- test/rules/unknown-body-field.test.ts` exits 0.
  - Body `{ sku: 'a', qtx: 1 }` against the orders POST schema produces one finding for `qtx`, `suggestion` `qty`, message ending `Did you mean "qty"?`.
  - Body `{ sku: 'a', qty: 1, note: 'n' }` produces no finding (`note` is known).
  - A schema with `additionalProperties: true` and an extra key produces no finding (OQ-4).
  - A schema that omits `additionalProperties` and has an extra key produces a finding.
  - Two equally close names produce a finding with no `suggestion` and no hint sentence.
  - `SKU` against property `sku` suggests `sku`.
  - A same-file const body is resolved before the rule, covered by one fixture that goes through `extractCalls`.

### P1-18. Rule auditor/missing-required-body-field

- **Size:** S
- **Inputs:** `requiredProperties` from `P1-17`. Parent-before-child rule in the architecture.
- **Dependencies:** `P1-17`
- **Outputs:** `packages/auditor/src/rules/missing-required-body-field.ts`. A spread on the object records no missing-required findings for that object.
- **Acceptance check:** `npm test -- test/rules/missing-required-body.test.ts` exits 0.
  - `{ qty: 1 }` produces one finding `Required body field "sku" is missing for POST /orders.`
  - `{ sku: 'a', qty: 1 }` produces none.
  - A missing parent object produces one finding for the parent and none for its required children.
  - The clean body from a const produces none.

### P1-19. Rules auditor/unknown-param and auditor/missing-required-param

- **Size:** M
- **Inputs:** OQ-8. Query keys from the URL and from `params`. Hint algorithm reused from `suggest`.
- **Dependencies:** `P1-11`
- **Outputs:** `packages/auditor/src/rules/params.ts` exporting both rules. Path parameters of a matched template are not reported missing. Header and cookie parameters are ignored.
- **Acceptance check:** `npm test -- test/rules/params.test.ts` exits 0.
  - `GET /orders` with no query produces `Required query parameter "limit" is missing for GET /orders.`
  - `params: { limit: 1, foo: 'x' }` produces `Unknown query parameter "foo" for GET /orders.` and no suggestion.
  - `params: { limt: 1 }` produces the unknown-param finding with suggestion `limit` and the missing-required finding for `limit`.
  - `GET /orders?limit=1` produces no finding.
  - A matched `GET /orders/{id}` produces no missing path parameter finding.
  - An unknown header in `headers` produces no finding.

### P1-20. Rule auditor/undocumented-status

- **Size:** S
- **Inputs:** status matching rules, including ranges and `default`.
- **Dependencies:** `P1-11`, `P1-12`
- **Outputs:** `packages/auditor/src/rules/undocumented-status.ts`. One finding per expected status that fails the match. Point at the `expect`.
- **Acceptance check:** `npm test -- test/rules/undocumented-status.test.ts` exits 0.
  - Expected `418` against `200` and `404` produces `Expected status 418 is not documented for GET /orders/{id}. Documented statuses: 200, 404.`
  - Expected `200` produces none.
  - Expected `2xx` when a `200` exists produces none.
  - Expected `201` when the only success entry is `2XX` produces none.
  - A `default` response produces none for `418`.
  - A call with no expectations produces none.

### P1-21. Resolve a response field path to a schema

- **Size:** M
- **Inputs:** schema choice rules in "Rules and messages" (status, `2xx` ambiguity OQ-6, content type fallback). `locate` from `P1-17`.
- **Dependencies:** `P1-04`, `P1-13`, `P1-17`
- **Outputs:** `chooseResponseSchema(operation, expectation) -> { schema, status, mediaType } | { unresolved: UnresolvedReason }` in `src/schema/fields.ts`.
- **Acceptance check:** `npm test -- test/schema/response-schema.test.ts` exits 0.
  - Status `200` and a single `application/json` schema locates `["status"]` as the enum schema.
  - `["nope"]` returns not found.
  - `["items", 0, "sku"]` locates the array item's `sku`.
  - Two 2xx responses with different schemas and an expectation of `2xx` return `ambiguous-response-schema`.
  - Two content types and no asserted content type, neither of them `application/json`, return `ambiguous-content-type`.

### P1-22. Rule auditor/unknown-response-field

- **Size:** S
- **Inputs:** `P1-21` and the unknown-response-field message.
- **Dependencies:** `P1-21`
- **Outputs:** `packages/auditor/src/rules/unknown-response-field.ts`. A path that fails `locate` is one finding. An ambiguous schema produces no finding.
- **Acceptance check:** `npm test -- test/rules/unknown-response-field.test.ts` exits 0. Field `nope` on the 200 order schema produces `Response field "nope" is not in the 200 application/json schema for GET /orders/{id}.` Field `sku` produces none. A request-only call produces none.

### P1-23. Rule auditor/asserted-value

- **Size:** M
- **Inputs:** literal and `expect.any` compatibility rules, including integer, nullable, and 3.1 null in a type array.
- **Dependencies:** `P1-14`, `P1-21`
- **Outputs:** `packages/auditor/src/rules/asserted-value.ts`. Message shape `Assertion {shown} conflicts with schema {type or enum} at "{dotted}" for {METHOD} {path}.` `{shown}` is the JSON literal or `expect.any(Number)` style with the constructor name.
- **Acceptance check:** `npm test -- test/rules/asserted-value.test.ts` exits 0.
  - `toBe('cancelled')` against enum `pending|shipped` produces a finding whose message contains `cancelled` and `pending`.
  - `toBe('pending')` produces none.
  - `toBe('1')` against `integer` produces a finding. `toBe(1)` produces none. `toBe(1.5)` produces a finding.
  - `expect.any(Number)` against `integer` produces none. `expect.any(String)` against `integer` produces a finding.
  - `toBe(null)` against `{ type: 'string', nullable: true }` produces none. The same assertion against `{ type: 'string' }` produces a finding.
  - No expectations produces none.

### P1-24. Rule auditor/content-type

- **Size:** S
- **Inputs:** media type comparison ignoring parameters.
- **Dependencies:** `P1-15`, `P1-11`
- **Outputs:** `packages/auditor/src/rules/content-type.ts`. Compare against the content keys of the status chosen the same way as `P1-21`. A `2xx` expectation with one 2xx response uses that response's content types.
- **Acceptance check:** `npm test -- test/rules/content-type.test.ts` exits 0.
  - Expected `text/plain` against `application/json` produces `Expected Content-Type "text/plain" is not documented for status 200 on GET /orders/{id}. Documented: application/json.`
  - Expected `application/json; charset=utf-8` against `application/json` produces none.
  - Expected `application/json` produces none.
  - No content-type assertion produces none.

### P1-25. Library check orchestration and summary

- **Size:** M
- **Inputs:** `check` signature, summary definitions, sort and dedupe, and the "library does not import the CLI" rule.
- **Dependencies:** `P1-06`, `P1-16`, `P1-18`, `P1-19`, `P1-20`, `P1-22`, `P1-23`, `P1-24`
- **Outputs:** `check` implemented in `packages/auditor/src/check.ts` and re-exported from `src/index.ts`. It loads the spec, reads each test file from disk when `text` is omitted and uses `text` when present, reads `baseURL` unless `options.baseURL` is set or `playwrightConfigPath` is `null`, extracts, matches, runs every rule that is not `off`, and returns `CheckResult`. Duplicate findings are removed. Default rule severity is `error`.
- **Acceptance check:** `npm test -- test/check.test.ts` exits 0.
  - A fixture spec plus one clean test file returns `summary.findings === 0` and `summary.unresolved === 0`.
  - The same spec plus a test that only calls `POST /nope` returns one `auditor/unknown-operation` finding and `summary.checked === 1`.
  - A test with a valid POST and no `expect` returns no response-rule ids.
  - A helper URL returns `summary.unresolved === 1` and no findings.
  - `rules: { 'auditor/unknown-operation': 'off' }` drops that finding.
  - `testFiles: []` throws `NO_TESTS`.
  - `git grep -n "cli/" packages/auditor/src -- ':!packages/auditor/src/cli'` exits 1 (no matches). `check` is a function export. The test imports `check` from `../src/index.ts`.

### P1-26. CLI check command, help, and exit codes

- **Size:** M
- **Inputs:** the CLI section of the architecture. `node:util` `parseArgs`. Env var read only in the CLI.
- **Dependencies:** `P1-25`
- **Outputs:**
  - `packages/auditor/src/cli/main.ts` and `src/cli/args.ts`. Binary `auditor` via `package.json` `bin`, shebang `#!/usr/bin/env node`.
  - Flags listed in the architecture. `--tests` repeatable. Glob via `fs.promises.glob`, ignoring `node_modules` and `dist`. JSX files skipped with `skip jsx: {path}` on stderr.
  - Fixtures `packages/auditor/test/cli/fixtures/mini.openapi.yaml` (`GET /health` → 200), `clean.spec.ts` (`request.get('/health')`), and `missing.spec.ts` (`request.post('/missing')`).
  - Exit codes 0, 1, and 2 as in the table. Help on stdout for `--help`, on stderr for no args and unknown flags.
  - `--spec-auth-env` defaults to `AUDITOR_SPEC_TOKEN`. Header formatting (`Bearer` prefix rules) happens here.
  - Non-literal Playwright `baseURL` prints `playwright baseURL is not a literal; URLs were not rewritten.` on stderr and still exits from findings.
- **Acceptance check:** build, then `node packages/auditor/dist/cli/main.js --help` exits 0 and stdout contains `--spec` and `--allow-host`. `node packages/auditor/dist/cli/main.js` exits 2. `node packages/auditor/dist/cli/main.js check --spec missing.yaml --tests 'nope/**/*.ts'` exits 2 and stderr contains `Spec file not found:`. `node packages/auditor/dist/cli/main.js check --spec packages/auditor/test/cli/fixtures/mini.openapi.yaml --tests 'packages/auditor/test/cli/fixtures/clean.spec.ts'` exits 0. The same command with `missing.spec.ts` exits 1. `AUDITOR_SPEC_TOKEN=secret` against the local server with `--allow-host 127.0.0.1` sends `Bearer secret` (asserted by the server). Unset token sends no `Authorization` header.

### P1-27. Text and JSON formatters

- **Size:** S
- **Inputs:** the text layout and `JsonReport` in the CLI section.
- **Dependencies:** `P1-26`
- **Outputs:** `src/cli/format-text.ts` and `src/cli/format-json.ts`. `--format text` is the default. `--format json` writes only JSON to stdout. Errors stay on stderr as text for both formats.
- **Acceptance check:** `npm test -- test/cli/format.test.ts` exits 0.
  - Text output for a result with one finding and one unresolved call equals the layout: five summary lines (`spec:`, `checked:`, `unresolved:`, `partial:`, `findings:`), a blank line, `file:line:column ruleId message`, a blank line, `unresolved:`, then the unresolved line.
  - A clean result has `findings: 0` and no `unresolved:` block.
  - JSON output parses, and `summary`, `findings[0].ruleId`, and `spec.source` match the input result.
  - CLI `--format json` on a usage error exits 2 and stdout is empty.

### P1-28. Example orders project

- **Size:** M
- **Inputs:** the example contract in `docs/architecture.md`, including the operation table and the clean and broken call tables. `@playwright/test` as a devDependency of `@tuyenluong/auditor` (types only).
- **Dependencies:** `P1-27`
- **Outputs:**
  - `examples/orders/openapi.yaml`, `examples/orders/playwright.config.ts`, `examples/orders/tsconfig.json`, `examples/orders/tests/clean.spec.ts`, `examples/orders/tests/broken.spec.ts`.
  - Root script `example` that builds the CLI, runs `tsc -p examples/orders --noEmit`, runs the CLI on the clean suite, runs the CLI on the broken suite, and exits 0 only when clean exits 0, broken exits 1, and the broken stdout contains the summary counts and every rule id.
  - The library `dependencies` do not include `@playwright/test`. It is a `devDependency`.
- **Acceptance check:** `npm run example` exits 0. Clean stdout contains `findings: 0` and `unresolved: 0`. Broken stdout contains `checked: 13`, `unresolved: 1`, `findings: 14`, `Did you mean "qty"?`, `Did you mean "limit"?`, and each of the nine rule ids. `npm run example` does not start Playwright (no `playwright test` process; the script's source does not contain `playwright test`). `git grep @playwright/test packages/auditor/src` finds nothing.

### P1-29. Run the example in CI

- **Size:** S
- **Inputs:** `F-05` workflow and the `example` script.
- **Dependencies:** `P1-28`, `F-05`
- **Outputs:** `.github/workflows/ci.yml` gains `npm run example` after `npm test`. Still no publish step.
- **Acceptance check:** `npm run example` exits 0 locally. The workflow file contains `npm run example` and does not contain `npm publish`.

## Portfolio 2

Deeper Playwright support. Starts only after slice one is proven (`P1-25` at minimum, and the measurement task after the example). The ESLint rule is the first slice-two pull request.

### P2-01. ESLint rule auditor/request-matches-spec

- **Size:** M
- **Inputs:** the ESLint boundary section. `check` from `P1-25`.
- **Dependencies:** `P1-25`
- **Outputs:**
  - Workspace package `packages/eslint-plugin`, name `@tuyenluong/eslint-plugin-auditor`, `"private": true`, peer dependency `eslint` `^9`, dependency on the auditor package via the workspace.
  - Rule id `auditor/request-matches-spec`. Option `spec` is a filesystem path, required. Option `reportUnresolved` defaults to `false`.
  - The rule calls `check({ spec: { location }, testFiles: [{ path: filename, text: source }], options: { playwrightConfigPath: null } })`. It maps each error finding to an ESLint message at the finding's line and column. It does not import `src/cli`. It does not spawn a process.
- **Acceptance check:** `npm test -w @tuyenluong/eslint-plugin-auditor` exits 0. One RuleTester case with a `POST /nope` call reports `auditor/unknown-operation`. One case with a clean call reports no messages. One case with `request.post(buildUrl())` reports no messages when `reportUnresolved` is omitted, and reports one warning whose text contains `helper-call` when `reportUnresolved: true`.

### P2-02. RuleTester fixtures for every slice-one rule

- **Size:** S
- **Inputs:** the nine rule ids and one broken snippet each, taken from the example contract.
- **Dependencies:** `P2-01`
- **Outputs:** RuleTester cases in the plugin package, one valid case (the clean POST) and one invalid case per rule id. The invalid message contains that rule id.
- **Acceptance check:** `npm test -w @tuyenluong/eslint-plugin-auditor` exits 0 and the test file mentions each of the nine rule ids.

### P2-03. Resolve imported constants across files

- **Size:** M
- **Inputs:** same-file resolver from `P1-09`. Imports are static `import` or `require` of a relative path inside the project. One hop is required. Re-exports count as one extra hop, then stop.
- **Dependencies:** `P1-09`, `P1-25`
- **Outputs:** `packages/auditor/src/playwright/imports.ts`. An imported const that is a string, number, boolean, `null`, or an object or array of those resolves. An imported function does not resolve here (`P2-04`). A package import (`@playwright/test`, anything not starting with `.`) stays `imported-value`.
- **Acceptance check:** `npm test -- test/playwright/imports.test.ts` exits 0. `import { PATH } from './paths'` where `paths.ts` exports `export const PATH = '/orders'` resolves `request.get(PATH)` to `/orders` and the call is checked. `import { PATH } from 'some-pkg'` stays unresolved `imported-value`. A cycle of re-exports finishes and stays unresolved `ambiguous-constant`.

### P2-04. Resolve one-level helper returns

- **Size:** M
- **Inputs:** `P2-03`. A helper is a function declaration or arrow in the same file or an imported relative module. It qualifies only when it has a single return of a literal, template, object, or array, and every parameter use is a parameter identifier replaced by the call-site argument when that argument itself resolves. No loops, no second call, no `if`.
- **Dependencies:** `P2-03`
- **Outputs:** helper folding inside the extractor. Helpers that do not qualify stay `helper-call`.
- **Acceptance check:** `npm test -- test/playwright/helpers.test.ts` exits 0.
  - `function buildUrl(){ return '/orders' }` then `request.post(buildUrl())` is checked as `POST /orders`.
  - `const order = (sku) => ({ sku, qty: 1 })` then `data: order('a')` resolves the body.
  - A helper that calls `fetch` stays `helper-call`.
  - A helper with two return statements stays `helper-call`.

### P2-05. Measure the unresolved rate on a pinned suite

- **Size:** M
- **Inputs:** OQ-11. `check` after `P2-04`. The orders example from `P1-28`.
- **Dependencies:** `P2-04`, `P1-28`
- **Outputs:**
  - `packages/auditor/src/cli` subcommand is not required. A script `npm run unresolved-rate -- <dir>` prints `checked`, `unresolved`, `partial`, and `unresolvedRate` (unresolved divided by checked plus unresolved, to four decimal places).
  - `docs/unresolved-baseline.md` records the date, the `microsoft/playwright` commit SHA that was checked out, the glob `**/*.{spec,test}.ts`, the counts before this slice (extractor from `P1-25`'s behavior, measured by running the script on a temporary build that does not use import or helper folding — implement that as `--no-cross-file`), and the counts after `P2-04`. It also records the orders example rate, which is 0 unresolved on the clean suite.
- **Acceptance check:** `npm run unresolved-rate -- examples/orders/tests/clean.spec.ts --spec examples/orders/openapi.yaml` prints `unresolved: 0` and exits 0. The baseline doc contains both the before and after numbers for the pinned Playwright checkout, and the after unresolved count is less than or equal to the before count. If the checkout contains zero `request.get/post/put/patch/delete/fetch` calls, the script exits 2 and the doc says the suite was rejected. Do not invent a rate. Pick a different pinned SHA in that case and write the SHA that was actually measured.

## Portfolio 3

What the repository needs in order to ship slice one as open source. These tasks do not publish to npm and do not post anywhere. Community posts and the one-month watch of stars and issues stay with Tuyen. They are not tasks.

The example project is `P1-28`.

### P3-01. README with install, usage, sample output, and limits

- **Size:** M
- **Inputs:** the text formatter output of the orders example. The "Not supported in slice one" list. Apache-2.0 license already at `LICENSE`.
- **Dependencies:** `P1-28`
- **Outputs:** replace `README.md`. Sections, in order: one-paragraph description (static checker, does not run tests or call the API), install line `npm install -D @tuyenluong/auditor`, CLI usage copied from `--help`, a "Sample" section whose fenced block is the text report of `examples/orders/tests/broken.spec.ts`, and "Not supported yet" copied from the architecture list. Link `CONTRIBUTING.md`, `docs/architecture.md`, and `docs/backlog.md`.
- **Acceptance check:** `npm run example` exits 0. `packages/auditor/test/readme.test.ts` runs the CLI on the broken suite and fails if `README.md` does not contain that stdout. The README contains the headings `Sample` and `Not supported yet` and does not claim the tool executes Playwright.

### P3-02. npm package metadata for a later publish

- **Size:** S
- **Inputs:** OQ-1. The library exports and the `auditor` bin from `P1-26`. Version `0.0.0` from `F-01`.
- **Dependencies:** `F-01`, `P1-26`
- **Outputs:** `packages/auditor/package.json` gains `description` (`Static checker that compares Playwright API tests with an OpenAPI 3.x spec`), `license` `Apache-2.0`, `repository` `github:tuyenluong/auditor`, `bugs` URL, `keywords` including `openapi` and `playwright`, `files` limited to `dist`, `engines` unchanged, `exports` of `.` to `dist/index.js` with types, `bin.auditor` pointing at `dist/cli/main.js`, `"sideEffects": false`, and `publishConfig.access` `public`. `"private": false`. The root workspace stays private. No `npm publish` script that runs on its own. No `.npmrc` token.
- **Acceptance check:** `npm run build -w @tuyenluong/auditor` exits 0. `npm pack -w @tuyenluong/auditor --dry-run` exits 0 and the file list contains `dist/index.js` and `dist/cli/main.js` and does not contain `test/` or `src/`. `node --input-type=module -e "import {check} from '@tuyenluong/auditor'"` is not required to succeed from the root without a build install. Instead, `node --input-type=module -e "import * as m from './packages/auditor/dist/index.js'; if (typeof m.check !== 'function') process.exit(1)"` exits 0.

### P3-03. Release Please workflow with a manual npm approval

- **Size:** M
- **Inputs:** Conventional Commits from `F-02`. Package metadata from `P3-02`. Release Please action v4 manifest mode. OQ-10. The release flow section of the architecture.
- **Dependencies:** `F-02`, `P3-02`
- **Outputs:**
  - `release-please-config.json` with `$schema` `https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json`, package path `packages/auditor`, `release-type` `node`, `changelog-path` `CHANGELOG.md`, `bump-minor-pre-major` true, `bump-patch-for-minor-pre-major` true.
  - `.release-please-manifest.json` with `"packages/auditor": "0.0.0"`.
  - `packages/auditor/CHANGELOG.md` containing a heading and one sentence that Release Please maintains the file.
  - `.github/workflows/release-please.yml` on `push` to `main` only. Permissions `contents: write` and `pull-requests: write`. One job using `googleapis/release-please-action@v4` with `config-file` and `manifest-file`. No `npm publish`, no `NPM_TOKEN`.
  - `.github/workflows/npm-publish.yml` on `workflow_dispatch` only, with a required string input `tag`. Job `environment: npm`. Steps: checkout that tag, setup Node 22, `npm ci`, `npm test`, `npm run build`, `npm publish --provenance --access public` in `packages/auditor` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. No `push`, `release`, or `workflow_run` trigger.
  - `scripts/check-release-workflows.mjs` and root script `check:release` that fails if `npm publish` appears in any workflow other than `npm-publish.yml`, if that file's `on` keys are anything other than `workflow_dispatch`, or if its job is missing `environment: npm`.
  - `docs/releasing.md` stating that merging the release PR tags the repo and does not publish, that a repo admin must create the GitHub environment `npm` with required reviewers before the first publish, and that running the workflow is out of scope for the task that adds the file.
- **Acceptance check:** `npm run check:release` exits 0. `grep -R "npm publish" .github/workflows` prints a line only in `npm-publish.yml`. `docs/releasing.md` contains the sentence that required reviewers on the `npm` environment are the approval step. Do not run `workflow_dispatch`. Do not run `npm publish`. Do not create the npm token.

## Story coverage

| Approved story | Tasks |
| --- | --- |
| 1.1.1 Local OpenAPI 3.x file, YAML or JSON, internal `$ref`, clear errors | `P1-02`, `P1-03`, `P1-04` |
| 1.1.2 Spec URL, auth env, host allowlist, print spec version | `P1-05`, `P1-26`, `P1-27` |
| 1.1.3 Pin a fetched spec and show pin versus live | `P1-06`, `P1-27` |
| 1.2.1 Playwright request calls, same-file constants, `baseURL`, unresolved notes | `P1-07`, `P1-08`, `P1-09`, `P1-10`, `P1-25` |
| 1.2.2 Response expectations | `P1-12`, `P1-13`, `P1-14`, `P1-15` |
| 1.2.3 Match method and path template, report no match | `P1-11`, `P1-16` |
| 1.3.1 Unknown endpoint or method | `P1-16` |
| 1.3.2 Unknown body field and did-you-mean | `P1-17` |
| 1.3.3 Missing required body field | `P1-18` |
| 1.3.4 Unknown or missing query and path params | `P1-19` |
| 1.4.1 Undocumented status | `P1-20` |
| 1.4.2 Unknown response field | `P1-21`, `P1-22` |
| 1.4.3 Asserted type or enum | `P1-23` |
| 1.4.4 Content-Type | `P1-24` |
| 1.5.1 CLI, formats, exit codes, library with no CLI dependency | `P1-01`, `P1-25`, `P1-26`, `P1-27` |
| 1.6.1 Example, CI, README | `P1-28`, `P1-29`, `P3-01` |
| 2.1.1 ESLint rule `auditor/request-matches-spec` | `P2-01`, `P2-02` |
| 2.2.1 Cross-file helpers and imports, measure unresolved rate | `P2-03`, `P2-04`, `P2-05` |
| Launch: open source, npm metadata, release workflow | `P3-01`, `P3-02`, `P3-03` |
| Conventional Commits, added after the draft backlog | `F-02`, `F-03`, `F-04`, `P3-03`, and `CONTRIBUTING.md` |

## Not scheduled

These stay out of the task list. Do not start them under a Portfolio 1 pull request.

- Optional rule, off by default, warning when a request has no response checks (OQ-2).
- Reading specs from SwaggerHub, Postman Spec Hub, Redocly, or Bump.sh.
- A live mode that checks real responses.
- A paid layer: team rules, CI history, deeper Playwright support beyond Portfolio 2.
- Hurl, REST Assured, Postman collections, and Helix JSON.

## Not tasks

- Running `npm publish`, creating `NPM_TOKEN`, or dispatching the publish workflow.
- Posting to r/QualityAssurance, Playwright GitHub discussions, or anywhere else.
- Watching stars and issues for a month. `P2-05` only builds the unresolved-rate measurement.

## Open questions

Tasks implement the recommended default. Change the question and the task together if the answer differs.

| Id | Question | Recommended default |
| --- | --- | --- |
| OQ-1 | npm package name. Unscoped `auditor` is taken (`auditor@0.1.4`, last publish 2022-06-13). | Package `@tuyenluong/auditor`. Binary name `auditor`. |
| OQ-2 | Should "no response checks" ship in slice one? The approved backlog lists it as later and asks for a call. | Later. Not a slice-one rule. When built, severity `warning` and off unless enabled. |
| OQ-3 | Do unresolved calls fail the process? | No. Exit 0 when there are no error findings. The summary still prints the unresolved count. |
| OQ-4 | Is a body field unknown when the schema omits `additionalProperties`? JSON Schema would allow it. | Yes, flag it. Do not flag when `additionalProperties` is `true` or a schema. Flag when it is `false` or omitted. |
| OQ-5 | What should `expect(res.ok()).toBe(false)` do? | Record `negative-ok`. Do not invent an error status. |
| OQ-6 | The test only asserts `res.ok()`, and several 2xx responses have different schemas. | Skip field and assertion rules with `ambiguous-response-schema`. The status rule still passes if any 2xx is documented. |
| OQ-7 | `multipart` and `form` bodies. | Record `form-body`. No field findings in slice one. |
| OQ-8 | Header and cookie parameters. | Not checked in slice one. Query parameters are checked. A matched path template counts as the path parameters being present. |
| OQ-9 | External `$ref` over HTTP, and relative files. | Relative files that stay inside the spec directory resolve. HTTP refs resolve only for allowlisted hosts, with the same auth header. Anything else is `SPEC_INVALID`. |
| OQ-10 | First released version. | Manifest `0.0.0`. `bump-minor-pre-major` so the first `feat` release is `0.1.0`. A breaking change before 1.0.0 bumps the minor. |
| OQ-11 | Which open-source suite is the unresolved-rate baseline? | Pin `microsoft/playwright` at the SHA recorded when `P2-05` runs, glob `**/*.{spec,test}.ts`, plus the orders example. If that checkout has no Playwright request calls, exit 2 and pick another SHA. Do not invent the rate. |
| OQ-12 | Allow commit types `style` and `revert`? | No. The client's list is the whole list. |
| OQ-13 | Node engine. | `>=22.19.0`. `@apidevtools/swagger-parser@13.1.0` requires it, and the Cloud Agent image is Node v22.23.3. |
| OQ-14 | Should `expect` inside a dead branch count? | Yes. Collect every syntactic `expect` in the test callback. Document the limitation in the README. |

## Delivery order

The pull request sequence and the mermaid graph are in `docs/architecture.md` under "Delivery order" and "Dependency graph". Foundation pull requests 1–3 land before any `feat` commit. Portfolio 3 lands after the example and before Portfolio 2.
