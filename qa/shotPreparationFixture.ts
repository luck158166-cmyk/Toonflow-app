import { applyEpisodeDraft, type ProductionCatalog, type EpisodeDraft } from "../packages/production/src/catalog";
import { getEpisodeReview, reviewEpisode } from "../packages/production/src/episodeReview";
import { listReferenceTargets, bindAssetReference, type BindReferenceInput } from "../packages/production/src/assetReference";
import { indexNovel } from "../packages/production/src/novelAdaptation";

export function createShotFixture(catalog: ProductionCatalog) {
  const sourceText = "第一章 交接\n" + "林岚把钥匙交给陈墨，陈墨收好钥匙。".repeat(12);
  const projectId = catalog.importStory({ title: "镜头资料验证", sourceKind: "novel", sourceText });
  const evidence = [{ sourceHash: indexNovel(sourceText).sourceHash, chapterSequence: 1, lineStart: 2, lineEnd: 2, quote: "林岚把钥匙交给陈墨" }];
  const draft: EpisodeDraft = { episodeNumber: 1, title: "交接", logline: "交出钥匙", outline: ["交出钥匙", "收好钥匙"],
    script: [{ location: "车站", characters: ["林岚", "陈墨"], evidence, beats: [{ type: "action", text: "林岚递出钥匙，陈墨收好。" }] }],
    scenes: [{ name: "车站", location: "候车厅", atmosphere: "安静", timeWeather: "夜", evidence }],
    characters: ["林岚", "陈墨"].map(name => ({ name, aliases: [], stableDescription: name + "的固定外观", evidence, firstAppearance: "第一章" })),
    props: [{ name: "铜钥匙", aliases: [], stableDescription: "旧铜钥匙", evidence, firstAppearance: "第一章" }],
    shots: [1, 2].map(sequence => ({ sequence, sceneName: "车站", title: sequence === 1 ? "交出钥匙" : "收好钥匙",
      scriptExcerpt: sequence === 1 ? "林岚递出钥匙，陈墨接过。" : "陈墨收好钥匙，林岚转身。", evidence,
      durationMs: 5000, shotSize: "近景", movement: "固定", promptText: "编剧草稿，尚未编译", characterNames: ["陈墨", "林岚"],
      direction: { summary: sequence === 1 ? "车站中林岚将钥匙交给陈墨" : "车站中陈墨收好钥匙",
        action: sequence === 1 ? "林岚伸手递出钥匙，陈墨抬手接过，神情认真" : "陈墨将钥匙装进口袋，林岚转身",
        camera: "固定", positions: [{ name: "林岚", start: "位于画面左侧，面向右侧陈墨，视线落在钥匙上",
          end: sequence === 1 ? "仍在左侧，面向右侧陈墨" : "仍在左侧，转身面向左侧出口" },
          { name: "陈墨", start: "位于画面右侧，面向左侧林岚",
            end: sequence === 1 ? "仍在右侧，视线落向手中的钥匙" : "仍在右侧，钥匙已放入口袋，视线转向林岚" }],
        environment: "夜间候车厅冷色顶灯照明，背景安静", style: "写实短剧，自然表演", sound: "钥匙轻响" },
      dialogue: [{ kind: "dialogue", speakerName: sequence === 1 ? "林岚" : "陈墨", text: sequence === 1 ? "给你。" : "我收好了。", emotion: "认真" }],
      propUses: [{ name: "铜钥匙", holderBeforeName: sequence === 1 ? "林岚" : "陈墨", holderAfterName: "陈墨",
        stateBefore: "完整", stateAfter: "完整", interaction: sequence === 1 ? "交接" : "收好", evidence }] })) };
  const result = applyEpisodeDraft(catalog, projectId, draft);
  const review = getEpisodeReview(catalog, projectId, result.episodeId);
  reviewEpisode(catalog, { projectId, episodeId: result.episodeId, snapshotHash: review.snapshotHash, decision: "confirmed", note: "QA fixture" });
  return { projectId, episodeId: result.episodeId, shotIds: result.shotIds };
}

export function bindFixtureImages(catalog: ProductionCatalog, projectId: string, file?: BindReferenceInput["file"]) {
  let counter = 1;
  for (const target of listReferenceTargets(catalog, projectId)) for (const role of target.roles) {
    const sha256 = (counter++).toString(16).padStart(64, "0");
    bindAssetReference(catalog, { projectId, entityKind: target.entityKind, entityId: target.entityId,
      entityHash: target.entityHash, role, expectedReferenceId: null, rightsConfirmed: true, sourceNote: "QA 测试素材",
      file: file ?? { path: `assets/productionReferences/${sha256}.png`, sha256, mimeType: "image/png", width: 512, height: 512 } });
  }
}
