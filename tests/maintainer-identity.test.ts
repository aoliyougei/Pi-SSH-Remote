import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const excludedDirectories = new Set([".git", "node_modules", "dist", "artifacts"]);
const excludedFiles = new Set(["UPSTREAM.md", "LICENSE"]);

function scan(root: string, current = root, matches: string[] = []): string[] {
  for (const name of readdirSync(current)) {
    if (excludedDirectories.has(name)) continue;
    const path = join(current, name);
    if (statSync(path).isDirectory()) {
      scan(root, path, matches);
      continue;
    }
    if (excludedFiles.has(name)) continue;
    let content: string;
    try { content = readFileSync(path, "utf8"); } catch { continue; }
    if (content.includes("99percent" + "people")) matches.push(relative(root, path));
  }
  return matches;
}

test("maintained source uses only the aoliyougei identity", () => {
  assert.deepEqual(scan(process.cwd()), []);
});
