import path from "node:path";
import { fileURLToPath } from "node:url";
import load from "@commitlint/load";
import lint from "@commitlint/lint";

const title = process.env.PR_TITLE ?? "";

if (title === "") {
  console.error("PR_TITLE is empty");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await load(undefined, { cwd: root });
const parserOpts =
  config.parserPreset &&
  typeof config.parserPreset.parserOpts === "object" &&
  config.parserPreset.parserOpts !== null
    ? config.parserPreset.parserOpts
    : {};

const report = await lint(title, config.rules, { parserOpts });

if (!report.valid) {
  const problems = report.errors.length > 0 ? report.errors : report.warnings;
  for (const problem of problems) {
    console.error(`${problem.message} [${problem.name}]`);
  }
  process.exit(1);
}
