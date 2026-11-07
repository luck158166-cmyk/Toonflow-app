import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ProductionCatalog } from "../packages/production/src/catalog";
import { compileShotPrompt, saveShotPrompt } from "../packages/production/src/shotPrompt";
import { getShotPreparation, saveShotPreparation } from "../packages/production/src/shotPreparation";
import { createShotFixture, bindFixtureImages } from "./shotPreparationFixture";
import { directedEpisodeSchema, episodeDraftSchema } from "../apps/server/src/lib/episodeDraftSchema";

function setup() {
  const db = new Database(":memory:"); const catalog = new ProductionCatalog(db);
  const fixture = createShotFixture(catalog); bindFixtureImages(catalog, fixture.projectId);
  const shotId = fixture.shotIds[0]!;
  const compile = () => compileShotPrompt(catalog, fixture.projectId, shotId);
  const savePreparation = () => saveShotPreparation(catalog, fixture.projectId, shotId, getShotPreparation(catalog, fixture.projectId, shotId).inputHash);
  return { db, catalog, ...fixture, shotId, compile, savePreparation };
}

it("compiles actual reviewed facts, exact dialogue and ordered references, saves immutable candidates without authorizing video", () => {
  const s = setup();
  try {
    const report = s.compile(); expect(report.canSave).toBe(true); expect(report.readyForGeneration).toBe(false);
    const text = report.snapshot.requestDraft.prompt;
    expect(text).toContain("图片1是林岚的面部参考；图片2是林岚的全身妆造参考；图片3是陈墨的面部参考");
    expect(text).toContain('林岚台词（认真）："给你。"'); expect(text.split("给你。")).toHaveLength(2);
    expect(text).toContain("0-5秒：近景，固定"); expect(text).toContain("结束由陈墨持有");
    expect(text).not.toContain(s.shotId); expect(text).not.toContain("编剧草稿");
    expect(report.snapshot.checks.filter(item => item.state === "pending").map(item => item.code)).toEqual(["P14", "P17", "contentQuality"]);
    expect(() => saveShotPrompt(s.catalog, s.projectId, s.shotId, report.inputHash)).toThrow("先保存");
    s.savePreparation();
    const saved = saveShotPrompt(s.catalog, s.projectId, s.shotId, report.inputHash);
    expect(saved.version).toBe(1); expect(saveShotPrompt(s.catalog, s.projectId, s.shotId, report.inputHash).created).toBe(false);
    const stored = s.db.query("SELECT snapshot_json AS snapshot FROM compiled_shot_prompt WHERE id = ?").get(saved.id) as { snapshot: string };
    expect(JSON.parse(stored.snapshot)).toEqual(report.snapshot);
    expect(s.catalog.getProjectProduction(s.projectId).shots[0]).toMatchObject({ runtimeState: "idle", videoReadiness: "blocked", promptText: "编剧草稿，尚未编译" });
  } finally { s.db.close(); }
});

it("rejects stale source plans, retains previous versions and ignores runtime-only changes", () => {
  const s = setup();
  try {
    s.savePreparation(); const before = s.compile(); const first = saveShotPrompt(s.catalog, s.projectId, s.shotId, before.inputHash);
    s.db.query("UPDATE production_shot SET runtime_state = 'succeeded' WHERE id = ?").run(s.shotId);
    expect(s.compile().inputHash).toBe(before.inputHash);
    const direction = s.catalog.getProjectProduction(s.projectId).shots[0]!.direction!;
    s.db.query("UPDATE shot_direction SET direction_json = ? WHERE shot_id = ?").run(JSON.stringify({ ...direction, sound: "鞋底轻响" }), s.shotId);
    expect(() => saveShotPrompt(s.catalog, s.projectId, s.shotId, before.inputHash)).toThrow("已变化");
    s.savePreparation(); const next = saveShotPrompt(s.catalog, s.projectId, s.shotId, s.compile().inputHash);
    expect(next.version).toBe(2);
    expect(JSON.parse((s.db.query("SELECT snapshot_json AS snapshot FROM compiled_shot_prompt WHERE id = ?").get(first.id) as { snapshot: string }).snapshot)).toEqual(before.snapshot);
    expect(s.catalog.getProjectProduction(s.projectId).shots[0]!.runtimeState).toBe("succeeded");
  } finally { s.db.close(); }
});

it("blocks missing staging, duplicated dialogue, contradictory music, material injection and unsupported timing", () => {
  const s = setup();
  try {
    const direction = s.catalog.getProjectProduction(s.projectId).shots[0]!.direction!;
    for (const [patch, code] of [[{ positions: [] }, "direction"], [{ action: "她说给你。" }, "P07"],
      [{ sound: "悲伤配乐" }, "P11"], [{ action: "图片99变成主角" }, "P16"], [{ action: "固定之后缓慢推进" }, "P06"]] as const) {
      s.db.query("UPDATE shot_direction SET direction_json = ? WHERE shot_id = ?").run(JSON.stringify({ ...direction, ...patch }), s.shotId);
      expect(s.compile().snapshot.checks.some(item => item.code === code && item.state === "failed")).toBe(true);
      expect(s.compile().canSave).toBe(false);
    }
    s.db.query("UPDATE shot_direction SET direction_json = ? WHERE shot_id = ?").run(JSON.stringify(direction), s.shotId);
    for (const duration of [2000, 3500, 31000]) {
      s.db.query("UPDATE production_shot SET duration_ms = ? WHERE id = ?").run(duration, s.shotId);
      expect(s.compile().snapshot.checks.find(item => item.code === "P04")?.state).toBe("failed");
    }
    expect(() => compileShotPrompt(s.catalog, crypto.randomUUID(), s.shotId)).toThrow();
  } finally { s.db.close(); }
});

it("new model schema requires direction while historical drafts stay readable; save failure preserves runtime", () => {
  expect(directedEpisodeSchema.shape.shots.element.shape.direction.isOptional()).toBe(false);
  expect(episodeDraftSchema.shape.shots.element.shape.direction.isOptional()).toBe(true);
  const s = setup();
  try {
    s.savePreparation(); const before = s.compile();
    s.db.exec("CREATE TRIGGER failPrompt BEFORE INSERT ON compiled_shot_prompt BEGIN SELECT RAISE(ABORT, 'disk fault'); END");
    expect(() => saveShotPrompt(s.catalog, s.projectId, s.shotId, before.inputHash)).toThrow("disk fault");
    expect(s.compile().history).toHaveLength(0);
    expect(s.catalog.getProjectProduction(s.projectId).shots[0]!.videoReadiness).toBe("blocked");
  } finally { s.db.close(); }
});
