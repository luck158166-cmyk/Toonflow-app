import { createApp, h } from "../apps/web/node_modules/vue/dist/vue.esm-bundler.js";
import productionApi from "../apps/web/src/lib/productionApi";
import "../apps/web/node_modules/element-plus/dist/index.css";
import dashboard from "../apps/web/src/pages/production/dashboard.vue";
if (new URLSearchParams(location.search).get("stage") === "adaptation") {
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
