# Contributing to Auditor

Auditor uses [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) for every commit message and every pull request title. Release Please reads these messages to bump the version and update `CHANGELOG.md` once the release workflow lands.

## Commit message

```
<type>(<scope>): <subject>

<body>

<footer>
```

The scope is optional. The subject is imperative, lowercase, and has no trailing period. A blank line separates the subject from the body.

```
feat(spec): load OpenAPI from a URL
fix(playwright): resolve baseURL from config
docs(repo): add refined backlog and architecture
```

A scope, when present, is one of the scopes below. `feat: add a path matcher` is valid. `feat(nope): add a path matcher` is not.

## Types

| Type | Use for |
| --- | --- |
| `feat` | A user-visible capability |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `test` | Tests only, or fixture-only changes |
| `refactor` | Behavior-preserving code change |
| `chore` | Tooling or repo maintenance that is not a user-facing feature |
| `ci` | GitHub Actions and other CI config |
| `build` | Build system, package scaffold, or dependency plumbing |
| `perf` | A performance change with the same behavior |

`style` and `revert` are not allowed. The list above is the whole list.

## Scopes

Scopes match modules. Use the narrowest one that is honest.

| Scope | Use for |
| --- | --- |
| `spec` | OpenAPI loading, URL fetch, pinning, the spec model |
| `playwright` | Call extraction, same-file constants, `baseURL`, expectations, path matching |
| `rules` | Finding rules and the schema walker they share |
| `cli` | The `auditor` command, formatters, exit codes |
| `eslint` | The ESLint rule |
| `examples` | `examples/orders` |
| `release` | Release Please, the changelog, the npm publish workflow |
| `deps` | A commit that only bumps dependencies |
| `repo` | Workspace scaffold, cross-cutting docs, commit conventions |

## Breaking changes

Put `!` after the type or scope, and add a `BREAKING CHANGE:` footer. Either marker is enough for Release Please to cut a major bump. Before 1.0.0 the release config treats a breaking change as a minor bump (`bump-minor-pre-major`).

```
feat(spec)!: drop OpenAPI 3.0

BREAKING CHANGE: specs must be OpenAPI 3.1.
```

## Pull request titles

The title is a Conventional Commits header. CI runs the same commitlint rules against the title. A title such as `Add backlog` fails the check. The title does not include the body or the footer.

## Branches

```
<type>/<task-id>-<short-name>
```

- `<type>` is one of the types above.
- `<task-id>` is the backlog id in lowercase (`f-01`, `p1-05`, `p2-01`, `p3-03`).
- `<short-name>` is lowercase words separated by hyphens.

```
build/f-01-scaffold-typescript
ci/f-04-pr-title
feat/p1-05-fetch-spec-url
fix/p1-11-path-template-slash
docs/p3-01-readme
```

## Local hook

`npm install` at the repo root sets `core.hooksPath` to `.githooks`. The `commit-msg` hook runs commitlint on the message you are about to create. Install dependencies before the first commit so the hook exists. To check a message without committing:

```bash
echo 'feat(spec): load OpenAPI from a URL' | npx commitlint
```

To check a pull request title the way CI does:

```bash
PR_TITLE='feat(spec): load OpenAPI from a URL' npm run lint:pr-title
```

The hook and the CI check are tasks `F-02`, `F-03`, and `F-04` in `docs/backlog.md`. They are not in the repo until those tasks land. Until then, follow this document by hand.
