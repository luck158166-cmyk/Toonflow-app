import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { episodeDraftSchema } from "../apps/server/src/lib/episodeDraftSchema";
import { applyEpisodeDraft, ProductionCatalog } from "../packages/production/src/catalog";
import { indexNovel } from "../packages/production/src/novelAdaptation";

const sourceText = "第一章 归来\n林岚走进车站，拾起铜钥匙。";
function draft() {
  const evidence = [{ sourceHash: indexNovel(sourceText).sourceHash, chapterSequence: 1,
    lineStart: 2, lineEnd: 2, quote: "林岚走进车站，拾起铜钥匙。" }];
  return { episodeNumber: 1, title: "归来", logline: "林岚发现钥匙", outline: ["发现钥匙"],
    script: [{ location: "车站", characters: ["林岚"], evidence,
      beats: [{ type: "action", text: "林岚拾起钥匙" }] }],
    scenes: [{ name: "车站", location: "车站", atmosphere: "安静", timeWeather: "日", evidence }],
    characters: [{ name: "林岚", aliases: [], stableDescription: "黑发女子", firstAppearance: "第一章", evidence }],
    props: [{ name: "铜钥匙", aliases: [], stableDescription: "铜制钥匙", firstAppearance: "第一章", evidence }],
    shots: [{ sequence: 1, sceneName: "车站", title: "拾起钥匙", scriptExcerpt: "林岚拾起钥匙", evidence,
      durationMs: 5000, shotSize: "近景", movement: "固定", promptText: "", characterNames: ["林岚"],
      propUses: [{ name: "铜钥匙", holderAfterName: "林岚", stateBefore: "地面上", stateAfter: "手中",
        interaction: "拾起", evidence }], dialogue: [] }],
  };
}

it("validates an external draft and adopts script, assets and shots together, without confirming generation", () => {
  const db = new Database(":memory:");
  try {
    const catalog = new ProductionCatalog(db);
    const projectId = catalog.importStory({ title: "测试", sourceKind: "novel", sourceText });
    const parsed = episodeDraftSchema.parse(draft());
    const result = applyEpisodeDraft(catalog, projectId, parsed);
    const snapshot = catalog.getProjectProduction(projectId);
    expect(result.awaitingReview).toBe(true);
    expect(snapshot.episodes).toHaveLength(1);
    expect(snapshot.assets).toHaveLength(2);
    expect(snapshot.shots).toHaveLength(1);
    expect(snapshot.shots[0].reviewState).toBe("draft");
    expect(snapshot.shots[0].videoReadiness).toBe("blocked");
    expect(() => applyEpisodeDraft(catalog, projectId, parsed)).toThrow();
    expect(catalog.getProjectProduction(projectId).shots).toHaveLength(1);
  } finally { db.close(); }
});

it("rejects malformed outputs and forged novel evidence before any episode is persisted", () => {
  expect(episodeDraftSchema.safeParse({ ...draft(), shots: [{ ...draft().shots[0], durationMs: -1 }] }).success).toBe(false);
  expect(episodeDraftSchema.safeParse({ ...draft(), characters: null }).success).toBe(false);
  expect(episodeDraftSchema.safeParse({ ...draft(), approved: true }).success).toBe(false);
  const db = new Database(":memory:");
  try {
    const catalog = new ProductionCatalog(db);
    const projectId = catalog.importStory({ title: "测试", sourceKind: "novel", sourceText });
    const invalid = draft(); invalid.shots[0].evidence = [{ ...invalid.shots[0].evidence[0], quote: "原文不存在的话" }];
    expect(() => applyEpisodeDraft(catalog, projectId, episodeDraftSchema.parse(invalid))).toThrow("原文证据无效");
    const snapshot = catalog.getProjectProduction(projectId);
    expect(snapshot.episodes).toHaveLength(0);
    expect(snapshot.assets).toHaveLength(0);
    expect(snapshot.shots).toHaveLength(0);
  } finally { db.close(); }
});
