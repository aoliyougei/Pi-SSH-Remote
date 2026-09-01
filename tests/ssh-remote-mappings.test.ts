import assert from "node:assert/strict";
import test from "node:test";
import { MappingController, findProjectMapping } from "../extensions/ssh-remote/src/mappings/controller.ts";
import { normalizeMappingStore } from "../extensions/ssh-remote/src/mappings/store.ts";
import type { LocalProjectMapping, MappingStoreDocument } from "../extensions/ssh-remote/src/mappings/types.ts";

function fixtureMapping(id = "mapping-1", localRoot = "/local/workspace"): LocalProjectMapping {
  return { version: 1, id, projectId: `project-${id}`, localRoot, localRootCanonical: localRoot, matchSubdirectories: true, serverId: "server-1", remoteRoot: "/srv/test/project", autoSync: true, debounceMs: 1500, localExcludePatterns: [], remoteProtectedPatterns: [], markerId: `marker-${id}`, paused: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

test("mapping store applies protection defaults and validates debounce", () => {
  const value = normalizeMappingStore({ version: 1, mappings: [fixtureMapping()] });
  assert.ok(value.mappings[0].remoteProtectedPatterns.includes(".pi-ssh-sync.json"));
  assert.ok(value.mappings[0].remoteProtectedPatterns.includes("!.env.example"));
  assert.throws(() => normalizeMappingStore({ version: 1, mappings: [{ ...fixtureMapping(), debounceMs: 100 }] }), /250.*30000/);
});

test("mapping resolution selects the nearest canonical ancestor", () => {
  const mappings = [fixtureMapping("root", "/local/workspace"), fixtureMapping("api", "/local/workspace/packages/api")];
  assert.equal(findProjectMapping("/local/workspace/packages/api/src", mappings, "linux")?.id, "api");
  assert.equal(findProjectMapping("/local/other", mappings, "linux"), undefined);
});

test("mapping update remains transactional when validation fails", async () => {
  let saved: MappingStoreDocument = { version: 1, mappings: [fixtureMapping("root")] };
  const controller = new MappingController({ load: () => saved, save: (value) => { saved = value; }, platform: "linux" });
  await assert.rejects(controller.updateTransactional("root", { remoteRoot: "/srv/test/new" }, async () => { throw new Error("marker mismatch"); }), /marker mismatch/);
  assert.equal(controller.get("root")?.remoteRoot, "/srv/test/project");
  assert.equal(controller.generation, 0);
  const next = await controller.updateTransactional("root", { remoteRoot: "/srv/test/new" }, async () => {});
  assert.equal(next.remoteRoot, "/srv/test/new");
  assert.equal(controller.generation, 1);
});
