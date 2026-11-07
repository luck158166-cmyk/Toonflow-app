import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ProductionCatalog } from "../packages/production/src/catalog";
import { bindAssetReference, listAssetReferences, listReferenceTargets, type BindReferenceInput } from "../packages/production/src/assetReference";

function setup() {
  const db = new Database(":memory:"); const catalog = new ProductionCatalog(db);
  const projectId = catalog.importStory({ title: "原图", sourceKind: "synopsis", sourceText: "林岚寻找钥匙。" });
  const entityId = catalog.upsertAsset({ projectId, kind: "character", name: "林岚", stableDescription: "黑发蓝衣", evidence: [] });
  catalog.setAssetLocked(entityId, true);
  const target = listReferenceTargets(catalog, projectId)[0]!;
  const input: BindReferenceInput = { projectId, entityKind: "asset", entityId, entityHash: target.entityHash, role: "headshot",
    expectedReferenceId: null, rightsConfirmed: true, sourceNote: "本人有权使用",
    file: { path: `assets/productionReferences/${"a".repeat(64)}.png`, sha256: "a".repeat(64), mimeType: "image/png", width: 512, height: 512 } };
  return { db, catalog, input };
}

it("versions original reference bindings without losing prior records and reuses duplicate requests", () => {
  const { db, catalog, input } = setup();
  try {
    const first = bindAssetReference(catalog, input);
    expect(first.reference.version).toBe(1);
    expect(bindAssetReference(catalog, input)).toEqual({ ...first, created: false });
    const replacement = { ...input, expectedReferenceId: first.reference.id,
      file: { ...input.file, path: `assets/productionReferences/${"b".repeat(64)}.png`, sha256: "b".repeat(64) } };
    const second = bindAssetReference(catalog, replacement);
    expect(second.reference).toMatchObject({ version: 2, previousId: first.reference.id, sourceKind: "user_authorized" });
    expect(bindAssetReference(catalog, replacement)).toEqual({ ...second, created: false });
    expect(listAssetReferences(catalog, input.projectId)).toHaveLength(2);
    expect(() => bindAssetReference(catalog, input)).toThrow("版本已变化");
    expect(listAssetReferences(catalog, input.projectId)[1]).toEqual(first.reference);
  } finally { db.close(); }
});

it("requires matching asset ownership, purpose, description, rights and current version", () => {
  const { db, catalog, input } = setup();
  try {
    const other = catalog.importStory({ title: "另一部", sourceKind: "synopsis", sourceText: "另一部故事" });
    expect(() => bindAssetReference(catalog, { ...input, projectId: other })).toThrow("不匹配");
    expect(() => bindAssetReference(catalog, { ...input, role: "scene" })).toThrow("不匹配");
    expect(() => bindAssetReference(catalog, { ...input, entityHash: "b".repeat(64) })).toThrow("描述已变化");
    expect(() => bindAssetReference(catalog, { ...input, rightsConfirmed: false as true })).toThrow("使用权");
    expect(() => bindAssetReference(catalog, { ...input, sourceNote: " " })).toThrow("使用权");
    expect(() => bindAssetReference(catalog, { ...input, file: { ...input.file, path: "../outside.png" } })).toThrow("文件信息");
    catalog.setAssetLocked(input.entityId, false);
    expect(() => bindAssetReference(catalog, input)).toThrow("先在分集审核");
    expect(listAssetReferences(catalog, input.projectId)).toEqual([]);
  } finally { db.close(); }
});

it("keeps face, body and scene bindings distinct and does not invent platform trust", () => {
  const { db, catalog, input } = setup();
  try {
    const face = bindAssetReference(catalog, input).reference;
    const body = bindAssetReference(catalog, { ...input, role: "fullBody" }).reference;
    const sceneId = catalog.upsertScene({ projectId: input.projectId, name: "车站", location: "候车大厅", evidence: [] });
    db.query("UPDATE production_scene SET locked = 1 WHERE id = ?").run(sceneId);
    const scene = listReferenceTargets(catalog, input.projectId).find(item => item.entityId === sceneId)!;
    const reference = bindAssetReference(catalog, { ...input, entityKind: "scene", entityId: sceneId, role: "scene", entityHash: scene.entityHash }).reference;
    expect([face.role, body.role, reference.role]).toEqual(["headshot", "fullBody", "scene"]);
    expect([face.version, body.version, reference.version]).toEqual([1, 1, 1]);
    expect("trustExpiresAt" in face).toBe(false);
    expect("provider" in face).toBe(false);
  } finally { db.close(); }
});

it("preserves the old binding if writing a replacement fails", () => {
  const { db, catalog, input } = setup();
  try {
    const first = bindAssetReference(catalog, input).reference;
    db.exec("CREATE TRIGGER rejectReference BEFORE INSERT ON asset_reference BEGIN SELECT RAISE(ABORT, 'reference fault'); END");
    expect(() => bindAssetReference(catalog, { ...input, expectedReferenceId: first.id, sourceNote: "新的来源" })).toThrow("reference fault");
    expect(listAssetReferences(catalog, input.projectId)).toEqual([first]);
  } finally { db.close(); }
});
