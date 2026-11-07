import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ProductionCatalog } from "../packages/production/src/catalog";
import { ProductionStore } from "../packages/production/src/store";
import { prepareAdaptationInput } from "../packages/production/src/adaptationInput";
import { executeAdaptation, previewAdaptationExecution } from "../packages/production/src/adaptationExecution";
import { episodeDraftSchema } from "../apps/server/src/lib/episodeDraftSchema";
import { runTextTask } from "../packages/production/src/textWorker";

function setup() {
  const projectDb = new Database(":memory:"); const globalDb = new Database(":memory:");
  const catalog = new ProductionCatalog(projectDb); const store = new ProductionStore(globalDb);
  const sourceText = "第一章 雨夜\n" + "林岚走进车站，拾起铜钥匙。".repeat(9);
  const projectId = catalog.importStory({ title: "雨夜", sourceKind: "novel", sourceText });
  const prepared = prepareAdaptationInput(catalog, projectId, { episodeNumber: 1, firstChapter: 1, lastChapter: 1,
    targetSeconds: 5, genre: "悬疑", visualStyle: "动画" }, {});
  const evidence = [{ sourceHash: prepared.sourceHash, chapterSequence: 1, lineStart: 2, lineEnd: 2, quote: "林岚走进车站，拾起铜钥匙。" }];
  const draft = { episodeNumber: 1, title: "雨夜", logline: "拾起钥匙", outline: ["拾起钥匙"],
    script: [{ location: "车站", characters: ["林岚"], evidence, beats: [{ type: "action", text: "林岚拾起钥匙" }] }],
    characters: [{ name: "林岚", aliases: [], stableDescription: "黑发女子", firstAppearance: "第一章", evidence }],
    scenes: [{ name: "车站", location: "车站", atmosphere: "寂静", timeWeather: "夜", evidence }],
    shots: [{ sequence: 1, sceneName: "车站", title: "拾起钥匙", scriptExcerpt: "林岚拾起钥匙", evidence,
      durationMs: 5000, shotSize: "近景", movement: "固定", promptText: "", characterNames: ["林岚"], dialogue: [] }] };
  const input = { projectId, inputId: prepared.id, maxOutputTokens: 8192 };
  const model = { providerId: "mock", modelId: "mock-text", destination: "https://example.test/model", contextWindow: 65536, maxOutputTokensLimit: 16384 };
  const price = { provider: model.providerId, modelId: model.modelId, unit: "textTokenCeiling", unitSize: 1,
    unitPriceMicros: 1, currency: "CNY", sourceUrl: "https://example.test/price", effectiveAt: 1, recordedBy: "qa" };
  store.setBudget(1_000_000, "CNY"); store.globalBudgets.recordPriceRule(price);
  const plan = previewAdaptationExecution(catalog, store, input, model);
  const approval = { approved: true as const, maxCalls: 1 as const, planHash: plan.planHash, maxCostMicros: plan.estimatedCostMicros };
  let calls = 0;
  const provider = { providerId: model.providerId, async generate() { calls++; return {
    responseText: JSON.stringify(draft), providerRequestId: "mock-receipt", usageJson: "{}" }; } };
  const run = () => executeAdaptation(catalog, store, input, model, approval, provider, value => episodeDraftSchema.parse(value));
  return { projectDb, globalDb, catalog, store, input, model, approval, plan, price, provider, run,
    calls: () => calls, close() { projectDb.close(); globalDb.close(); } };
}

it("previews without spending, then authorizes, generates, validates and adopts once", async () => {
  const s = setup();
  try {
    expect(s.store.listProjectTasks(s.input.projectId)).toHaveLength(0); expect(s.calls()).toBe(0);
    const result = await s.run();
    expect(result.status).toBe("succeeded"); expect(result.episodeId).toBeTruthy();
    expect(s.catalog.getProjectProduction(s.input.projectId).shots).toHaveLength(1);
    expect(s.catalog.getProjectProduction(s.input.projectId).assets).toHaveLength(1);
    expect(s.store.getTextAuthorization(result.taskId)).toMatchObject({ maxCalls: 1, approvedPlanHash: s.plan.planHash });
    expect(s.store.getTaskPriceSnapshot(result.taskId)?.estimatedCostMicros).toBe(s.plan.estimatedCostMicros);
    expect(s.store.getBudgetUsage().reservedMicros).toBe(s.plan.estimatedCostMicros);
    const replay = await executeAdaptation(new ProductionCatalog(s.projectDb), new ProductionStore(s.globalDb),
      s.input, s.model, s.approval, s.provider, value => episodeDraftSchema.parse(value));
    expect(replay).toMatchObject({ status: "already_succeeded", taskId: result.taskId, episodeId: result.episodeId, alreadyAdopted: true });
    expect(s.calls()).toBe(1); expect(s.catalog.getProjectProduction(s.input.projectId).episodes).toHaveLength(1);
  } finally { s.close(); }
});

it("rejects unapproved, insufficient-cap, stale-price and changed-destination requests before any model call", async () => {
  for (const scenario of ["approval", "cap", "price", "destination", "context"]) {
    const s = setup();
    try {
      if (scenario === "approval") (s.approval as { approved: boolean }).approved = false;
      if (scenario === "cap") s.approval.maxCostMicros--;
      if (scenario === "price") s.store.globalBudgets.recordPriceRule({ ...s.price, unitPriceMicros: 2, effectiveAt: 2 });
      if (scenario === "destination") s.model.destination = "https://different.example.test/model";
      if (scenario === "context") s.input.maxOutputTokens = 16385;
      await expect(s.run()).rejects.toThrow();
      expect(s.calls()).toBe(0); expect(s.store.listProjectTasks(s.input.projectId)).toHaveLength(0);
      expect(s.store.getBudgetUsage().reservedMicros).toBe(0);
    } finally { s.close(); }
  }
});

it("blocks at the global budget and can resume the same authorized queued task without duplication", async () => {
  const s = setup();
  try {
    s.store.setBudget(0, "CNY");
    const result = await s.run(); expect(result.status).toBe("budget_exhausted"); expect(s.calls()).toBe(0);
    s.store.setBudget(1_000_000, "CNY");
    expect((await s.run()).taskId).toBe(result.taskId); expect(s.calls()).toBe(1);
  } finally { s.close(); }
});

it("retains responses when JSON is invalid or source changes during generation, without retrying", async () => {
  for (const scenario of ["json", "source"]) {
    const s = setup();
    try {
      const generate = s.provider.generate;
      s.provider.generate = async () => {
        const output = await generate();
        if (scenario === "json") output.responseText = "invalid JSON";
        else s.projectDb.query("UPDATE production_project SET source_text = source_text || ? WHERE id = ?").run("后续变化", s.input.projectId);
        return output;
      };
      const result = await s.run(); expect(result.status).toBe("succeeded"); expect(result.adoptionError).toBeTruthy();
      expect(s.store.getTextOutput(result.taskId)).not.toBeNull();
      expect(s.catalog.getProjectProduction(s.input.projectId).episodes).toHaveLength(0);
      await s.run(); expect(s.calls()).toBe(1);
    } finally { s.close(); }
  }
});

it("handles overlapping requests and uncertain failures without a second provider invocation", async () => {
  const s = setup();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const generate = s.provider.generate;
    s.provider.generate = async () => { await generate(); await gate; throw new Error("response lost"); };
    const pending = s.run();
    expect((await s.run()).status).toBe("already_dispatched");
    release(); const result = await pending; expect(result.status).toBe("reconcile_required");
    s.store.recoverInterrupted(); expect((await s.run()).status).toBe("reconcile_required");
    expect(s.calls()).toBe(1); expect(s.store.getBudgetUsage().reservedMicros).toBe(s.plan.estimatedCostMicros);
  } finally { s.close(); }
});

it("cannot bypass paid text approval by creating a generic task", async () => {
  const s = setup();
  try {
    const task = s.store.createTask({ idempotencyKey: "bypass", projectId: s.input.projectId, episodeId: "planned",
      stage: "text", provider: s.model.providerId, modelId: s.model.modelId, requestJson: "{}", billable: true,
      currency: "CNY", estimatedCostMicros: 1 }).task;
    await expect(runTextTask(s.store, task.id, s.provider)).rejects.toThrow("按次授权"); expect(s.calls()).toBe(0);
  } finally { s.close(); }
});
