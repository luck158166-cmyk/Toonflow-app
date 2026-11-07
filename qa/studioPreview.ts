import { createApp, h } from "../apps/web/node_modules/vue/dist/vue.esm-bundler.js";
import dashboard from "../apps/web/src/pages/production/dashboard.vue";
createApp({ render: () => h(dashboard, { project: null, storyCount: 0, budget: null, savingStory: false,
  onOpenStage: (stage: string) => { document.querySelector("#notice")!.textContent = `已触发页面导航：${stage}（隔离预览）`; },
  onImportNovel: () => { document.querySelector("#notice")!.textContent = "已触发保存章节事件（隔离预览，不写入项目）"; }
}) }).mount("#app");
