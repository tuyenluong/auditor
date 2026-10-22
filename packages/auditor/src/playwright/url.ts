const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// One unresolved template expression that fills a path segment.
export const DYNAMIC_HOLE = "\u0000";

export function splitPathSegments(path: string): string[] {
  const parts = path.split("/");
  if (parts[0] === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function originAndPath(path: string): { origin: string; pathname: string } | undefined {
  if (!SCHEME.test(path)) return undefined;
  const scheme = path.indexOf("://");
  if (scheme === -1) return undefined;
  const start = path.indexOf("/", scheme + 3);
  if (start === -1) return { origin: path, pathname: "/" };
  return { origin: path.slice(0, start), pathname: path.slice(start) };
}

export function takeDynamicPath(path: string): { path: string; dynamicSegments?: readonly number[] } {
  if (!path.includes(DYNAMIC_HOLE)) return { path };
  const pathname = originAndPath(path)?.pathname ?? path;
  const dynamicSegments = splitPathSegments(pathname).flatMap((segment, index) =>
    segment === DYNAMIC_HOLE ? [index] : [],
  );
  const concrete = path.replaceAll(DYNAMIC_HOLE, "{}");
  if (dynamicSegments.length === 0) return { path: concrete };
  return { path: concrete, dynamicSegments };
}

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
