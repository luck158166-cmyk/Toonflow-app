import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { GlobalBudgetCoordinator } from "../packages/production/src/globalBudgetCoordinator";
import { ProductionStore, type PricedTaskInput } from "../packages/production/src/store";
import { dispatchPricedNewTask } from "../packages/production/src/dispatcher";

describe("confirmed production price rules", () => {
  const pricedInput = (key: string): PricedTaskInput => ({ idempotencyKey: key,
    projectId: "project", episodeId: "episode", shotId: "shot", stage: "video", provider: "mock-ark",
    modelId: "video-model", requestJson: "{\"prompt\":\"safe\"}", unit: "second", quantity: 3 });

  it("freezes the quoted rate with the task and submits a duplicate only once", async () => {
    const db = new Database(":memory:");
    try {
      const store = new ProductionStore(db);
      store.setBudget(1_000_000, "CNY");
      const input = pricedInput("priced-duplicate");
      expect(() => store.createPricedTaskAndBeginSubmission(input)).toThrow("No confirmed price rule");
      expect(db.query("SELECT COUNT(*) AS count FROM generation_task").get()).toEqual({ count: 0 });
      const firstRule = store.globalBudgets.recordPriceRule({ provider: "mock-ark", modelId: "video-model",
        unit: "second", unitSize: 1, unitPriceMicros: 100_000, currency: "CNY",
        sourceUrl: "https://example.test/price-1", effectiveAt: 1, recordedBy: "local-user" });
      let submissions = 0;
      const provider = { providerId: "mock-ark", submit: async () => ({ providerTaskId: `remote-${++submissions}` }) };
      const first = await dispatchPricedNewTask(store, input, provider);
      expect(first.status).toBe("accepted");
      expect(store.getTaskPriceSnapshot(first.task.id)).toMatchObject({ priceRuleId: firstRule.id,
        quantity: 3, estimatedCostMicros: 300_000, unitSize: 1, sourceUrl: "https://example.test/price-1" });
      store.globalBudgets.recordPriceRule({ provider: "mock-ark", modelId: "video-model",
        unit: "second", unitSize: 1, unitPriceMicros: 200_000, currency: "CNY",
        sourceUrl: "https://example.test/price-2", effectiveAt: 2, recordedBy: "local-user" });
      const duplicate = await dispatchPricedNewTask(store, input, provider);
      expect(duplicate.status).toBe("already_dispatched");
      expect(duplicate.task.id).toBe(first.task.id);
      expect(submissions).toBe(1);
      expect(store.getBudgetUsage("CNY").reservedMicros).toBe(300_000);
      expect(() => store.createPricedTaskAndBeginSubmission({ ...input, quantity: 4 })).toThrow("different price request");
      const overBudget = await dispatchPricedNewTask(store,
        { ...input, idempotencyKey: "priced-over-budget", quantity: 5 }, provider);
      expect(overBudget.status).toBe("budget_exhausted");
      expect(submissions).toBe(1);
      expect(store.getBudgetUsage("CNY").reservedMicros).toBe(300_000);
      expect(() => store.settleReservation(first.task.id, "wrong-price", 250_000, "CNY",
        { pricingRef: "another-rule" })).toThrow("differs");
      expect(db.query("SELECT COUNT(*) AS count FROM global_cost_ledger").get()).toEqual({ count: 0 });
      expect(store.settleReservation(first.task.id, "provider-bill", 250_000, "CNY")).toBe(true);
      expect(db.query("SELECT pricing_ref AS pricingRef, status FROM cost_ledger WHERE source_ref = ?")
        .get("provider-bill")).toEqual({ pricingRef: firstRule.id, status: "manual" });
      expect(db.query("SELECT pricing_ref AS pricingRef, status FROM global_cost_ledger WHERE source_ref = ?")
        .get("provider-bill")).toEqual({ pricingRef: firstRule.id, status: "manual" });
      expect(store.getBudgetUsage("CNY")).toMatchObject({ chargedMicros: 250_000, reservedMicros: 0 });
    } finally { db.close(); }
  });

  it("rolls back task creation if the immutable quote snapshot cannot be written", () => {
    const db = new Database(":memory:");
    try {
      const store = new ProductionStore(db);
      store.setBudget(1_000_000, "CNY");
      store.globalBudgets.recordPriceRule({ provider: "mock-ark", modelId: "video-model",
        unit: "second", unitSize: 1, unitPriceMicros: 100_000, currency: "CNY",
        sourceUrl: "https://example.test/price", effectiveAt: 1, recordedBy: "local-user" });
      db.exec("CREATE TRIGGER reject_quote BEFORE INSERT ON task_price_snapshot BEGIN SELECT RAISE(ABORT, 'quote write failed'); END");
      expect(() => store.createPricedTaskAndBeginSubmission(pricedInput("priced-rollback"))).toThrow("quote write failed");
      expect(db.query("SELECT COUNT(*) AS count FROM generation_task").get()).toEqual({ count: 0 });
      expect(store.getBudgetUsage("CNY").reservedMicros).toBe(0);
    } finally { db.close(); }
  });

  it("retains the quoted rate and dispatch intent after reopening the database", () => {
    const root = mkdtempSync(join(tmpdir(), "toonflow-priced-task-"));
    try {
      const path = join(root, "global.db");
      let db = new Database(path);
      let taskId: string;
      try {
        const store = new ProductionStore(db);
        store.setBudget(1_000_000, "CNY");
        store.globalBudgets.recordPriceRule({ provider: "mock-ark", modelId: "video-model",
          unit: "second", unitSize: 1, unitPriceMicros: 75_000, currency: "CNY",
          sourceUrl: "https://example.test/price", effectiveAt: 1, recordedBy: "local-user" });
        const result = store.createPricedTaskAndBeginSubmission(pricedInput("priced-restart"));
        expect(result.status).toBe("started");
        taskId = result.task.id;
      } finally { db.close(); }
      db = new Database(path);
      try {
        const store = new ProductionStore(db);
        expect(store.getTaskPriceSnapshot(taskId!)).toMatchObject({ quantity: 3, estimatedCostMicros: 225_000 });
        expect(store.createPricedTaskAndBeginSubmission(pricedInput("priced-restart")).status).toBe("already_dispatched");
        expect(store.getTask(taskId!).attempt).toBe(1);
        expect(store.getBudgetUsage("CNY").reservedMicros).toBe(225_000);
      } finally { db.close(); }
    } finally {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe QA cleanup path.");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quotes a fractional billing unit and keeps historical rates", () => {
    const db = new Database(":memory:");
    try {
      const budgets = new GlobalBudgetCoordinator(db);
      expect(() => budgets.quotePrice("ark", "text-model", "token", 1)).toThrow("No confirmed price rule");
      const first = budgets.recordPriceRule({ provider: "ark", modelId: "text-model", unit: "token",
        unitSize: 1_000_000, unitPriceMicros: 2_500_000, currency: "CNY",
        sourceUrl: "https://example.test/pricing", effectiveAt: 1_000, recordedBy: "local-user" });
      const second = budgets.recordPriceRule({ provider: "ark", modelId: "text-model", unit: "token",
        unitSize: 1_000_000, unitPriceMicros: 3_000_000, currency: "CNY",
        sourceUrl: "https://example.test/pricing-new", effectiveAt: 2_000, recordedBy: "local-user" });
      expect(budgets.quotePrice("ark", "text-model", "token", 12_345, 1_500)).toMatchObject({
        rule: { id: first.id }, amountMicros: 30_863, currency: "CNY",
      });
      expect(budgets.quotePrice("ark", "text-model", "token", 12_345, 2_500)).toMatchObject({
        rule: { id: second.id }, amountMicros: 37_035, currency: "CNY",
      });
      expect(db.query("SELECT COUNT(*) AS count FROM price_rule").get()).toEqual({ count: 2 });
    } finally { db.close(); }
  });

  it("rejects invalid sources and unsafe price multiplication", () => {
    const db = new Database(":memory:");
    try {
      const budgets = new GlobalBudgetCoordinator(db);
      const input = { provider: "ark", modelId: "video-model", unit: "second", unitSize: 1,
        unitPriceMicros: Number.MAX_SAFE_INTEGER, currency: "CNY", sourceUrl: "https://example.test/price",
        effectiveAt: 1, recordedBy: "local-user" };
      expect(() => budgets.recordPriceRule({ ...input, sourceUrl: "http://example.test/price" })).toThrow("HTTPS");
      budgets.recordPriceRule(input);
      expect(() => budgets.quotePrice("ark", "video-model", "second", 2)).toThrow("safe integer");
      expect(() => budgets.quotePrice("ark", "another-model", "second", 1)).toThrow("No confirmed price rule");
    } finally { db.close(); }
  });
});
