import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ProductionCatalog } from "../packages/production/src/catalog";
import { ProductionStore } from "../packages/production/src/store";
import { getEpisodeSegmentPlan, saveEpisodeSegmentPlan } from "../packages/production/src/segmentPlan";
import { previewSegmentExecution, reviewSegmentPreflight, segmentTaskKey, segmentVideoPriceUnit } from "../packages/production/src/segmentExecution";
import { createShotFixture, bindFixtureImages, scenicDraft } from "./shotPreparationFixture";

const review = { actionConfirmed: true, continuityConfirmed: true, dialogueConfirmed: true, referencesConfirmed: true, note: "QA 本片段为空镜，无人物与对白；前后灯光一致" } as const;
const model = { revision: "a".repeat(64), available: true, configured: true };
function setup(scenic = false) {
  const db = new Database(":memory:"); const catalog = new ProductionCatalog(db); const store = new ProductionStore(db);
  const fixture = createShotFixture(catalog, scenic ? scenicDraft : undefined); bindFixtureImages(catalog, fixture.projectId);
  const input = { projectId: fixture.projectId, episodeId: fixture.episodeId, sequence: 1, inputHash: getEpisodeSegmentPlan(catalog, fixture.projectId, fixture.episodeId).inputHash };
  const price = (unit = segmentVideoPriceUnit) => store.globalBudgets.recordPriceRule({ provider: "volcengine", modelId: "doubao-seedance-2-5-260628", unit,
    unitSize: 1, unitPriceMicros: 100, currency: "CNY", sourceUrl: "https://example.test/qa-price", effectiveAt: Date.now(), recordedBy: "qa" });
  const preview = () => previewSegmentExecution(catalog, store, input, model);
  const save = () => saveEpisodeSegmentPlan(catalog, input.projectId, input.episodeId, input.inputHash);
  return { db, catalog, store, input, price, preview, save, ...fixture };
}

it("keeps face provenance blocked even after explicit manual preflight; review does not create tasks or claim post-QC", () => {
  const s = setup();
  try {
    s.price(); expect(() => reviewSegmentPreflight(s.catalog, s.input, review)).toThrow("保存"); s.save();
    const first = reviewSegmentPreflight(s.catalog, s.input, review);
    expect(reviewSegmentPreflight(s.catalog, s.input, review).id).toBe(first.id);
    expect(() => reviewSegmentPreflight(s.catalog, s.input, { ...review, note: "changed" })).toThrow("已保存");
    const report = s.preview(); expect(report.canSubmit).toBe(false);
    expect(report.blockers.every(item => item.code === "P14")).toBe(true);
    expect(report.checks.find(item => item.code === "contentQuality")?.message).toContain("不代表生成后质量通过");
    expect(s.store.listProjectTasks(s.projectId)).toHaveLength(0);
    expect(() => reviewSegmentPreflight(s.catalog, s.input, { ...review, referencesConfirmed: false as never })).toThrow("逐项");
  } finally { s.db.close(); }
});

it("allows a saved, reviewed no-human segment only with the exact scoped price and current model configuration", () => {
  const s = setup(true);
  try {
    s.save(); reviewSegmentPreflight(s.catalog, s.input, review); s.price("second");
    expect(s.preview().blockers.some(item => item.code === "price")).toBe(true);
    s.price(); const ready = s.preview(); expect(ready.blockers).toEqual([]); expect(ready.canSubmit).toBe(true);
    expect(ready.price?.estimatedCostMicros).toBe(1000);
    const request = JSON.parse(ready.requestJson); expect(request.images).toHaveLength(1); expect(request.referenceOrder).toEqual([{ type: "image", index: 0 }]);
    expect(request).toMatchObject({ duration: 10, resolution: "1080p", generateAudio: true });
    const changed = previewSegmentExecution(s.catalog, s.store, s.input, { ...model, revision: "b".repeat(64), configured: false });
    expect(changed.planHash).not.toBe(ready.planHash); expect(changed.canSubmit).toBe(false);
    expect(segmentTaskKey(s.input)).toBe(segmentTaskKey({ ...s.input }));
    expect(segmentTaskKey({ ...s.input, sequence: 2 })).not.toBe(segmentTaskKey(s.input));
  } finally { s.db.close(); }
});

it("invalidates review and authorization on changed content and preserves historical evidence", () => {
  const s = setup(true);
  try {
    s.price(); s.save(); const old = reviewSegmentPreflight(s.catalog, s.input, review);
    s.db.query("UPDATE production_shot SET duration_ms = 6000 WHERE id = ?").run(s.shotIds[0]!);
    expect(() => s.preview()).toThrow("已变化");
    const next = { ...s.input, inputHash: getEpisodeSegmentPlan(s.catalog, s.projectId, s.episodeId).inputHash };
    const report = previewSegmentExecution(s.catalog, s.store, next, model);
    expect(report.review).toBeNull(); expect(report.canSubmit).toBe(false);
    expect(s.db.query("SELECT id FROM segment_preflight_review").all()).toEqual([{ id: old.id }]);
  } finally { s.db.close(); }
});
