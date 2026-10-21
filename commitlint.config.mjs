export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "test",
        "refactor",
        "chore",
        "ci",
        "build",
        "perf",
      ],
    ],
    "scope-enum": [
      2,
      "always",
      [
        "spec",
        "playwright",
        "rules",
        "cli",
        "eslint",
        "examples",
        "release",
        "deps",
        "repo",
      ],
    ],
  },
};
