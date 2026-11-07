import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionCatalog } from "../packages/production/src/catalog";
import { ProductionStore } from "../packages/production/src/store";
import { prepareAdaptationInput } from "../packages/production/src/adaptationInput";
import { buildAdaptationTask, adoptAdaptationResponse } from "../packages/production/src/adaptationTask";
import { runTextTask } from "../packages/production/src/textWorker";
import { episodeDraftSchema } from "../apps/server/src/lib/episodeDraftSchema";

const sourceText = "第一章 雨夜\n" + "林岚走进车站，拾起铜钥匙。".repeat(9);
function setup(projectDb: Database, globalDb: Database) {
  const catalog = new ProductionCatalog(projectDb); const store = new ProductionStore(globalDb);
  const projectId = catalog.importStory({ title: "雨夜", sourceKind: "novel", sourceText });
  const prepared = prepareAdaptationInput(catalog, projectId, { episodeNumber: 1, firstChapter: 1,
    lastChapter: 1, targetSeconds: 5, genre: "悬疑", visualStyle: "动画" }, {});
  const evidence = [{ sourceHash: prepared.sourceHash, chapterSequence: 1, lineStart: 2, lineEnd: 2, quote: "林岚走进车站，拾起铜钥匙。" }];
  const draft = { episodeNumber: 1, title: "雨夜", logline: "拾起钥匙", outline: ["拾起钥匙"],
    script: [{ location: "车站", characters: ["林岚"], evidence, beats: [{ type: "action", text: "林岚拾起钥匙" }] }],
    characters: [{ name: "林岚", aliases: [], stableDescription: "黑发女子", firstAppearance: "第一章", evidence }],
    scenes: [{ name: "车站", location: "车站", atmosphere: "寂静", timeWeather: "夜", evidence }],
    shots: [{ sequence: 1, sceneName: "车站", title: "拾起钥匙", scriptExcerpt: "林岚拾起钥匙", evidence,
      durationMs: 5000, shotSize: "近景", movement: "固定", promptText: "", characterNames: ["林岚"], dialogue: [] }] };
  const task = store.createTask({ ...buildAdaptationTask(catalog, projectId, prepared.id, "mock", "mock"),
    billable: false, estimatedCostMicros: 0, currency: "CNY" }).task;
  const adopt = () => adoptAdaptationResponse(catalog, store, projectId, prepared.id, task.id, value => episodeDraftSchema.parse(value));
  return { catalog, store, projectId, prepared, draft, task, adopt };
}

it("runs prepared input through a text adapter, adopts once and resumes after both databases reopen", async () => {
  const folder = mkdtempSync(join(tmpdir(), "adaptationTask"));
  let projectDb = new Database(join(folder, "project.db")); let globalDb = new Database(join(folder, "global.db"));
  try {
    const state = setup(projectDb, globalDb); let calls = 0;
    const provider = { providerId: "mock", async generate() { calls++; return {
      responseText: JSON.stringify(state.draft), providerRequestId: "result1", usageJson: "{}" }; } };
    await runTextTask(state.store, state.task.id, provider);
    const first = state.adopt(); expect(first.alreadyAdopted).toBe(false);
    projectDb.close(); globalDb.close();
    projectDb = new Database(join(folder, "project.db")); globalDb = new Database(join(folder, "global.db"));
    const catalog = new ProductionCatalog(projectDb); const store = new ProductionStore(globalDb);
    store.recoverInterrupted();
    expect((await runTextTask(store, state.task.id, provider)).status).toBe("already_succeeded");
    expect(adoptAdaptationResponse(catalog, store, state.projectId, state.prepared.id, state.task.id,
      value => episodeDraftSchema.parse(value))).toEqual({ episodeId: first.episodeId, alreadyAdopted: true });
    expect(calls).toBe(1);
    expect(catalog.getProjectProduction(state.projectId).episodes).toHaveLength(1);
    expect(catalog.getProjectProduction(state.projectId).adaptationAdoptions).toHaveLength(1);
  } finally { projectDb.close(); globalDb.close(); rmSync(folder, { recursive: true, force: true }); }
});

it("keeps a successful model response when adoption fails or its source changes", async () => {
  const projectDb = new Database(":memory:"); const globalDb = new Database(":memory:");
  try {
    const state = setup(projectDb, globalDb);
    await runTextTask(state.store, state.task.id, { providerId: "mock", async generate() {
      return { responseText: JSON.stringify(state.draft), providerRequestId: "result1", usageJson: "{}" };
    } });
    projectDb.exec("CREATE TRIGGER rejectReceipt BEFORE INSERT ON adaptation_adoption BEGIN SELECT RAISE(ABORT, 'receipt fault'); END");
    expect(state.adopt).toThrow("receipt fault");
    expect(state.catalog.getProjectProduction(state.projectId).episodes).toHaveLength(0);
    expect(state.catalog.getProjectProduction(state.projectId).assets).toHaveLength(0);
    expect(state.store.getTask(state.task.id).state).toBe("succeeded");
    projectDb.query("UPDATE production_project SET source_text = ? WHERE id = ?").run(sourceText + "新情节", state.projectId);
    expect(state.adopt).toThrow("已变更");
    expect(state.store.getTextOutput(state.task.id)?.responseText).toBe(JSON.stringify(state.draft));
  } finally { projectDb.close(); globalDb.close(); }
});

it("rejects wrong episode numbers, duration and malformed content without persisting an episode", async () => {
  for (const variant of ["episode", "duration", "json"]) {
    const projectDb = new Database(":memory:"); const globalDb = new Database(":memory:");
    try {
      const state = setup(projectDb, globalDb);
      if (variant === "episode") state.draft.episodeNumber = 2;
      if (variant === "duration") state.draft.shots[0].durationMs = 60000;
      await runTextTask(state.store, state.task.id, { providerId: "mock", async generate() {
        return { responseText: variant === "json" ? "不是 JSON" : JSON.stringify(state.draft), providerRequestId: "result1", usageJson: "{}" };
      } });
      expect(state.adopt).toThrow();
      expect(state.catalog.getProjectProduction(state.projectId).episodes).toHaveLength(0);
      expect(state.store.getTask(state.task.id).state).toBe("succeeded");
    } finally { projectDb.close(); globalDb.close(); }
  }
});
