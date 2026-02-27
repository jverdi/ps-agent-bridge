import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

function candidatePackageJsonPaths(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "package.json"),
    path.resolve(moduleDir, "../../package.json"),
    path.resolve(moduleDir, "../../../package.json")
  ];

  return [...new Set(candidates)];
}

export function readCliVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  for (const candidate of candidatePackageJsonPaths()) {
    if (!existsSync(candidate)) {
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
        cachedVersion = parsed.version.trim();
        return cachedVersion;
      }
    } catch {
      // Try the next candidate path.
    }
  }

  cachedVersion = "0.0.0";
  return cachedVersion;
}
