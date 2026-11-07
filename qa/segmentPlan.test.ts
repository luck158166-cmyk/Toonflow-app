import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ProductionCatalog, type EpisodeDraft } from "../packages/production/src/catalog";
import { getEpisodeSegmentPlan, saveEpisodeSegmentPlan } from "../packages/production/src/segmentPlan";
import { createShotFixture, bindFixtureImages } from "./shotPreparationFixture";

function setup(change?: (draft: EpisodeDraft) => void) {
  const db = new Database(":memory:"); const catalog = new ProductionCatalog(db);
  const fixture = createShotFixture(catalog, change); bindFixtureImages(catalog, fixture.projectId);
  const plan = () => getEpisodeSegmentPlan(catalog, fixture.projectId, fixture.episodeId);
  const save = (hash = plan().inputHash) => saveEpisodeSegmentPlan(catalog, fixture.projectId, fixture.episodeId, hash);
  return { db, catalog, ...fixture, plan, save };
}

it("compiles continuous shots into one candidate with shared references, exact dialogue and contiguous clocks", () => {
  const s = setup();
  try {
    const report = s.plan(); expect(report.canSave).toBe(true); expect(report.readyForGeneration).toBe(false);
    expect(report.snapshot.segments).toHaveLength(1);
    const segment = report.snapshot.segments[0]!;
    expect(segment.timeline.map(item => [item.sequence, item.start, item.end])).toEqual([[1, 0, 5], [2, 5, 10]]);
    expect(segment.references.map(item => item.name)).toEqual(["林岚", "林岚", "陈墨", "陈墨", "车站", "铜钥匙"]);
    expect(segment.requestDraft.prompt).toContain("5-10秒");
    expect(segment.requestDraft.prompt.split("给你。")).toHaveLength(2);
    expect(segment.requestDraft.prompt.split("我收好了。")).toHaveLength(2);
    expect(segment.requestDraft.prompt.match(/【素材】/g)).toHaveLength(1);
    const first = s.save(); expect(first.version).toBe(1); expect(s.save().created).toBe(false);
    const stored = s.db.query("SELECT snapshot_json AS value FROM episode_segment_plan WHERE id = ?").get(first.id) as { value: string };
    expect(JSON.parse(stored.value)).toEqual(report.snapshot);
    expect(s.catalog.getProjectProduction(s.projectId).shots.every(item => item.runtimeState === "idle" && item.videoReadiness === "blocked")).toBe(true);
  } finally { s.db.close(); }
});

it("does not confuse a reused scene asset with the same scene occurrence", () => {
  const s = setup(draft => {
    draft.script.push(structuredClone(draft.script[0]));
    draft.shots[1]!.sceneContext!.sceneSequence = 2;
  });
  try {
    const segments = s.plan().snapshot.segments; expect(segments).toHaveLength(2);
    expect(segments.map(item => item.sceneSequence)).toEqual([1, 2]);
    expect(segments[1]!.timeline[0]!.start).toBe(0);
    expect(s.plan().canSave).toBe(true);
  } finally { s.db.close(); }
});

it("handles short tails without changing durations and preserves invalid isolated shots as actionable failures", () => {
  for (const [durations, isolate, expected, allowed] of [
    [[3, 2], false, [5], true], [[13, 3], false, [16], true], [[15, 15], false, [15, 15], true],
    [[2, 5], true, [2, 5], false], [[2.5, 5], false, [2.5, 5], false], [[31, 5], false, [31, 5], false],
  ] as const) {
    const s = setup(draft => {
      draft.shots.forEach((shot, index) => { shot.durationMs = durations[index]! * 1000; });
      if (isolate) draft.shots[0]!.sceneContext = { sceneSequence: 1, isolate: true, reason: "复杂动作独立处理" };
    });
    try {
      const report = s.plan(); expect(report.snapshot.segments.map(item => item.requestDraft.duration)).toEqual([...expected]);
      expect(report.canSave).toBe(allowed);
      expect(report.snapshot.segments.flatMap(item => item.timeline.map(shot => shot.shotId))).toEqual(s.shotIds);
    } finally { s.db.close(); }
  }
});

it("splits environment changes, blocks missing scene context, and refuses cross-project reads", () => {
  const s = setup(draft => { draft.shots[1]!.direction!.environment = "候车厅灯光关闭"; });
  try {
    expect(s.plan().snapshot.segments).toHaveLength(2);
    s.db.query("UPDATE shot_scene_context SET context_json = 'null' WHERE shot_id = ?").run(s.shotIds[0]!);
    expect(s.plan().canSave).toBe(false);
    expect(s.plan().snapshot.segments[0]!.checks.some(item => item.code === "sceneContext" && item.state === "failed")).toBe(true);
    expect(() => s.save()).toThrow("未解决");
    expect(() => getEpisodeSegmentPlan(s.catalog, crypto.randomUUID(), s.episodeId)).toThrow();
  } finally { s.db.close(); }
});

it("splits an overlong combined prompt instead of dropping content", () => {
  const s = setup(draft => { draft.shots.forEach(shot => {
    shot.direction!.action = "人物缓缓伸出手，目光落在钥匙上。".repeat(65);
    shot.direction!.positions.forEach(position => { position.start = position.start.padEnd(400, "。"); position.end = position.end.padEnd(400, "。"); });
  }); });
  try {
    expect(s.plan().canSave).toBe(true);
    expect(s.plan().snapshot.segments).toHaveLength(2);
    expect(s.plan().snapshot.segments.every(item => item.requestDraft.prompt.length <= 4000)).toBe(true);
  } finally { s.db.close(); }
});

it("retains prior plan versions, rejects stale input, and rolls back failed persistence without changing successful tasks", () => {
  const s = setup();
  try {
    const before = s.plan(); const first = s.save();
    s.db.query("UPDATE production_shot SET runtime_state = 'succeeded' WHERE id = ?").run(s.shotIds[0]!);
    expect(s.plan().inputHash).toBe(before.inputHash);
    s.db.query("UPDATE production_shot SET duration_ms = 6000 WHERE id = ?").run(s.shotIds[0]!);
    expect(() => s.save(before.inputHash)).toThrow("已变化");
    const second = s.save(); expect(second.version).toBe(2);
    expect(JSON.parse((s.db.query("SELECT snapshot_json AS value FROM episode_segment_plan WHERE id = ?").get(first.id) as { value: string }).value)).toEqual(before.snapshot);
    s.db.query("UPDATE production_shot SET duration_ms = 7000 WHERE id = ?").run(s.shotIds[0]!);
    s.db.exec("CREATE TRIGGER failPlan BEFORE INSERT ON episode_segment_plan BEGIN SELECT RAISE(ABORT, 'disk fault'); END");
    expect(() => s.save()).toThrow("disk fault");
    expect(s.plan().history).toHaveLength(2);
    expect(s.catalog.getProjectProduction(s.projectId).shots[0]!.runtimeState).toBe("succeeded");
  } finally { s.db.close(); }
});

it("enforces reference limits across the union of characters, not separately for each shot", () => {
  const s = setup(draft => {
    const names = ["赵乙", "孙丙", "周丁"];
    draft.characters.push(...names.map(name => ({ ...structuredClone(draft.characters[0]!), name, aliases: [], stableDescription: name + "测试形象" })));
    const shot = draft.shots[1]!; shot.characterNames = names; shot.dialogue = []; shot.propUses = [];
    shot.direction!.summary = "三人在车站等待"; shot.direction!.action = "三人安静站立";
    shot.direction!.positions = names.map((name, index) => ({ name, start: `站在候车厅第${index + 1}个座位前`, end: "留在原位面向前方" }));
  });
  try {
    const report = s.plan(); expect(report.canSave).toBe(true);
    expect(report.snapshot.segments).toHaveLength(2);
    expect(report.snapshot.segments.map(segment => segment.references.filter(slot => ["headshot", "fullBody"].includes(slot.role)).length)).toEqual([4, 6]);
  } finally { s.db.close(); }
});
