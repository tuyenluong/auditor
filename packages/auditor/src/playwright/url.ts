export function splitUrl(url: string): { path: string; query: Record<string, string> } {
  const hash = url.indexOf("#");
  const withoutHash = hash === -1 ? url : url.slice(0, hash);
  const question = withoutHash.indexOf("?");
  if (question === -1) return { path: withoutHash, query: {} };
  return { path: withoutHash.slice(0, question), query: queryFromString(withoutHash.slice(question + 1)) };
}

export function queryFromString(query: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) entries[key] = value;
  return entries;
}
