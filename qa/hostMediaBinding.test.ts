import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ProductionStore, serializeHostMediaRequest, type HostMediaBinding, type PricedTaskInput } from "../packages/production/src/store";

function setup(limit = 10000) {
  const db = new Database(":memory:"); const store = new ProductionStore(db); store.setBudget(limit, "CNY");
  const rule = store.globalBudgets.recordPriceRule({ provider: "volcengine", modelId: "qaVideo", unit: "qaOnly", unitSize: 1,
    unitPriceMicros: 100, currency: "CNY", sourceUrl: "https://example.test/qa", effectiveAt: 1, recordedBy: "qa" });
  const input: PricedTaskInput = { idempotencyKey: "qa", projectId: "project", episodeId: "episode", stage: "video", provider: "volcengine",
    modelId: "qaVideo", requestJson: serializeHostMediaRequest({ modelId: "qaVideo", providerId: "volcengine", prompt: "QA" }), unit: "qaOnly", quantity: 1 };
  const binding: Omit<HostMediaBinding, "taskId" | "requestHash" | "launchClaimed"> = {
    workspace: "C:\\qa", segmentKey: "plan1:segment1", mediaType: "video", authorization: { maxCalls: 1, maxCostMicros: 100, currency: "CNY",
      approvedRequestHash: createHash("sha256").update(input.requestJson).digest("hex"), approvedPlanHash: "a".repeat(64), priceRuleId: rule.id } };
  return { db, store, input, binding, create: () => store.createHostMediaTask(input, binding) };
}

it("atomically binds one native UUID to the price, reservation, segment and immutable approval", () => {
  const s = setup();
  try {
    const first = s.create(); expect(first.status).toBe("started");
    expect(s.create().task.id).toBe(first.task.id); expect(s.store.getBudgetUsage().reservedMicros).toBe(100);
    expect(s.store.listProjectTasks("project")[0]).toMatchObject({ hostTaskId: first.task.id, segmentKey: "plan1:segment1" });
    expect(s.store.claimHostMediaLaunch(first.task.id, s.binding.workspace, "video", s.input.requestJson)).toBe(true);
    expect(s.store.claimHostMediaLaunch(first.task.id, s.binding.workspace, "video", s.input.requestJson)).toBe(false);
    for (const change of [{ workspace: "C:\\elsewhere" }, { segmentKey: "other" },
      { authorization: { ...s.binding.authorization, maxCostMicros: 200 } }]) {
      expect(() => s.store.createHostMediaTask(s.input, { ...s.binding, ...change })).toThrow();
    }
    expect(() => s.store.assertHostMediaSubmission(first.task.id, s.binding.workspace, "video", "{}")).toThrow();
    s.store.recoverInterrupted(); expect(s.store.getHostMediaBinding(first.task.id)?.launchClaimed).toBe(true);
    expect(() => s.store.assertHostMediaSubmission(first.task.id, s.binding.workspace, "video", s.input.requestJson)).toThrow();
  } finally { s.db.close(); }
});

it("rolls back the task and both reservations at the warning threshold or above the approved cap", () => {
  for (const reason of ["warning", "cap", "price", "bindingWrite"] as const) {
    const s = setup(reason === "warning" ? 111 : 10000);
    try {
      if (reason === "cap") s.binding.authorization.maxCostMicros = 99;
      if (reason === "price") s.binding.authorization.priceRuleId = "not-current";
      if (reason === "bindingWrite") s.db.exec("CREATE TRIGGER rejectBinding BEFORE INSERT ON host_media_binding BEGIN SELECT RAISE(ABORT, 'QA binding failure'); END");
      expect(s.create).toThrow(); expect(s.store.listProjectTasks("project")).toHaveLength(0);
      expect(s.store.getBudgetUsage().reservedMicros).toBe(0);
      expect((s.db.query("SELECT count(*) AS count FROM task_reservation").get() as { count: number }).count).toBe(0);
    } finally { s.db.close(); }
  }
});

it("cannot launch a budget-exhausted task or a generic task without the binding", () => {
  const s = setup(99);
  try {
    const result = s.create(); expect(result.status).toBe("budget_exhausted");
    expect(() => s.store.claimHostMediaLaunch(result.task.id, s.binding.workspace, "video", s.input.requestJson)).toThrow();
    expect(s.store.getBudgetUsage().reservedMicros).toBe(0);
    s.store.setBudget(10000, "CNY"); const started = s.create(); expect(started.task.id).toBe(result.task.id);
    expect(started.status).toBe("started");
    const ordinary = s.store.createPricedTaskAndBeginSubmission({ ...s.input, idempotencyKey: "ordinary" });
    expect(() => s.store.claimHostMediaLaunch(ordinary.task.id, s.binding.workspace, "video", s.input.requestJson)).toThrow();
  } finally { s.db.close(); }
});
