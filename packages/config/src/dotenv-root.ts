import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

/**
 * Загружает .env из корня монорепозитория независимо от того, откуда
 * запущен процесс (`npm run ... -w @ustal/database` меняет cwd на
 * packages/database, где .env не лежит). Находит корень, поднимаясь вверх
 * от расположения ЭТОГО файла до первого package.json с полем "workspaces".
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces) return dir;
      } catch {
        // ignore malformed package.json and keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

let loaded = false;

export function loadDotenvOnce(): void {
  if (loaded) return;
  loaded = true;
  const thisFileDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(thisFileDir);
  loadDotenv({ path: join(repoRoot, ".env") });
}
