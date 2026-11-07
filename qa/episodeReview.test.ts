import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "@toonflow/file";
import { ProductionCatalog, applyEpisodeDraft, type EpisodeDraft } from "../packages/production/src/catalog";
import { getEpisodeReview, reviewEpisode } from "../packages/production/src/episodeReview";
import { buildAdaptationInput } from "../packages/production/src/adaptationInput";
import { indexNovel } from "../packages/production/src/novelAdaptation";

function setup(db: Database) {
  const catalog = new ProductionCatalog(db);
  const sourceText = "第一章 钥匙\n" + "林岚在车站把铜钥匙递给陈墨。".repeat(12);
  const projectId = catalog.importStory({ title: "钥匙", sourceKind: "novel", sourceText });
  const evidence = [{ sourceHash: indexNovel(sourceText).sourceHash, chapterSequence: 1, lineStart: 2, lineEnd: 2, quote: "林岚在车站把铜钥匙递给陈墨。" }];
  const draft: EpisodeDraft = { episodeNumber: 1, title: "交接", logline: "交出钥匙", outline: ["交出钥匙"],
    script: [{ location: "车站", characters: ["林岚", "陈墨"], evidence, beats: [{ type: "action", text: "林岚递出钥匙" }] }],
    scenes: [{ name: "车站", location: "候车厅", atmosphere: "安静", timeWeather: "夜", evidence }],
    characters: ["林岚", "陈墨"].map(name => ({ name, aliases: [], stableDescription: name + "的固定外观", evidence, firstAppearance: "第一章" })),
    props: [{ name: "铜钥匙", aliases: [], stableDescription: "旧铜钥匙", evidence, firstAppearance: "第一章" }],
    shots: [{ sequence: 1, sceneName: "车站", title: "交出钥匙", scriptExcerpt: "林岚递出钥匙", evidence,
      durationMs: 5000, shotSize: "近景", movement: "固定", promptText: "", characterNames: ["林岚", "陈墨"],
      dialogue: [{ kind: "dialogue", speakerName: "林岚", text: "给你。", emotion: "认真" }],
      propUses: [{ name: "铜钥匙", holderBeforeName: "林岚", holderAfterName: "陈墨", stateBefore: "完整",
        stateAfter: "完整", interaction: "交接", evidence }] }] };
  const adopted = applyEpisodeDraft(catalog, projectId, draft);
  const episodeId = adopted.episodeId;
  const review = () => getEpisodeReview(catalog, projectId, episodeId);
  const decide = (snapshotHash = review().snapshotHash, decision: "confirmed" | "changes_requested" = "confirmed", note = "") =>
    reviewEpisode(catalog, { projectId, episodeId, snapshotHash, decision, note });
  const next = () => buildAdaptationInput(catalog, projectId, { episodeNumber: 2, firstChapter: 1,
    lastChapter: 1, targetSeconds: 5, genre: "悬疑", visualStyle: "动画" }, {});
  return { catalog, projectId, episodeId, sourceText, draft, adopted, review, decide, next };
}

it("confirms persisted content once, locks only referenced assets and enables continued adaptation", () => {
  const directory = mkdtempSync(join(tmpdir(), "episodeReview"));
  let db = new Database(join(directory, "project.db"));
  try {
    const s = setup(db);
    const unused = s.catalog.upsertAsset({ projectId: s.projectId, name: "未出场的人", kind: "character",
      stableDescription: "未用于本集", evidence: [] });
    expect(s.next).toThrow("前序分集");
    const input = s.review();
    expect(input.issues).toEqual([]);
    expect(input.snapshot.dialogue[0]?.text).toBe("给你。");
    expect(input.history).toHaveLength(0);
    const first = s.decide(input.snapshotHash);
    expect(first.alreadyReviewed).toBe(false);
    expect(s.decide(input.snapshotHash)).toEqual({ ...first, alreadyReviewed: true });
    const after = s.review();
    expect(after.snapshot.episode.reviewState).toBe("confirmed");
    expect(after.snapshot.assets.every(item => item.locked)).toBe(true);
    expect(after.snapshot.scenes.every(item => item.locked)).toBe(true);
    expect(s.catalog.getProjectProduction(s.projectId).assets.find(item => item.id === unused)?.locked).toBe(false);
    expect(s.catalog.getProjectProduction(s.projectId).shots[0]).toMatchObject({ reviewState: "confirmed", runtimeState: "idle", videoReadiness: "blocked" });
    const next = JSON.parse(s.next().requestJson);
    expect(next.continuity.priorEpisodes[0].script).toEqual(s.draft.script);
    expect(next.continuity.propStates[0]).toMatchObject({ name: "铜钥匙", holderName: "陈墨", state: "完整" });
    db.close(); db = new Database(join(directory, "project.db"));
    const restored = new ProductionCatalog(db);
    expect(getEpisodeReview(restored, s.projectId, s.episodeId).history).toHaveLength(1);
    expect(reviewEpisode(restored, { projectId: s.projectId, episodeId: s.episodeId, snapshotHash: input.snapshotHash,
      decision: "confirmed", note: "" }).alreadyReviewed).toBe(true);
    const second: EpisodeDraft = { ...s.draft, episodeNumber: 2, scenes: [{ ...s.draft.scenes[0]!, location: "不相同的地点" }] };
    expect(() => applyEpisodeDraft(restored, s.projectId, second)).toThrow("Locked scene");
    expect(restored.listEpisodes(s.projectId)).toHaveLength(1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("rejects stale reviews for changed source, dialogue, prompt and asset descriptions", () => {
  for (const field of ["source", "dialogue", "prompt", "asset"]) {
    const db = new Database(":memory:");
    try {
      const s = setup(db); const before = s.review();
      if (field === "source") db.query("UPDATE production_project SET source_text = ? WHERE id = ?").run(s.sourceText + "变更", s.projectId);
      if (field === "dialogue") db.query("UPDATE shot_dialogue SET text = ? WHERE id = ?").run("新的台词", before.snapshot.dialogue[0]!.id);
      if (field === "prompt") s.catalog.setShotPrompt(s.adopted.shotIds[0]!, "新提示词");
      if (field === "asset") s.catalog.upsertAsset({ projectId: s.projectId, id: s.adopted.characterIds[0],
        kind: "character", name: "林岚", stableDescription: "新的外观", evidence: [] });
      expect(() => s.decide(before.snapshotHash)).toThrow("内容已变化");
      expect(s.review().history).toHaveLength(0);
      expect(s.catalog.getEpisode(s.episodeId)?.reviewState).toBe("draft");
    } finally { db.close(); }
  }
});

it("refuses broken evidence, supports explicit rejection and prevents stale confirmation replay", () => {
  const db = new Database(":memory:");
  try {
    const s = setup(db); const before = s.review(); s.decide(before.snapshotHash);
    const confirmed = s.review();
    expect(() => s.decide(confirmed.snapshotHash, "changes_requested", "  ")).toThrow("具体问题");
    s.decide(confirmed.snapshotHash, "changes_requested", "道具归属需要核对");
    expect(s.review().snapshot.episode.reviewState).toBe("changes_requested");
    expect(s.next).toThrow("前序分集");
    expect(() => s.decide(before.snapshotHash)).toThrow("内容已变化");
    expect(s.review().history[0]?.note).toBe("道具归属需要核对");
    expect(s.review().snapshot.assets.every(item => item.locked)).toBe(true);
    db.query("UPDATE production_project SET source_text = ? WHERE id = ?").run(s.sourceText + "新版本", s.projectId);
    expect(s.review().issues.some(item => item.includes("哈希"))).toBe(true);
    expect(() => s.decide()).toThrow("尚不能确认");
  } finally { db.close(); }
});

it("rolls back episode, shots and locks if receipt persistence fails", () => {
  const db = new Database(":memory:");
  try {
    const s = setup(db);
    db.exec("CREATE TRIGGER refuseReview BEFORE INSERT ON episode_review BEGIN SELECT RAISE(ABORT, 'review fault'); END");
    expect(s.decide).toThrow("review fault");
    expect(s.review().snapshot.episode.reviewState).toBe("draft");
    expect(s.review().snapshot.assets.every(item => !item.locked)).toBe(true);
    expect(s.review().snapshot.scenes.every(item => !item.locked)).toBe(true);
    expect(s.review().snapshot.shots[0]?.reviewState).toBe("draft");
    expect(s.review().history).toHaveLength(0);
  } finally { db.close(); }
});

it("checks story ownership and protects already-created successors", () => {
  const db = new Database(":memory:");
  try {
    const s = setup(db); s.decide();
    const other = s.catalog.importStory({ title: "另一个故事", sourceKind: "synopsis", sourceText: "无关内容" });
    expect(() => getEpisodeReview(s.catalog, other, s.episodeId)).toThrow("没有这个分集");
    expect(() => reviewEpisode(s.catalog, { projectId: other, episodeId: s.episodeId,
      snapshotHash: s.review().snapshotHash, decision: "changes_requested", note: "跨故事" })).toThrow("没有这个分集");
    s.catalog.createEpisode(s.projectId, 2, "续集", "");
    expect(s.review().hasSuccessor).toBe(true);
    expect(() => s.decide(undefined, "changes_requested", "修改前集")).toThrow("后续分集");
    expect(s.catalog.getEpisode(s.episodeId)?.reviewState).toBe("confirmed");
  } finally { db.close(); }
});

it("rejection invalidates video readiness without rewriting successful task state", () => {
  const db = new Database(":memory:");
  try {
    const s = setup(db); s.decide();
    s.catalog.setShotWorkflowState(s.adopted.shotIds[0]!, { runtimeState: "succeeded", videoReadiness: "ready" });
    s.decide(undefined, "changes_requested", "成片中的动作不符合剧本");
    expect(s.catalog.getProjectProduction(s.projectId).shots[0]).toMatchObject({
      reviewState: "changes_requested", runtimeState: "succeeded", videoReadiness: "blocked",
    });
    expect(s.review().snapshot.assets.every(item => item.locked)).toBe(true);
  } finally { db.close(); }
});
