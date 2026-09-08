import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

async function readPackage(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

async function listRelativeFiles(directory: URL, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await listRelativeFiles(new URL(`${entry.name}/`, directory), `${relativePath}/`));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

const packages = [
  { slug: "ssh-remote", source: "extensions/ssh-remote", extension: true },
  { slug: "shared-settings", source: "packages/shared-settings", extension: false },
  { slug: "workspace-files", source: "packages/workspace-files", extension: false },
] as const;

test("configured workspaces are independently publishable packages", async () => {
  const root = await readPackage("../package.json");
  assert.equal(root.private, true);
  assert.deepEqual(root.workspaces, packages.map(({ source }) => source));
  assert.deepEqual(root.pi?.extensions, ["./extensions/ssh-remote/index.ts"]);
  assert.equal(root.scripts?.build, "bun run build:all");
  assert.equal(root.scripts?.["build:extensions"], "bun run --cwd extensions/ssh-remote build");

  const sshRemote = await readPackage("../extensions/ssh-remote/package.json");
  assert.equal(sshRemote.name, "@aoliyougei/pi-ssh-remote");
  assert.equal(sshRemote.private, true);
  assert.deepEqual(sshRemote.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(sshRemote.scripts, { build: "bun run ../../scripts/build-package.ts" });
  assert.deepEqual(sshRemote.piBuild?.bundlePackages, [
    "@aoliyougei/pi-shared-settings",
    "@aoliyougei/pi-workspace-files",
  ]);

  for (const sourcePath of ["packages/shared-settings", "packages/workspace-files"]) {
    const source = await readPackage(`../${sourcePath}/package.json`);
    assert.equal(source.private, true);
    assert.equal(source.pi, undefined);
    assert.equal(source.main, "./index.ts");
    assert.equal(source.types, "./index.ts");
    assert.deepEqual(source.scripts, { build: "bun run ../../scripts/build-package.ts" });
  }
});

test("root dist contains complete staging packages for configured workspaces", async () => {
  const buildScript = await readFile(new URL("../scripts/build-package.ts", import.meta.url), "utf8");
  assert.match(buildScript, /bundlePackages/);
  assert.match(buildScript, /external: getExternalPackages\(\)/);
  assert.match(buildScript, /sourcemap: "linked"/);
  assert.match(buildScript, /minify: true/);

  for (const packageInfo of packages) {
    const source = await readPackage(`../${packageInfo.source}/package.json`);
    const stageDirectory = new URL(`../dist/${packageInfo.slug}/`, import.meta.url);
    const stage = await readPackage(`../dist/${packageInfo.slug}/package.json`);
    const actualFiles = await listRelativeFiles(stageDirectory);
    const publishedFiles = actualFiles.filter((file) => file !== "package.json");
    const runtime = await readFile(new URL("index.min.js", stageDirectory), "utf8");
    const sourceMap = JSON.parse(await readFile(new URL("index.min.js.map", stageDirectory), "utf8")) as { sources?: string[]; sourcesContent?: Array<string | null> };

    assert.equal(stage.name, source.name);
    assert.equal(stage.version, source.version);
    assert.equal(stage.private, undefined);
    assert.equal(stage.scripts, undefined);
    assert.equal(stage.piBuild, undefined);
    assert.deepEqual(stage.files, publishedFiles);
    assert.deepEqual(actualFiles.filter((file) => file.endsWith(".js")), ["index.min.js"]);
    assert.deepEqual(actualFiles.filter((file) => file.endsWith(".js.map")), ["index.min.js.map"]);
    assert.ok(actualFiles.includes("README.md"));
    assert.ok(actualFiles.includes("LICENSE"));
    assert.match(runtime, /\/\/# sourceMappingURL=index\.min\.js\.map/);
    assert.ok((sourceMap.sources?.length ?? 0) > 0);
    assert.equal(sourceMap.sourcesContent?.length, sourceMap.sources?.length);
    for (const sourcePath of sourceMap.sources ?? []) {
      assert.equal(sourcePath.startsWith("/"), false);
      assert.doesNotMatch(sourcePath, /^[A-Za-z]:[\\/]/);
    }
    await assert.rejects(access(new URL(`../${packageInfo.source}/dist/`, import.meta.url)), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    if (packageInfo.extension) {
      assert.deepEqual(stage.pi?.extensions, ["./index.min.js"]);
      assert.equal(typeof (await import(`${new URL("index.min.js", stageDirectory).href}?package-test=${packageInfo.slug}`)).default, "function");
    } else {
      assert.equal(stage.pi, undefined);
      assert.equal(stage.main, "./index.min.js");
      assert.equal(stage.types, "./index.d.ts");
      assert.ok(actualFiles.includes("index.d.ts"));
    }
  }
});
