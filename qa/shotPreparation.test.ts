import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ProductionCatalog } from "../packages/production/src/catalog";
import { getShotPreparation, saveShotPreparation } from "../packages/production/src/shotPreparation";
import { listReferenceTargets, bindAssetReference } from "../packages/production/src/assetReference";
import { createShotFixture, bindFixtureImages } from "./shotPreparationFixture";
import { getEpisodeReview, reviewEpisode } from "../packages/production/src/episodeReview";

function setup() {
  const db = new Database(":memory:"); const catalog = new ProductionCatalog(db);
  const fixture = createShotFixture(catalog); const shotId = fixture.shotIds[0]!;
  const read = () => getShotPreparation(catalog, fixture.projectId, shotId);
  const save = (hash = read().inputHash) => saveShotPreparation(catalog, fixture.projectId, shotId, hash);
  return { db, catalog, ...fixture, shotId, read, save };
}

it("blocks incomplete references and snapshots exact ordered images, dialogue and surrounding shots", () => {
  const s = setup();
  try {
    expect(s.read().issues.filter(item => item.code === "missingReference")).toHaveLength(6);
    expect(s.save).toThrow("缺少");
    bindFixtureImages(s.catalog, s.projectId);
    const report = s.read();
    expect(report.issues).toEqual([]);
    expect(report.snapshot.references.map(item => `${item.name}:${item.role}`)).toEqual([
      "林岚:headshot", "林岚:fullBody", "陈墨:headshot", "陈墨:fullBody", "车站:scene", "铜钥匙:prop"]);
    expect(report.snapshot.dialogue[0]!.text).toBe("给你。");
    expect(report.snapshot.continuity.nextShot?.title).toBe("收好钥匙");
    const saved = s.save(); expect(saved.version).toBe(1);
    expect(s.save()).toEqual({ ...saved, created: false });
    const row = s.db.query("SELECT snapshot_json AS snapshot FROM shot_preparation WHERE id = ?").get(saved.id) as { snapshot: string };
    expect(JSON.parse(row.snapshot)).toEqual(report.snapshot);
    expect(s.catalog.getProjectProduction(s.projectId).shots[0]).toMatchObject({ runtimeState: "idle", videoReadiness: "blocked" });
  } finally { s.db.close(); }
});

it("rejects stale plans on replacement and retains prior immutable reference versions", () => {
  const s = setup();
  try {
    bindFixtureImages(s.catalog, s.projectId); const before = s.read(); const first = s.save();
    const slot = before.snapshot.references[0]!; const target = listReferenceTargets(s.catalog, s.projectId).find(item => item.entityId === slot.entityId)!;
    bindAssetReference(s.catalog, { projectId: s.projectId, entityKind: target.entityKind, entityId: target.entityId,
      entityHash: target.entityHash, role: slot.role, expectedReferenceId: slot.reference!.id, rightsConfirmed: true,
      sourceNote: "QA 新版本", file: { ...slot.reference!, path: `assets/productionReferences/${"f".repeat(64)}.png`, sha256: "f".repeat(64) } });
    expect(() => s.save(before.inputHash)).toThrow("已变化");
    expect(s.save().version).toBe(2);
    const old = s.db.query("SELECT snapshot_json AS snapshot FROM shot_preparation WHERE id = ?").get(first.id) as { snapshot: string };
    expect(JSON.parse(old.snapshot).references[0].reference.id).toBe(slot.reference!.id);
    expect(s.read().history).toHaveLength(2);
  } finally { s.db.close(); }
});

it("detects prop discontinuity and changed source without invalidating for runtime progress", () => {
  const s = setup();
  try {
    bindFixtureImages(s.catalog, s.projectId); const initial = s.read().inputHash;
    s.catalog.setShotWorkflowState(s.shotId, { runtimeState: "running" });
    expect(s.read().inputHash).toBe(initial);
    const next = () => getShotPreparation(s.catalog, s.projectId, s.shotIds[1]!);
    expect(next().snapshot.continuity.priorProps[0]?.previous?.shotId).toBe(s.shotId);
    const nextHash = next().inputHash;
    s.db.query("UPDATE shot_prop_link SET state_after = '损坏' WHERE shot_id = ?").run(s.shotId);
    expect(next().issues.some(item => item.code === "propContinuity")).toBe(true);
    expect(next().inputHash).not.toBe(nextHash);
    s.db.query("UPDATE production_project SET source_text = source_text || '修改' WHERE id = ?").run(s.projectId);
    expect(() => s.save(initial)).toThrow("已变化");
  } finally { s.db.close(); }
});

it("rejects cross-story access, stale descriptions and unreviewed content", () => {
  const s = setup();
  try {
    bindFixtureImages(s.catalog, s.projectId);
    const other = s.catalog.importStory({ title: "其他故事", sourceKind: "synopsis", sourceText: "其他" });
    expect(() => getShotPreparation(s.catalog, other, s.shotId)).toThrow("没有这个镜头");
    const slot = s.read().snapshot.references[0]!;
    s.db.query("UPDATE production_asset SET stable_description = 'changed' WHERE id = ?").run(slot.entityId);
    expect(s.read().issues.some(item => item.code === "staleReference")).toBe(true);
    s.catalog.setShotWorkflowState(s.shotId, { reviewState: "draft" });
    expect(s.read().issues.some(item => item.code === "review")).toBe(true);
    expect(s.save).toThrow(); expect(s.read().history).toEqual([]);
  } finally { s.db.close(); }
});

it("rolls back failed snapshot persistence and preserves successful production state", () => {
  const s = setup();
  try {
    bindFixtureImages(s.catalog, s.projectId); const saved = s.save();
    s.catalog.setShotWorkflowState(s.shotId, { runtimeState: "succeeded" });
    s.catalog.setShotPrompt(s.shotId, "新草稿");
    s.db.exec("CREATE TRIGGER failPreparation BEFORE INSERT ON shot_preparation BEGIN SELECT RAISE(ABORT, 'snapshot fault'); END");
    expect(s.save).toThrow("snapshot fault");
    expect(s.read().history).toHaveLength(1); expect(s.read().history[0]!.id).toBe(saved.id);
    expect(s.catalog.getProjectProduction(s.projectId).shots[0]!.runtimeState).toBe("succeeded");
  } finally { s.db.close(); }
});

it("checks per-shot dialogue duration and retains offscreen speaker identity", () => {
  const s = setup();
  try {
    bindFixtureImages(s.catalog, s.projectId);
    const narratorId = s.catalog.upsertAsset({ projectId: s.projectId, kind: "character", name: "旁白人物", stableDescription: "画外说话", evidence: [] });
    s.catalog.addDialogue({ shotId: s.shotId, sequence: 2, kind: "voiceover", speakerId: narratorId, text: "这是一段超出当前镜头容量的长画外音，需要拆分镜头后才能使用。" });
    const report = s.read();
    expect(report.snapshot.dialogue[1]!.speakerName).toBe("旁白人物");
    expect(report.issues.some(item => item.code === "dialogueDuration")).toBe(true);
    expect(() => s.save(report.inputHash)).toThrow();
  } finally { s.db.close(); }
});

it("inherits the last prop state across episode boundaries", () => {
  const s = setup();
  try {
    bindFixtureImages(s.catalog, s.projectId);
    const project = s.catalog.getProjectProduction(s.projectId);
    const previousShot = project.shots[1]!; const previousProp = project.shotProps.find(item => item.shotId === previousShot.id)!;
    const episodeId = s.catalog.createEpisode(s.projectId, 2, "继续", "继续保管钥匙");
    s.catalog.saveEpisodeOutline(episodeId, ["继续保管钥匙"]);
    s.catalog.saveEpisodeScript(episodeId, project.episodes[0]!.script);
    const shotId = s.catalog.createShot({ projectId: s.projectId, episodeId, sequence: 1, sceneId: previousShot.sceneId!,
      title: "保管钥匙", scriptExcerpt: "陈墨拿着钥匙。", evidence: previousShot.evidence, durationMs: 5000 });
    s.catalog.linkCharacterToShot(shotId, previousProp.holderAfterId!);
    s.catalog.linkPropToShot({ shotId, propId: previousProp.propId, holderBeforeId: previousProp.holderAfterId!,
      holderAfterId: previousProp.holderAfterId!, stateBefore: "完整", stateAfter: "完整", interaction: "持有", evidence: previousProp.evidence });
    const review = getEpisodeReview(s.catalog, s.projectId, episodeId);
    reviewEpisode(s.catalog, { projectId: s.projectId, episodeId, snapshotHash: review.snapshotHash, decision: "confirmed", note: "QA" });
    const read = () => getShotPreparation(s.catalog, s.projectId, shotId);
    expect(read().issues).toEqual([]);
    expect(read().snapshot.continuity.priorProps[0]!.previous?.shotId).toBe(previousShot.id);
    const hash = read().inputHash;
    s.db.query("UPDATE shot_prop_link SET state_after = '损坏' WHERE shot_id = ?").run(previousShot.id);
    expect(read().inputHash).not.toBe(hash);
    expect(read().issues.some(item => item.code === "propContinuity")).toBe(true);
  } finally { s.db.close(); }
});
