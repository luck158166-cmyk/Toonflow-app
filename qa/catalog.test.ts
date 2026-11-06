import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { applyEpisodeDraft, ProductionCatalog, type EpisodeDraft } from "../packages/production/src/catalog";
import { ProductionStore } from "../packages/production/src/store";

describe("structured production catalog", () => {
  it("imports a story and prepares an eight-shot episode with characters, scenes, evidence and separated states", () => {
    const db = new Database(":memory:");
    new ProductionStore(db);
    const catalog = new ProductionCatalog(db);
    const projectId = catalog.importStory({
      title: "雾港来信",
      sourceKind: "synopsis",
      sourceText: "林澄回到雾港寻找失踪父亲，旧友沈舟发现灯塔地下藏着一封寄给未来的信。",
    });
    catalog.saveStoryAnalysis(projectId, {
      events: [{ id: "event-1", evidence: "回到雾港寻找失踪父亲" }],
      relations: [{ source: "林澄", target: "沈舟", relation: "旧友" }],
    }, 1);
    const episodeId = catalog.createEpisode(projectId, 1, "潮汐之下", "旧友在灯塔发现一封来信。");
    catalog.saveEpisodeScript(episodeId, [{ scene: "外景·港口", beats: ["林澄上岸", "沈舟递出信封"] }], "confirmed");
    const scenes = [
      catalog.upsertScene({ projectId, name: "雾港码头", location: "北岸", atmosphere: "潮湿浓雾", evidence: ["回到雾港"] }),
      catalog.upsertScene({ projectId, name: "旧书店", location: "钟楼街", atmosphere: "暖黄灯光", evidence: ["旧书店重逢"] }),
      catalog.upsertScene({ projectId, name: "灯塔地下室", location: "岬角", atmosphere: "冷蓝微光", evidence: ["地下藏信"] }),
    ];
    const characters = [
      catalog.upsertAsset({ projectId, kind: "character", name: "林澄", stableDescription: "短发，深色风衣", evidence: ["林澄回到雾港"], firstAppearance: "第一幕" }),
      catalog.upsertAsset({ projectId, kind: "character", name: "沈舟", stableDescription: "黑发，旧书店主", evidence: ["旧友沈舟"], firstAppearance: "第二幕" }),
    ];

    for (let sequence = 1; sequence <= 8; sequence += 1) {
      const sceneId = scenes[(sequence - 1) % scenes.length];
      const shotId = catalog.createShot({ projectId, episodeId, sequence, sceneId,
        title: `镜头${sequence}`, scriptExcerpt: `角色在${sequence}个节拍中靠近线索。`, evidence: [`剧本原文片段${sequence}`] });
      catalog.linkCharacterToShot(shotId, characters[(sequence - 1) % characters.length]);
      catalog.addExtractedCandidate({ projectId, episodeId, shotId, kind: "prop",
        value: { name: `信件${sequence}` }, evidence: [`原文证据${sequence}`], confidence: 0.92 });
      catalog.addDialogue({ shotId, sequence: 1, kind: sequence === 8 ? "narration" : "dialogue",
        speakerId: sequence === 8 ? undefined : characters[(sequence - 1) % characters.length],
        text: sequence === 8 ? "潮水会替我们保管秘密。" : "你也收到那封信了吗？" });
      catalog.setShotWorkflowState(shotId, { reviewState: "confirmed", runtimeState: "idle", videoReadiness: "ready" });
    }

    const readiness = catalog.validateEpisodeForSynthesis(episodeId);
    expect(readiness).toEqual({ ready: true, issues: [], shotCount: 8, characterCount: 2, sceneCount: 3 });
    expect(db.query(`SELECT review_state, runtime_state, video_readiness FROM production_shot LIMIT 1`).get())
      .toEqual({ review_state: "confirmed", runtime_state: "idle", video_readiness: "ready" });

    const lockedCharacter = characters[0];
    catalog.setAssetLocked(lockedCharacter, true);
    expect(() => catalog.upsertAsset({ projectId, id: lockedCharacter, kind: "character", name: "林澄",
      stableDescription: "试图覆盖锁定资产", evidence: ["变更"] })).toThrow("Locked assets");
    db.close();
  });

  it("applies a structured episode draft atomically and leaves semi-automatic review pending", () => {
    const db = new Database(":memory:");
    const catalog = new ProductionCatalog(db);
    const projectId = catalog.importStory({ title: "回声灯塔", sourceKind: "synopsis", sourceText: "两位旧友在海港寻找失踪的电台信号。" });
    const draft: EpisodeDraft = {
      episodeNumber: 1, title: "第一封电报", logline: "旧友发现来自灯塔的求救信号。",
      outline: ["码头重逢", "书店发现线索", "灯塔下收到信号"],
      script: [{ scene: "码头", dialogue: ["今晚的雾不对劲。"] }],
      scenes: [
        { name: "码头", location: "北岸", atmosphere: "大雾", timeWeather: "夜", evidence: ["抵达码头"] },
        { name: "书店", location: "钟楼街", atmosphere: "昏黄", timeWeather: "夜", evidence: ["重逢书店"] },
        { name: "灯塔", location: "岬角", atmosphere: "风暴", timeWeather: "夜", evidence: ["灯塔信号"] },
      ],
      characters: [
        { name: "林澄", aliases: ["小澄"], stableDescription: "黑发，雨衣", evidence: ["林澄走上码头"], firstAppearance: "开场" },
        { name: "沈舟", aliases: [], stableDescription: "卷发，旧式收音机", evidence: ["沈舟打开收音机"], firstAppearance: "书店" },
      ],
      shots: Array.from({ length: 8 }, (_, index) => ({ sequence: index + 1,
        sceneName: ["码头", "书店", "灯塔"][index % 3], title: `镜头${index + 1}`,
        scriptExcerpt: `两人继续调查线索${index + 1}。`, evidence: [`原文片段${index + 1}`],
        durationMs: 5000, shotSize: "MS", movement: "缓慢推进", promptText: `镜头提示${index + 1}`,
        characterNames: index % 2 ? ["沈舟"] : ["林澄"],
        dialogue: [{ kind: index === 7 ? "narration" as const : "dialogue" as const,
          speakerName: index === 7 ? undefined : (index % 2 ? "沈舟" : "林澄"), text: `台词${index + 1}` }],
      })),
    };

    const applied = applyEpisodeDraft(catalog, projectId, draft);
    expect(applied.awaitingReview).toBe(true);
    expect(Array.isArray(applied.shotIds)).toBe(true);
    expect(catalog.validateEpisodeForSynthesis(applied.episodeId).ready).toBe(false);
    expect(db.query("SELECT COUNT(*) AS count FROM production_shot WHERE episode_id = ?").get(applied.episodeId))
      .toEqual({ count: 8 });
    for (const shotId of applied.shotIds) catalog.setShotWorkflowState(shotId,
      { reviewState: "confirmed", videoReadiness: "ready" });
    expect(catalog.validateEpisodeForSynthesis(applied.episodeId).ready).toBe(true);

    const invalidDraft = { ...draft, episodeNumber: 2, shots: draft.shots.map((shot, index) =>
      index === 0 ? { ...shot, characterNames: ["missing"] } : shot) };
    expect(() => applyEpisodeDraft(catalog, projectId, invalidDraft)).toThrow("unknown character");
    expect(db.query("SELECT COUNT(*) AS count FROM production_episode WHERE project_id = ?").get(projectId))
      .toEqual({ count: 1 });
    db.close();
  });
});
