import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import type {
  BashOperations,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

async function readPackage(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSourceExtensionPackage(packageJson: Record<string, any>): void {
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.files, undefined);
  assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(packageJson.scripts, {
    build: "bun run ../../scripts/build-package.ts",
  });
}

async function listRelativeFiles(
  directory: URL,
  prefix = "",
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(
        new URL(`${entry.name}/`, directory),
        `${relativePath}/`,
      ));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

test("extensions are independently publishable workspace packages", async () => {
  const root = await readPackage("../package.json");
  const background = await readPackage(
    "../extensions/background-tasks/package.json",
  );
  const codexApi = await readPackage("../extensions/codex-api/package.json");
  const cursorEffect = await readPackage("../extensions/cursor-effect/package.json");
  const deepSeekAnchor = await readPackage("../extensions/deepseek-anchor/package.json");
  const sshRemote = await readPackage("../extensions/ssh-remote/package.json");
  const thinkingFold = await readPackage(
    "../extensions/thinking-fold/package.json",
  );
  const todo = await readPackage("../extensions/todo/package.json");
  const sharedSettings = await readPackage("../packages/shared-settings/package.json");
  const workspaceFiles = await readPackage("../packages/workspace-files/package.json");
  const codexApiSkill = await readFile(
    new URL("../extensions/codex-api/skills/gpt-image-prompts/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.equal(
    root.private,
    true,
    "the workspace root must never be published",
  );
  assert.deepEqual(
    root.pi?.extensions,
    ["./extensions/ssh-remote/index.ts"],
    "Git installs must load only SSH Remote",
  );
  assert.deepEqual(root.workspaces, [
    "extensions/background-tasks",
    "extensions/codex-api",
    "extensions/cursor-effect",
    "extensions/deepseek-anchor",
    "extensions/ssh-remote",
    "extensions/thinking-fold",
    "extensions/todo",
    "packages/shared-settings",
    "packages/workspace-files",
  ]);
  assert.equal(root.scripts?.build, "bun run build:all");
  assert.equal(
    root.scripts?.["build:all"],
    "bun run clean:dist && bun run build:packages && bun run build:extensions",
  );
  assert.equal(root.scripts?.["clean:dist"], "bun run scripts/clean-build.ts");
  assert.match(root.scripts?.test, /^bun run build:all && /);
  assert.equal(
    root.scripts?.["build:packages"],
    "bun run --cwd packages/shared-settings build && bun run --cwd packages/workspace-files build",
  );

  assert.equal(background.name, "@aoliyougei/pi-background-tasks");
  assert.equal(background.version, "2.1.1");
  assertSourceExtensionPackage(background);
  assert.deepEqual(background.piBuild?.bundlePackages, [
    "@aoliyougei/pi-shared-settings",
  ]);
  assert.equal(background.dependencies?.["@aoliyougei/pi-shared-settings"], "0.1.4");
  assert.equal(background.dependencies?.["node-pty"], "1.2.0-beta.14");
  assert.equal(background.dependencies?.["@xterm/headless"], "6.0.0");
  assert.equal(background.publishConfig?.access, "public");

  assert.equal(codexApi.name, "@aoliyougei/pi-codex-api");
  assert.equal(codexApi.version, "0.3.2");
  assertSourceExtensionPackage(codexApi);
  assert.deepEqual(codexApi.pi?.skills, ["./skills"]);
  assert.deepEqual(codexApi.piBuild?.assets, ["skills"]);
  assert.deepEqual(codexApi.piBuild?.bundlePackages, [
    "@aoliyougei/pi-shared-settings",
    "@aoliyougei/pi-workspace-files",
  ]);
  assert.equal(codexApi.publishConfig?.access, "public");
  assert.equal(codexApi.dependencies?.["@aoliyougei/pi-shared-settings"], "0.1.4");
  assert.equal(codexApi.dependencies?.["@aoliyougei/pi-workspace-files"], "0.1.2");
  assert.equal(codexApi.peerDependencies?.["@earendil-works/pi-tui"], "*");
  assert.match(codexApiSkill, /^---\nname: gpt-image-prompts\n/m);
  assert.match(codexApiSkill, /Craft and refine production-ready prompts for GPT Image 2/);
  assert.match(codexApiSkill, /prompt-writing skill only/);
  assert.doesNotMatch(codexApiSkill, /codex_search|codex_image|output_path|referenced_(?:image_)?paths/);

  assert.equal(cursorEffect.name, "@aoliyougei/pi-cursor-effect");
  assert.equal(cursorEffect.version, "0.1.6");
  assertSourceExtensionPackage(cursorEffect);
  assert.deepEqual(cursorEffect.piBuild?.bundlePackages, [
    "@aoliyougei/pi-shared-settings",
  ]);
  assert.equal(cursorEffect.publishConfig?.access, "public");
  assert.equal(cursorEffect.dependencies?.["@aoliyougei/pi-shared-settings"], "0.1.4");


  assert.equal(deepSeekAnchor.name, "@aoliyougei/pi-deepseek-anchor");
  assert.equal(deepSeekAnchor.version, "0.1.0");
  assertSourceExtensionPackage(deepSeekAnchor);
  assert.deepEqual(deepSeekAnchor.piBuild?.bundlePackages, [
    "@aoliyougei/pi-shared-settings",
  ]);
  assert.equal(deepSeekAnchor.dependencies?.["@aoliyougei/pi-shared-settings"], "0.1.4");
  assert.equal(deepSeekAnchor.publishConfig?.access, "public");
  assert.equal(deepSeekAnchor.peerDependencies?.["@earendil-works/pi-ai"], "*");
  assert.equal(deepSeekAnchor.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.equal(deepSeekAnchor.peerDependencies?.["@earendil-works/pi-tui"], "*");
  assert.equal(deepSeekAnchor.peerDependencies?.typebox, "*");

  assert.equal(sshRemote.name, "@aoliyougei/pi-ssh-remote");
  assert.equal(sshRemote.version, "0.6.0-remote-resources.4");
  assertSourceExtensionPackage(sshRemote);
  assert.deepEqual(sshRemote.piBuild?.bundlePackages, [
    "@aoliyougei/pi-shared-settings",
    "@aoliyougei/pi-workspace-files",
  ]);
  assert.equal(sshRemote.dependencies?.["@aoliyougei/pi-shared-settings"], "0.1.4");
  assert.equal(sshRemote.dependencies?.["@aoliyougei/pi-workspace-files"], "0.1.2");
  assert.equal(sshRemote.publishConfig?.access, "public");

  assert.equal(thinkingFold.name, "@aoliyougei/pi-thinking-fold");
  assert.equal(thinkingFold.version, "0.1.9");
  assertSourceExtensionPackage(thinkingFold);
  assert.deepEqual(thinkingFold.piBuild?.assets, ["model-behaviors.json"]);
  assert.deepEqual(thinkingFold.piBuild?.bundlePackages, [
    "@aoliyougei/pi-shared-settings",
  ]);
  assert.equal(thinkingFold.publishConfig?.access, "public");
  assert.equal(thinkingFold.dependencies?.["@aoliyougei/pi-shared-settings"], "0.1.4");

  assert.equal(todo.name, "@aoliyougei/pi-todo");
  assert.equal(todo.version, "1.2.7");
  assertSourceExtensionPackage(todo);
  assert.deepEqual(todo.piBuild?.bundlePackages, [
    "@aoliyougei/pi-shared-settings",
  ]);
  assert.equal(todo.publishConfig?.access, "public");
  assert.equal(todo.dependencies?.["@aoliyougei/pi-shared-settings"], "0.1.4");

  assert.equal(sharedSettings.name, "@aoliyougei/pi-shared-settings");
  assert.equal(sharedSettings.version, "0.1.4");
  assert.equal(sharedSettings.private, true);
  assert.equal(sharedSettings.pi, undefined);
  assert.equal(sharedSettings.main, "./index.ts");
  assert.equal(sharedSettings.types, "./index.ts");
  assert.equal(sharedSettings.files, undefined);
  assert.deepEqual(sharedSettings.scripts, {
    build: "bun run ../../scripts/build-package.ts",
  });
  assert.equal(sharedSettings.publishConfig?.access, "public");

  assert.equal(workspaceFiles.name, "@aoliyougei/pi-workspace-files");
  assert.equal(workspaceFiles.version, "0.1.2");
  assert.equal(workspaceFiles.private, true);
  assert.equal(workspaceFiles.pi, undefined);
  assert.equal(workspaceFiles.main, "./index.ts");
  assert.equal(workspaceFiles.types, "./index.ts");
  assert.equal(workspaceFiles.files, undefined);
  assert.deepEqual(workspaceFiles.scripts, {
    build: "bun run ../../scripts/build-package.ts",
  });
  assert.equal(workspaceFiles.publishConfig?.access, "public");
});

test("root dist contains complete minified publish staging packages", async () => {
  const packages = [
    { slug: "background-tasks", source: "extensions/background-tasks", extension: true },
    { slug: "codex-api", source: "extensions/codex-api", extension: true },
    { slug: "cursor-effect", source: "extensions/cursor-effect", extension: true },
    { slug: "deepseek-anchor", source: "extensions/deepseek-anchor", extension: true },
    { slug: "ssh-remote", source: "extensions/ssh-remote", extension: true },
    { slug: "thinking-fold", source: "extensions/thinking-fold", extension: true },
    { slug: "todo", source: "extensions/todo", extension: true },
    { slug: "shared-settings", source: "packages/shared-settings", extension: false },
    { slug: "workspace-files", source: "packages/workspace-files", extension: false },
  ] as const;
  const buildScript = await readFile(
    new URL("../scripts/build-package.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(buildScript, /packages: "external"/);
  assert.match(buildScript, /bundlePackages/);
  assert.match(buildScript, /external: getExternalPackages\(\)/);
  assert.match(buildScript, /delete publishManifest\.dependencies/);
  assert.match(buildScript, /naming: "\[name\]\.min\.\[ext\]"/);
  assert.match(buildScript, /sourcemap: "linked"/);
  assert.match(buildScript, /minify: true/);

  for (const packageInfo of packages) {
    const source = await readPackage(`../${packageInfo.source}/package.json`);
    const stageDirectory = new URL(`../dist/${packageInfo.slug}/`, import.meta.url);
    const stage = await readPackage(`../dist/${packageInfo.slug}/package.json`);
    const actualFiles = await listRelativeFiles(stageDirectory);
    const publishedFiles = actualFiles.filter((file) => file !== "package.json");
    const jsFiles = actualFiles.filter((file) => file.endsWith(".js"));
    const sourceMaps = actualFiles.filter((file) => file.endsWith(".js.map"));
    const runtime = await readFile(new URL("index.min.js", stageDirectory), "utf8");
    const sourceMap = JSON.parse(
      await readFile(new URL("index.min.js.map", stageDirectory), "utf8"),
    ) as { sources?: string[]; sourcesContent?: Array<string | null> };

    assert.equal(stage.name, source.name);
    assert.equal(stage.version, source.version);
    assert.equal(stage.private, undefined);
    assert.equal(stage.scripts, undefined);
    assert.equal(stage.piBuild, undefined);
    for (const packageName of source.piBuild?.bundlePackages ?? []) {
      assert.equal(stage.dependencies?.[packageName], undefined);
      assert.doesNotMatch(
        runtime,
        new RegExp(`(?:from|import\\()\\s*["']${escapeRegExp(packageName)}["']`),
      );
    }
    assert.deepEqual(stage.files, publishedFiles);
    assert.deepEqual(jsFiles, ["index.min.js"]);
    assert.deepEqual(sourceMaps, ["index.min.js.map"]);
    assert.ok(actualFiles.includes("README.md"));
    assert.ok(actualFiles.includes("LICENSE"));
    assert.match(runtime, /\/\/# sourceMappingURL=index\.min\.js\.map/);
    assert.doesNotMatch(runtime, /(?:from|import\()["'][^"']+\.ts["']/);
    assert.ok((sourceMap.sources?.length ?? 0) > 0);
    assert.equal(sourceMap.sourcesContent?.length, sourceMap.sources?.length);
    for (const sourcePath of sourceMap.sources ?? []) {
      assert.ok(!sourcePath.startsWith("/"), `absolute source-map path: ${sourcePath}`);
      assert.doesNotMatch(sourcePath, /^[A-Za-z]:[\\/]/);
    }
    await assert.rejects(
      access(new URL(`../${packageInfo.source}/dist/`, import.meta.url)),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    if (packageInfo.extension) {
      assert.deepEqual(stage.pi?.extensions, ["./index.min.js"]);
      assert.equal(stage.main, undefined);
      assert.equal(stage.types, undefined);
      assert.match(runtime, /@earendil-works\//);
      assert.equal(actualFiles.some((file) => file.endsWith(".d.ts")), false);
      const extensionModule = await import(
        `${new URL("index.min.js", stageDirectory).href}?package-test=${packageInfo.slug}`
      );
      assert.equal(typeof extensionModule.default, "function");
    } else {
      assert.equal(stage.pi, undefined);
      assert.equal(stage.main, "./index.min.js");
      assert.equal(stage.types, "./index.d.ts");
      assert.ok(actualFiles.includes("index.d.ts"));
    }
  }

  const codexStage = await readPackage("../dist/codex-api/package.json");
  const thinkingStage = await readPackage("../dist/thinking-fold/package.json");
  const sharedStageFiles = await listRelativeFiles(
    new URL("../dist/shared-settings/", import.meta.url),
  );
  assert.deepEqual(codexStage.pi?.skills, ["./skills"]);
  assert.ok(
    (codexStage.files as string[]).includes("skills/gpt-image-prompts/SKILL.md"),
  );
  assert.ok((thinkingStage.files as string[]).includes("model-behaviors.json"));
  assert.ok(sharedStageFiles.includes("sectioned-settings-list.d.ts"));
});
