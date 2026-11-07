import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ProductionCatalog, ProductionStore, bindAssetReference, listReferenceTargets, listAssetReferences, planAssetImage, previewAssetImage, assetImageModel, assetImagePriceUnit } from "../packages/production/src";
import { createShotFixture } from "./shotPreparationFixture";

it("compiles role-specific locked asset requests and binds only the exact quote and credential context", () => {
  const db = new Database(":memory:"); const catalog = new ProductionCatalog(db); const store = new ProductionStore(db);
  try {
    const { projectId } = createShotFixture(catalog);
    const target = listReferenceTargets(catalog, projectId).find(item => item.kind === "character")!;
    const input = { projectId, entityKind: target.entityKind, entityId: target.entityId, role: "headshot" as const, visualStyle: "" };
    const model = { revision: "a".repeat(64), credentialScope: "b".repeat(64), configured: true, available: true };
    const plan = planAssetImage(catalog, input); expect(JSON.parse(plan.requestJson)).toMatchObject({ modelId: assetImageModel, size: "1024x1024" });
    expect(JSON.parse(plan.requestJson).prompt).toContain(target.description);
    expect(JSON.parse(planAssetImage(catalog, { ...input, role: "fullBody" }).requestJson).size).toBe("800x1424");
    expect(previewAssetImage(catalog, store, input, model).canSubmit).toBe(false);
    store.globalBudgets.recordPriceRule({ provider: "volcengine", modelId: assetImageModel, unit: assetImagePriceUnit, unitSize: 1, unitPriceMicros: 100,
      currency: "CNY", sourceUrl: "https://example.test/qa", effectiveAt: 1, recordedBy: "qa" });
    const preview = previewAssetImage(catalog, store, input, model); expect(preview.canSubmit).toBe(true); expect(preview.price?.amountMicros).toBe(100);
    expect(previewAssetImage(catalog, store, input, { ...model, credentialScope: "c".repeat(64) }).planHash).not.toBe(preview.planHash);
    expect(() => planAssetImage(catalog, { ...input, role: "scene" })).toThrow("用途");
    expect(() => planAssetImage(catalog, { ...input, visualStyle: "a".repeat(121) })).toThrow("画风");
    catalog.setAssetLocked(target.entityId, false); expect(() => planAssetImage(catalog, input)).toThrow("锁定");
  } finally { db.close(); }
});

it("stores generated origin with the adopted original atomically and handles reordered duplicate evidence", () => {
  const db = new Database(":memory:"); const catalog = new ProductionCatalog(db);
  try {
    const { projectId } = createShotFixture(catalog); const target = listReferenceTargets(catalog, projectId)[0]!;
    const sha256 = "a".repeat(64);
    const input = { projectId, entityKind: target.entityKind, entityId: target.entityId, entityHash: target.entityHash, role: target.roles[0]!,
      expectedReferenceId: null, rightsConfirmed: true as const, sourceNote: "QA generated original", file: { path: `assets/productionReferences/${sha256}.png`, sha256, width: 1024, height: 1024, mimeType: "image/png" } };
    const origin = { originalSha256: sha256, method: "textToImage" as const, credentialScope: "b".repeat(64), generatedAt: Date.now(), modelId: assetImageModel, taskId: "qaTask" };
    const first = bindAssetReference(catalog, input, origin);
    expect(first.reference.origin).toEqual(origin); expect(bindAssetReference(catalog, input, origin).created).toBe(false);
    expect(() => bindAssetReference(catalog, input)).toThrow("不能改变");
    expect(() => bindAssetReference(catalog, { ...input, sourceNote: "changed", expectedReferenceId: first.reference.id }, origin)).toThrow();
    expect(listAssetReferences(catalog, projectId)).toHaveLength(1);
    expect(() => bindAssetReference(catalog, input, { ...origin, originalSha256: "c".repeat(64) })).toThrow("来源证据");
  } finally { db.close(); }
});
