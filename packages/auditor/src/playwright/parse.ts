import { extname } from "node:path";
import { API } from "typescript/unstable/sync";
import type { SourceFile } from "typescript/unstable/ast";

const PARSED_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const files = new Map<string, string>();
let parser: API | undefined;
let sequence = 0;

export function withSourceFile<T>(filePath: string, text: string, read: (source: SourceFile) => T): T | undefined {
  const extension = extname(filePath).toLowerCase();
  if (!PARSED_EXTENSIONS.has(extension)) return undefined;
  const api = parserApi();
  sequence += 1;
  const virtualPath = `/virtual/file-${sequence}${extension}`;
  files.set(virtualPath, text);
  try {
    const snapshot = api.updateSnapshot({ openFiles: [virtualPath] });
    try {
      const source = snapshot.getDefaultProjectForFile(virtualPath)?.program.getSourceFile(virtualPath);
      if (!source) return undefined;
      return read(source);
    } finally {
      snapshot.dispose();
    }
  } finally {
    files.delete(virtualPath);
    api.updateSnapshot({ closeFiles: [virtualPath] });
  }
}

function parserApi(): API {
  parser ??= new API({
    cwd: "/",
    fs: {
      readFile(name) {
        const text = files.get(name);
        return text === undefined ? null : text;
      },
      fileExists(name) {
        return files.has(name);
      },
      directoryExists(name) {
        return !files.has(name);
      },
    },
  });
  return parser;
}
