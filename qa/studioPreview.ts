import { createApp, h } from "../apps/web/node_modules/vue/dist/vue.esm-bundler.js";
import productionApi, { type EpisodeReview } from "../apps/web/src/lib/productionApi";
import "../apps/web/node_modules/element-plus/dist/index.css";
import dashboard from "../apps/web/src/pages/production/dashboard.vue";
if (new URLSearchParams(location.search).get("stage") === "videoAdoption") {
  document.querySelector("#notice")!.textContent = "片段采用与合成验证 · 视频为本地色块和纯音 · 模型网络全拦截，无真实费用";
  const fixture = await (await fetch("/qa/referenceFixture")).json();
  const { default: videoTaskPanel } = await import("../apps/web/src/pages/production/videoTaskPanel.vue");
  const { default: episodeTimelinePanel } = await import("../apps/web/src/pages/production/episodeTimelinePanel.vue");
  const { createPinia } = await import("../apps/web/node_modules/pinia/dist/pinia.js");
  createApp({ render: () => h("main", [h(videoTaskPanel, fixture), h(episodeTimelinePanel, fixture)]) }).use(createPinia()).mount("#app");
} else if (new URLSearchParams(location.search).get("stage") === "videoTasks") {
  document.querySelector("#notice")!.textContent = "视频任务界面验证 · 页面内模拟，不发送模型请求";
  const { default: videoTaskPanel } = await import("../apps/web/src/pages/production/videoTaskPanel.vue");
  productionApi.recoverVideoTask = async () => ({ state: "reconcile_required", message: "供应商接单状态待核对，保留预留费用，不会重新生成。" });
  createApp({ render: () => h(videoTaskPanel, { directory: "QA", projectId: "qa-project",
    episodes: [{ id: "qa-episode", episodeNumber: 1, title: "雨夜" }],
    tasks: [{ id: "qa-task", episodeId: "qa-episode", stage: "video", hostTaskId: "qa-task", segmentKey: "方案 v1 · 片段 1", modelId: "Seedance 2.5", state: "reconcile_required" }],
    onChanged: () => { document.querySelector("#notice")!.textContent = "已触发任务资料刷新 · QA 页面模拟，无模型调用"; } }) }).mount("#app");
} else if (new URLSearchParams(location.search).get("stage") === "emptyModels") {
  document.querySelector("#notice")!.textContent = "缺少模型配置验证 · 真实设置面板，编剧模型列表模拟为空";
  const { default: adaptationRun } = await import("../apps/web/src/pages/production/adaptationRun.vue");
  const { createPinia } = await import("../apps/web/node_modules/pinia/dist/pinia.js");
  let loads = 0;
  productionApi.listTextModels = async () => { document.querySelector("#notice")!.textContent = `模型列表已刷新 ${++loads} 次 · 无生成请求`; return []; };
  createApp({ render: () => h(adaptationRun, { directory: "QA", projectId: "qa-project", inputs: [] }) }).use(createPinia()).mount("#app");
} else if (new URLSearchParams(location.search).get("stage") === "models") {
  document.querySelector("#notice")!.textContent = "统一模型设置验证 · 真实供应商读取 · 未配置密钥，禁止生成";
  const { default: mediaModel } = await import("../apps/web/src/components/settings/panels/mediaModel/index.vue");
  const { createPinia } = await import("../apps/web/node_modules/pinia/dist/pinia.js");
  createApp({ render: () => h(mediaModel) }).use(createPinia()).mount("#app");
} else if (["segments", "portraits"].includes(new URLSearchParams(location.search).get("stage") ?? "")) {
  document.querySelector("#notice")!.textContent = new URLSearchParams(location.search).get("stage") === "portraits"
    ? "人物原图验证 · QA 时钟为生成后 24 天 · 模型请求已拦截，图片为测试像素" : "片段规划验证 · 临时工作区真实读写 · 无模型调用";
  const fixture = await (await fetch("/qa/referenceFixture")).json();
  const { default: segmentPlanPanel } = await import("../apps/web/src/pages/production/segmentPlanPanel.vue");
  const { createPinia } = await import("../apps/web/node_modules/pinia/dist/pinia.js");
  createApp({ render: () => h(segmentPlanPanel, { directory: fixture.directory, projectId: fixture.projectId, episodes: fixture.episodes,
    onOpenCosts: () => { document.querySelector("#notice")!.textContent = "已触发价格与预算导航 · QA"; },
    onChanged: () => { document.querySelector("#notice")!.textContent = "已触发任务刷新 · QA 模型请求已拦截模拟"; } }) }).use(createPinia()).mount("#app");
} else if (new URLSearchParams(location.search).get("stage") === "preparation") {
  document.querySelector("#notice")!.textContent = "镜头资料验证 · 临时工作区真实读写 · 图片为测试像素";
  const fixture = await (await fetch("/qa/referenceFixture")).json();
  const { default: shotPreparationPanel } = await import("../apps/web/src/pages/production/shotPreparationPanel.vue");
  createApp({ render: () => h(shotPreparationPanel, { ...fixture,
    onOpenAssets: () => { document.querySelector("#notice")!.textContent = "已触发参考图库导航（QA）"; } }) }).mount("#app");
} else if (new URLSearchParams(location.search).get("stage") === "references") {
  document.querySelector("#notice")!.textContent = "参考图库验证 · 临时工作区真实读写 · 模型请求已拦截，图片为测试像素";
  const fixture = await (await fetch("/qa/referenceFixture")).json();
  const { default: assetReferencePanel } = await import("../apps/web/src/pages/production/assetReferencePanel.vue");
  const { createPinia } = await import("../apps/web/node_modules/pinia/dist/pinia.js");
  createApp({ render: () => h(assetReferencePanel, fixture) }).use(createPinia()).mount("#app");
} else if (new URLSearchParams(location.search).get("stage") === "review") {
  document.querySelector("#notice")!.textContent = "审核界面验证 · 页面内模拟，不写生产数据";
  const evidence = [{ sourceHash: "a".repeat(64), chapterSequence: 1, lineStart: 2, lineEnd: 2, quote: "林岚走进车站，拾起铜钥匙。" }];
  const fixture: EpisodeReview = { snapshotHash: "b".repeat(64), sourceText: "第一章 雨夜\n林岚走进车站，拾起铜钥匙。", issues: [], hasSuccessor: false, history: [],
    snapshot: { sourceHash: "a".repeat(64), episode: { id: "qa-episode", projectId: "qa-project", episodeNumber: 1,
      title: "雨夜的钥匙", logline: "一把钥匙开启了追寻真相的旅程。", reviewState: "draft", createdAt: 1, updatedAt: 1,
      outline: ["林岚进入车站", "发现并拾起铜钥匙"], script: [{ location: "车站", characters: ["林岚"], evidence,
        beats: [{ type: "action", text: "林岚蹲下，拾起地上的铜钥匙。" }] }], scriptReport: { passed: true, estimatedSeconds: 3, checks: [] } },
      assets: [{ id: "qa-character", kind: "character", name: "林岚", aliases: [], stableDescription: "黑色齐肩发，穿浅蓝色外套。", evidence, firstAppearance: "第一章", variantOf: null, locked: false }],
      scenes: [{ id: "qa-scene", name: "车站", location: "候车大厅", atmosphere: "安静", timeWeather: "雨夜", evidence, locked: false }],
      shots: [{ id: "qa-shot", episodeId: "qa-episode", episodeNumber: 1, sequence: 1, sceneId: "qa-scene", title: "拾起钥匙", scriptExcerpt: "林岚蹲下拾起钥匙", evidence,
        shotSize: "近景", cameraAngle: "平视", movement: "固定", durationMs: 5000, promptText: "", promptVersion: 1, reviewState: "draft" }],
      props: [], characters: [{ shotId: "qa-shot", characterId: "qa-character", costumeId: null }], dialogue: [] } };
  productionApi.getEpisodeReview = async () => structuredClone(fixture);
  productionApi.reviewEpisode = async (_directory, _projectId, _episodeId, _hash, decision, note) => {
    fixture.snapshot.episode.reviewState = decision;
    if (decision === "confirmed") { fixture.snapshot.assets.forEach(item => { item.locked = true; }); fixture.snapshot.scenes.forEach(item => { item.locked = true; }); }
    fixture.history.unshift({ id: String(Date.now()), decision, note, reviewedBy: "qa", createdAt: Date.now() });
    return { reviewId: "qa-review", alreadyReviewed: false };
  };
  const { default: episodeReviewPanel } = await import("../apps/web/src/pages/production/episodeReviewPanel.vue");
  createApp({ render: () => h(episodeReviewPanel, { directory: "QA", projectId: "qa-project", episodes: [fixture.snapshot.episode] }) }).mount("#app");
} else if (new URLSearchParams(location.search).get("stage") === "adaptation") {
  document.querySelector("#notice")!.textContent = "编剧界面验证 · 全部请求为页面内模拟";
  productionApi.listTextModels = async () => [{ providerId: "qa", providerLabel: "QA 模拟", modelId: "qa-model", label: "编剧模型", maxOutputTokens: 16384 }];
  productionApi.previewAdaptation = async () => ({ planHash: "a".repeat(64), estimatedCostMicros: 80000,
    destination: "QA 页面内模拟，不外发", sourceUrl: "https://example.test/qa", quantity: 80000,
    requestJson: JSON.stringify({ source: "这是界面验证用的模拟章节，不会发送给模型。" }),
    options: { episodeNumber: 1, firstChapter: 1, lastChapter: 2, targetSeconds: 60, genre: "悬疑", visualStyle: "动画" } });
  productionApi.runAdaptation = async (_input, approval) => {
    if (approval.approved !== true || approval.maxCalls !== 1) throw new Error("QA requires approval");
    return { taskId: "qa-task", status: "succeeded", episodeId: "qa-episode" };
  };
  const { default: adaptationRun } = await import("../apps/web/src/pages/production/adaptationRun.vue");
  createApp({ render: () => h(adaptationRun, { directory: "QA", projectId: "qa-project",
    inputs: [{ id: "b".repeat(64), episodeNumber: 1, sourceHash: "c".repeat(64), templateVersion: "qa", createdAt: Date.now() }],
    onChanged: () => { document.querySelector("#notice")!.textContent = "模拟执行结束 · 未外发、未写入生产数据"; },
    onOpenCosts: () => { document.querySelector("#notice")!.textContent = "已触发费用页面导航（QA）"; }
  }) }).mount("#app");
} else {
  createApp({ render: () => h(dashboard, { project: null, storyCount: 0, budget: null, savingStory: false,
    onOpenStage: (stage: string) => { document.querySelector("#notice")!.textContent = `已触发页面导航：${stage}（隔离预览）`; },
    onImportNovel: () => { document.querySelector("#notice")!.textContent = "已触发保存章节事件（隔离预览，不写入项目）"; }
  }) }).mount("#app");
}
