import { isAbsolute as isAbsoluteLocal, relative, resolve } from "node:path";
import posixPath from "node:path/posix";

export type PathDialect = "local" | "posix";

export function normalizeRoots(
  cwd: string,
  roots: readonly string[] | undefined,
  dialect: PathDialect,
): readonly string[] {
  const normalize = dialect === "local" ? resolve : posixResolve;
  const resolvedCwd = normalize(cwd);
  const candidates = roots && roots.length > 0 ? roots : [resolvedCwd];
  return candidates.map((root) => normalize(root));
}

export function resolveSandboxPath(
  cwd: string,
  roots: readonly string[],
  inputPath: string,
  dialect: PathDialect,
): string {
  const path = inputPath || ".";
  const resolved = dialect === "local"
    ? (isAbsoluteLocal(path) ? resolve(path) : resolve(cwd, path))
    : (path.startsWith("/") ? posixResolve(path) : posixResolve(cwd, path));
  assertInsideRoots(resolved, roots, dialect);
  return resolved;
}

function assertInsideRoots(path: string, roots: readonly string[], dialect: PathDialect) {
  for (const root of roots) {
    const rel = dialect === "local" ? relative(root, path) : posixPath.relative(root, path);
    const escaped = rel === ".." || rel.startsWith("../") || rel.startsWith("..\\");
    if (rel === "" || !escaped) return;
  }
  throw new Error(`Path is outside sandbox roots: ${path}`);
}

function posixResolve(...parts: string[]) {
  return posixPath.resolve(...parts);
}

export function posixParentDir(path: string) {
  const parent = posixPath.dirname(path);
  return parent || "/";
}
