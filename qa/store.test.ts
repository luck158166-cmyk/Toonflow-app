import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { episodeBudgetKey, ProductionStore, type TaskInput } from "../packages/production/src/store";
import { dispatchNewTask, dispatchTask, type ProviderSubmissionPort } from "../packages/production/src/dispatcher";
import { createTaskAfterPromptCheck } from "../packages/production/src/promptPolicy";
import { processPendingMediaDownloads, type MediaDownloadPort } from "../packages/production/src/mediaDownloadWorker";
import { runSynthesisTask, type SynthesisPort } from "../packages/production/src/synthesisWorker";
import type { EpisodeRenderSpec } from "../packages/production/src/store";
import { reconcileProviderTask, type ProviderPollingPort } from "../packages/production/src/providerReconciler";

const paidInput = (idempotencyKey: string, estimatedCostMicros: number): TaskInput => ({
  idempotencyKey,
  projectId: "project-1",
  episodeId: "episode-1",
  shotId: "shot-1",
  stage: "video",
  provider: "mock-ark",
  requestJson: JSON.stringify({ prompt: "storm lighthouse" }),
  estimatedCostMicros,
  currency: "CNY",
  billable: true,
});

function fixture() {
  const db = new Database(":memory:");
  const store = new ProductionStore(db);
  store.setBudget(1_000_000, "CNY");
  return { db, store };
}

describe("production task safety", () => {
  it("separates episode charges from active reservations and other episodes", () => {
    const { db, store } = fixture();
    try {
      const settled = store.createTask(paidInput("episode-cost-settled", 200)).task;
      store.beginSubmission(settled.id);
      store.settleReservation(settled.id, "provider-cost-1", 140, "CNY");
      const pending = store.createTask(paidInput("episode-cost-pending", 300)).task;
      store.beginSubmission(pending.id);
      const other = store.createTask({ ...paidInput("episode-cost-other", 500), episodeId: "episode-2" }).task;
      store.beginSubmission(other.id);
      store.settleReservation(other.id, "provider-cost-2", 400, "CNY");
      const breakdown = store.getEpisodeCostBreakdown("project-1", "episode-1");
      expect(breakdown.reduce((sum, item) => sum + item.chargedMicros, 0)).toBe(140);
      expect(breakdown.reduce((sum, item) => sum + item.reservedMicros, 0)).toBe(300);
      expect(store.listEpisodeCharges("project-1", "episode-1")).toMatchObject([
        { taskId: settled.id, sourceRef: "provider-cost-1", amountMicros: 140, currency: "CNY" },
      ]);
      expect(store.listEpisodeCharges("project-1", "episode-2")[0]?.taskId).toBe(other.id);
      expect(store.getEpisodeCostBreakdown("project-2", "episode-1")).toEqual([]);
      expect(pending.id).not.toBe(settled.id);
    } finally { db.close(); }
  });

  it("never resets a paid generation task through the local synthesis retry path", () => {
    const { db, store } = fixture();
    try {
      const paid = store.createTask(paidInput("paid-retry-denied", 100)).task;
      store.beginSubmission(paid.id);
      store.markReconciliationRequired(paid.id);
      expect(() => store.retryLocalSynthesis(paid.id)).toThrow("non-billable local synthesis");
      expect(store.getTask(paid.id)).toMatchObject({ state: "reconcile_required", attempt: 1, requestStarted: true });
      expect(store.getBudgetUsage("CNY").reservedMicros).toBe(100);
    } finally { db.close(); }
  });

  it("rejects download destinations owned by successful or pending outputs on Windows", () => {
    const { db, store } = fixture();
    try {
      const original = store.createTask(paidInput("path-original", 100)).task;
      store.beginSubmission(original.id);
      store.completeTask(original.id, { slot: "clip", path: "assets/Clip.mp4", sha256: "a".repeat(64) });
      const next = store.createTask(paidInput("path-next", 100)).task;
      const expires = Date.now() + 86_400_000;
      expect(() => store.enqueueMediaDownload(next.id, "clip", "https://media.example.test/new.mp4",
        "ASSETS\\clip.mp4", expires)).toThrow("already owned");
      store.enqueueMediaDownload(next.id, "clip", "https://media.example.test/new.mp4", "assets/new.mp4", expires);
      const third = store.createTask(paidInput("path-third", 100)).task;
      expect(() => store.enqueueMediaDownload(third.id, "clip", "https://media.example.test/third.mp4",
        "assets//NEW.mp4", expires)).toThrow("already owned");
      store.beginSubmission(third.id);
      expect(() => store.completeTask(third.id, { slot: "clip", path: "assets/new.mp4", sha256: "b".repeat(64) }))
        .toThrow("already owned");
      expect(store.claimDueMediaDownloads().length).toBe(1);
      expect(store.getTask(original.id).state).toBe("succeeded");
    } finally { db.close(); }
  });

  it("never polls a successful task again even when the provider is offline", async () => {
    const { db, store } = fixture();
    try {
      const task = store.createTask(paidInput("finished-offline", 100)).task;
      store.beginSubmission(task.id);
      store.registerProviderTask(task.id, "provider-finished");
      store.completeTask(task.id, { slot: "primary", path: "assets/finished.mp4", sha256: "a".repeat(64) });
      let calls = 0;
      const outcome = await reconcileProviderTask(store, task.id, {
        providerId: task.provider, async poll() { calls++; throw new Error("offline"); },
      });
      expect(outcome.status).toBe("already_succeeded");
      expect(calls).toBe(0);
      expect(store.getBudgetUsage("CNY").reservedMicros).toBe(100);
      store.settleReservation(task.id, "finished-bill", 80, "CNY");
      expect(store.getBudgetUsage("CNY")).toMatchObject({ reservedMicros: 0, chargedMicros: 80 });
    } finally { db.close(); }
  });

  it("deduplicates the same request and only starts dispatch once", () => {
    const { db, store } = fixture();
    const first = store.createTask(paidInput("episode-1:shot-1:video:v1", 100_000));
    const repeated = store.createTask(paidInput("episode-1:shot-1:video:v1", 100_000));
    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.task.id).toBe(first.task.id);
    expect(store.beginSubmission(first.task.id).status).toBe("started");
    expect(store.beginSubmission(first.task.id).status).toBe("already_dispatched");
    expect(store.getTask(first.task.id).attempt).toBe(1);
    db.close();
  });

  it("creates and dispatches a new paid task once with its reservation in the same transaction", async () => {
    const { db, store } = fixture();
    try {
      let calls = 0;
      const provider: ProviderSubmissionPort = {
        providerId: "mock-ark",
        async submit() { calls++; return { providerTaskId: "new-paid-provider-task" }; },
      };
      const input = paidInput("new-paid-once", 100_000);
      const first = await dispatchNewTask(store, input, provider);
      const duplicate = await dispatchNewTask(store, input, provider);
      expect(first.status).toBe("accepted");
      expect(duplicate.status).toBe("already_dispatched");
      expect(calls).toBe(1);
      expect(db.query("SELECT COUNT(*) AS count FROM generation_task").get()).toEqual({ count: 1 });
      expect(db.query("SELECT COUNT(*) AS count FROM global_task_reservation WHERE state = 'active'").get())
        .toEqual({ count: 1 });
      expect(store.getBudgetUsage("CNY").reservedMicros).toBe(100_000);
    } finally { db.close(); }
  });

  it("blocks a prompt locally before task creation, reservation, or provider submission", () => {
    const { db, store } = fixture();
    let providerCalls = 0;
    const result = createTaskAfterPromptCheck(store, paidInput("blocked-prompt", 100_000),
      "include forbidden marker", [{ id: "blocked-marker", message: "Prompt needs revision.",
        matches: (prompt) => prompt.includes("forbidden marker") }]);
    if (result.created) providerCalls += 1;
    expect(result).toMatchObject({ created: false, policy: { allowed: false } });
    expect(db.query("SELECT COUNT(*) AS count FROM generation_task").get()).toEqual({ count: 0 });
    expect(store.getBudgetUsage("CNY").reservedMicros).toBe(0);
    expect(providerCalls).toBe(0);
    db.close();
  });

  it("never regenerates a successful artifact and rejects replacement", () => {
    const { db, store } = fixture();
    const task = store.createTask(paidInput("success-key", 100_000)).task;
    store.beginSubmission(task.id);
    store.registerProviderTask(task.id, "provider-task-1");
    const hash = "a".repeat(64);
    expect(store.completeTask(task.id, { slot: "clip", path: "assets/clip.mp4", sha256: hash }).created).toBe(true);
    expect(store.beginSubmission(task.id).status).toBe("already_succeeded");
    expect(store.completeTask(task.id, { slot: "clip", path: "assets/clip.mp4", sha256: hash }).created).toBe(false);
    expect(() => store.completeTask(task.id, { slot: "clip", path: "assets/replacement.mp4", sha256: "b".repeat(64) })).toThrow("immutable");
    expect(store.getTask(task.id).attempt).toBe(1);
    db.close();
  });

  it("warns at 90 percent and blocks a request that would exceed the hard budget", () => {
    const { db, store } = fixture();
    const warning = store.createTask(paidInput("90-percent", 900_000)).task;
    expect(store.beginSubmission(warning.id).status).toBe("warning_90");
    const blocked = store.createTask(paidInput("over-budget", 100_001)).task;
    const result = store.beginSubmission(blocked.id);
    expect(result.status).toBe("budget_exhausted");
    expect(store.getTask(blocked.id).requestStarted).toBe(false);
    db.close();
  });

  it("enforces one global budget across separate projects in the authoritative task database", () => {
    const globalDb = new Database(":memory:");
    const firstProject = new ProductionStore(globalDb);
    const secondProject = new ProductionStore(globalDb);
    firstProject.setBudget(100_000, "CNY");
    const first = firstProject.createTask(paidInput("project-a-global-cap", 80_000)).task;
    expect(firstProject.beginSubmission(first.id).status).toBe("started");
    firstProject.registerProviderTask(first.id, "project-a-video");
    expect(firstProject.settleReservation(first.id, "project-a-invoice", 80_000, "CNY")).toBe(true);

    const second = secondProject.createTask({ ...paidInput("project-b-global-cap", 20_001), projectId: "project-2" }).task;
    expect(secondProject.beginSubmission(second.id).status).toBe("budget_exhausted");
    expect(secondProject.getBudgetUsage("CNY").usedMicros).toBe(80_000);
    expect(secondProject.getTask(second.id).requestStarted).toBe(false);
    globalDb.close();
  });

  it("rolls back a global reservation when writing dispatch intent fails", () => {
    const { db, store } = fixture();
    try {
      const task = store.createTask(paidInput("atomic-dispatch", 50_000)).task;
      db.exec(`CREATE TRIGGER reject_local_reservation BEFORE INSERT ON task_reservation
        BEGIN SELECT RAISE(ABORT, 'injected local write failure'); END`);
      expect(() => store.beginSubmission(task.id)).toThrow("injected local write failure");
      expect(store.getTask(task.id)).toMatchObject({ state: "queued", attempt: 0, requestStarted: false });
      expect(db.query("SELECT COUNT(*) AS count FROM global_task_reservation").get()).toEqual({ count: 0 });
      expect(store.getBudgetUsage("CNY").reservedMicros).toBe(0);
    } finally { db.close(); }
  });

  it("rolls back new task creation and global reservation together after a local write fault", () => {
    const { db, store } = fixture();
    try {
      db.exec(`CREATE TRIGGER reject_new_reservation BEFORE INSERT ON task_reservation
        BEGIN SELECT RAISE(ABORT, 'injected new task write failure'); END`);
      expect(() => store.createTaskAndBeginSubmission(paidInput("atomic-new-task", 50_000)))
        .toThrow("injected new task write failure");
      expect(db.query("SELECT COUNT(*) AS count FROM generation_task").get()).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM global_task_reservation").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it("applies warning and hard budget limits before a new paid request can submit", () => {
    const { db, store } = fixture();
    try {
      store.setBudget(100_000, "CNY");
      const warning = store.createTaskAndBeginSubmission(paidInput("new-task-90-percent", 90_000));
      expect(warning.status).toBe("warning_90");
      const blocked = store.createTaskAndBeginSubmission(paidInput("new-task-over-budget", 10_001));
      expect(blocked.status).toBe("budget_exhausted");
      expect(blocked.task).toMatchObject({ state: "queued", requestStarted: false, attempt: 0 });
      expect(store.getBudgetUsage("CNY").reservedMicros).toBe(90_000);
    } finally { db.close(); }
  });

  it("rolls back global settlement when the project cost entry fails", () => {
    const { db, store } = fixture();
    try {
      const task = store.createTask(paidInput("atomic-settlement", 50_000)).task;
      store.beginSubmission(task.id);
      db.exec(`CREATE TRIGGER reject_cost_entry BEFORE INSERT ON cost_ledger
        BEGIN SELECT RAISE(ABORT, 'injected cost write failure'); END`);
      expect(() => store.settleReservation(task.id, "atomic-invoice", 40_000, "CNY"))
        .toThrow("injected cost write failure");
      expect(store.getBudgetUsage("CNY")).toMatchObject({ chargedMicros: 0, reservedMicros: 50_000 });
      expect(db.query("SELECT state FROM global_task_reservation WHERE task_id = ?").get(task.id))
        .toEqual({ state: "active" });
    } finally { db.close(); }
  });

  it("enforces configured project, episode, daily, and model limits independently", () => {
    const { db, store } = fixture();
    store.setScopeBudget({ type: "project", key: "project-1" }, 200_000, "CNY");
    store.setScopeBudget({ type: "episode", key: episodeBudgetKey("project-1", "episode-1") }, 120_000, "CNY");
    store.setScopeBudget({ type: "daily", key: new Date().toISOString().slice(0, 10) }, 500_000, "CNY");
    store.setScopeBudget({ type: "model", key: "mock-ark/seedance-2.5" }, 100_000, "CNY");

    const sameModel = store.createTask({ ...paidInput("model-cap", 90_000), modelId: "seedance-2.5" }).task;
    expect(store.beginSubmission(sameModel.id).status).toBe("warning_90");

    const modelBlocked = store.createTask({ ...paidInput("model-cap-block", 10_001), modelId: "seedance-2.5" }).task;
    expect(store.beginSubmission(modelBlocked.id).status).toBe("budget_exhausted");

    const otherEpisode = store.createTask({ ...paidInput("episode-cap", 30_001), episodeId: "episode-2", modelId: "other-model" }).task;
    expect(store.beginSubmission(otherEpisode.id).status).toBe("started");
    expect(store.getScopeBudgetUsage({ type: "project", key: "project-1" }, "CNY").usedMicros).toBe(120_001);
    expect(store.getScopeBudgetUsage({ type: "episode", key: episodeBudgetKey("project-1", "episode-1") }, "CNY").usedMicros).toBe(90_000);
    db.close();
  });

  it("blocks paid generation when any applicable budget scope is exceeded", () => {
    const { db, store } = fixture();
    store.setScopeBudget({ type: "episode", key: episodeBudgetKey("project-1", "episode-1") }, 80_000, "CNY");
    const task = store.createTask(paidInput("episode-hard-limit", 80_001)).task;
    expect(store.beginSubmission(task.id).status).toBe("budget_exhausted");
    expect(store.getTask(task.id).requestStarted).toBe(false);
    db.close();
  });

  it("creates an explicitly linked clip redo without changing the successful artifact", () => {
    const { db, store } = fixture();
    const original = store.createTask(paidInput("original-clip", 75_000)).task;
    store.beginSubmission(original.id);
    store.registerProviderTask(original.id, "mock-original-clip");
    const originalOutput = { slot: "clip", path: "assets/shot-1-v1.mp4", sha256: "1".repeat(64) };
    store.completeTask(original.id, originalOutput);

    const redo = store.createRedoTask(original.id, "redo-clip-v2", JSON.stringify({ prompt: "revised camera move" }), 80_000);
    const duplicate = store.createRedoTask(original.id, "redo-clip-v2", JSON.stringify({ prompt: "revised camera move" }), 80_000);
    expect(redo.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(redo.task).toMatchObject({ redoneFromTaskId: original.id, shotId: "shot-1", state: "queued" });
    expect(store.getTask(original.id)).toMatchObject({ state: "succeeded", attempt: 1 });
    expect(store.beginSubmission(redo.task.id).status).toBe("started");
    expect(store.beginSubmission(redo.task.id).status).toBe("already_dispatched");
    expect(() => store.createRedoTask(original.id, original.idempotencyKey, "{}", 1)).toThrow("new idempotency key");
    expect(() => store.createRedoTask(redo.task.id, "redo-in-flight", "{}", 1)).toThrow("in-flight");
    db.close();
  });

  it("charges the daily reservation to the dispatch day, including an older queued task", () => {
    const { db, store } = fixture();
    const today = new Date().toISOString().slice(0, 10);
    store.setScopeBudget({ type: "daily", key: today }, 100_000, "CNY");
    const queued = store.createTask(paidInput("queued-yesterday", 90_000)).task;
    db.query("UPDATE generation_task SET created_at = ? WHERE id = ?").run(Date.now() - 86_400_000, queued.id);
    expect(store.beginSubmission(queued.id).status).toBe("warning_90");
    expect(store.getScopeBudgetUsage({ type: "daily", key: today }, "CNY").reservedMicros).toBe(90_000);
    const blocked = store.createTask(paidInput("daily-limit", 10_001)).task;
    expect(store.beginSubmission(blocked.id).status).toBe("budget_exhausted");
    db.close();
  });

  it("recovers by reconciliation and quarantines unknown submissions without resubmitting", () => {
    const { db, store } = fixture();
    const known = store.createTask(paidInput("known-provider-id", 10_000)).task;
    store.beginSubmission(known.id);
    store.registerProviderTask(known.id, "provider-task-known");
    const unknown = store.createTask(paidInput("unknown-provider-id", 10_000)).task;
    store.beginSubmission(unknown.id);

    expect(store.recoverInterrupted()).toEqual({ reconciling: 1, requiresReview: 1 });
    expect(store.getTask(known.id).state).toBe("reconciling");
    expect(store.getTask(unknown.id).state).toBe("reconcile_required");
    expect(store.beginSubmission(unknown.id).status).toBe("already_dispatched");
    expect(store.getTask(unknown.id).attempt).toBe(1);
    db.close();
  });

  it("keeps synthesis available at the paid-generation budget limit", () => {
    const { db, store } = fixture();
    const paid = store.createTask(paidInput("full-budget", 1_000_000)).task;
    store.beginSubmission(paid.id);
    const synth = store.createTask({ ...paidInput("synthesis-export", 0), stage: "synthesis", billable: false }).task;
    expect(store.beginSubmission(synth.id).status).toBe("started");
    expect(store.getBudgetUsage("CNY").usedMicros).toBe(1_000_000);
    db.close();
  });

  it("holds estimated spend until actual charge is settled exactly once", () => {
    const { db, store } = fixture();
    const task = store.createTask(paidInput("settle-cost", 300_000)).task;
    store.beginSubmission(task.id);
    store.registerProviderTask(task.id, "provider-settle");
    store.completeTask(task.id, { slot: "clip", path: "assets/clip.mp4", sha256: "c".repeat(64) });
    expect(store.getBudgetUsage("CNY").usedMicros).toBe(300_000);
    const pricing = { unit: "second", units: 5, unitPriceMicros: 50_000, pricingRef: "ark-seedance-v1" };
    expect(store.settleReservation(task.id, "bill-001", 250_000, "CNY", pricing)).toBe(true);
    expect(store.settleReservation(task.id, "bill-001", 250_000, "CNY", pricing)).toBe(false);
    expect(db.query("SELECT unit, units, unit_price_micros, pricing_ref, status FROM cost_ledger WHERE source_ref = ?")
      .get("bill-001")).toEqual({ unit: "second", units: 5, unit_price_micros: 50_000,
        pricing_ref: "ark-seedance-v1", status: "reconciled" });
    expect(() => store.recordCharge(task.id, "inconsistent-price", 249_999, "CNY", pricing)).toThrow("must equal");
    expect(store.getBudgetUsage("CNY")).toMatchObject({ chargedMicros: 250_000, reservedMicros: 0, usedMicros: 250_000 });
    expect(store.getEpisodeCostBreakdown(task.projectId, task.episodeId)).toEqual([{
      shotId: "shot-1", stage: "video", provider: "mock-ark", modelId: "", currency: "CNY",
      chargedMicros: 250_000, reservedMicros: 0,
    }]);
    expect(() => store.settleReservation(task.id, "bill-001", 260_000, "CNY")).toThrow("reused");
    db.close();
  });

  it("keeps a failed task reserved until no-charge is explicitly confirmed", () => {
    const { db, store } = fixture();
    const task = store.createTask(paidInput("failed-uncertain", 200_000)).task;
    store.beginSubmission(task.id);
    store.failTask(task.id);
    expect(store.getBudgetUsage("CNY").reservedMicros).toBe(200_000);
    store.releaseReservation(task.id, true);
    expect(store.getBudgetUsage("CNY").reservedMicros).toBe(0);
    db.close();
  });

  it("persists provider IDs across process restart and never resubmits recovered work", () => {
    const directory = mkdtempSync(join(tmpdir(), "toonflow-production-recovery-"));
    const databasePath = join(directory, "production.sqlite");
    let db = new Database(databasePath);
    let store = new ProductionStore(db);
    store.setBudget(1_000_000, "CNY");
    const accepted = store.createTask(paidInput("restart-accepted", 20_000)).task;
    store.beginSubmission(accepted.id);
    store.registerProviderTask(accepted.id, "provider-task-accepted");
    const uncertain = store.createTask(paidInput("restart-uncertain", 20_000)).task;
    store.beginSubmission(uncertain.id);
    db.close();

    try {
      db = new Database(databasePath);
      store = new ProductionStore(db);
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.query("SELECT version FROM schema_migration").get()).toEqual({ version: 1 });
      expect(store.recoverInterrupted()).toEqual({ reconciling: 1, requiresReview: 1 });
      expect(store.getTask(accepted.id)).toMatchObject({ state: "reconciling", providerTaskId: "provider-task-accepted", attempt: 1 });
      expect(store.getTask(uncertain.id)).toMatchObject({ state: "reconcile_required", providerTaskId: null, attempt: 1 });
      expect(store.beginSubmission(accepted.id).status).toBe("already_dispatched");
      expect(store.beginSubmission(uncertain.id).status).toBe("already_dispatched");
      expect(store.getTask(accepted.id).attempt + store.getTask(uncertain.id).attempt).toBe(2);
    } finally {
      db.close();
      const tempRoot = resolve(tmpdir()) + sep;
      const resolvedDirectory = resolve(directory);
      if (!resolvedDirectory.startsWith(tempRoot)) throw new Error("Refusing to clean a test path outside the OS temp directory.");
      rmSync(resolvedDirectory, { recursive: true, force: true });
    }
  });

  it("resumes submitted work into reconciliation instead of sending it again", () => {
    const { db, store } = fixture();
    const task = store.createTask(paidInput("pause-after-accept", 50_000)).task;
    store.beginSubmission(task.id);
    store.registerProviderTask(task.id, "provider-task-paused");
    expect(store.pauseTask(task.id).state).toBe("paused");
    expect(store.resumeTask(task.id).state).toBe("reconciling");
    expect(store.beginSubmission(task.id).status).toBe("already_dispatched");
    expect(store.getTask(task.id).attempt).toBe(1);
    db.close();
  });

  it("returns a never-submitted paused task to the queue", () => {
    const { db, store } = fixture();
    const task = store.createTask(paidInput("pause-before-submit", 50_000)).task;
    expect(store.pauseTask(task.id).state).toBe("paused");
    expect(store.resumeTask(task.id).state).toBe("queued");
    expect(store.beginSubmission(task.id).status).toBe("started");
    expect(store.getTask(task.id).attempt).toBe(1);
    db.close();
  });

  it("persists intent before invoking a mock provider and records its accepted task ID", async () => {
    const { db, store } = fixture();
    const task = store.createTask(paidInput("dispatcher-accepted", 10_000)).task;
    let stateSeenAtProviderCall = "";
    const provider: ProviderSubmissionPort = {
      providerId: task.provider,
      async submit(input) {
        stateSeenAtProviderCall = store.getTask(input.id).state;
        return { providerTaskId: "mock-accepted-1" };
      },
    };
    const result = await dispatchTask(store, task.id, provider);
    expect(stateSeenAtProviderCall).toBe("dispatching");
    expect(result.status).toBe("accepted");
    expect(store.getTask(task.id)).toMatchObject({ state: "running", providerTaskId: "mock-accepted-1", attempt: 1 });
    db.close();
  });

  it("quarantines ambiguous provider errors without a second submit", async () => {
    const { db, store } = fixture();
    const task = store.createTask(paidInput("dispatcher-uncertain", 10_000)).task;
    let calls = 0;
    const provider: ProviderSubmissionPort = {
      providerId: task.provider,
      async submit() { calls += 1; throw new Error("connection reset after request body"); },
    };
    const first = await dispatchTask(store, task.id, provider);
    const second = await dispatchTask(store, task.id, provider);
    expect(first.status).toBe("reconcile_required");
    expect(second.status).toBe("already_dispatched");
    expect(calls).toBe(1);
    expect(store.getTask(task.id).attempt).toBe(1);
    db.close();
  });

  it("releases reservations after confirmed image rejection without retrying the paid request", async () => {
    const { db, store } = fixture();
    const task = store.createTask({ ...paidInput("image-rejected", 12_000), stage: "image" }).task;
    store.beginSubmission(task.id);
    store.registerProviderTask(task.id, "mock-image-task");
    const provider: ProviderPollingPort = {
      providerId: task.provider,
      async poll() { return { state: "failed", chargeStatus: "no_charge" }; },
    };
    expect((await reconcileProviderTask(store, task.id, provider)).status).toBe("failed");
    expect(store.getBudgetUsage("CNY").reservedMicros).toBe(0);
    expect(store.getBudgetUsage("CNY").chargedMicros).toBe(0);
    expect(store.beginSubmission(task.id).status).toBe("already_dispatched");
    expect(store.getTask(task.id).attempt).toBe(1);
    db.close();
  });

  it("keeps a successful provider result reserved until its exact charge is reconciled", async () => {
    const { db, store } = fixture();
    const task = store.createTask(paidInput("video-charge-pending", 20_000)).task;
    store.beginSubmission(task.id);
    store.registerProviderTask(task.id, "mock-video-charge-pending");
    const provider: ProviderPollingPort = {
      providerId: task.provider,
      async poll() {
        return { state: "succeeded", remoteUrl: "https://media.example.test/video.mp4",
          destinationPath: "assets/shot-1.mp4", expiresAt: Date.now() + 86_400_000, chargeStatus: "unknown" };
      },
    };
    expect((await reconcileProviderTask(store, task.id, provider)).status).toBe("awaiting_download_charge_reconciliation");
    expect(store.getBudgetUsage("CNY")).toMatchObject({ chargedMicros: 0, reservedMicros: 20_000 });
    db.close();
  });

  it("records video failure charges and keeps timeout tasks in reconciliation", async () => {
    const { db, store } = fixture();
    const failedVideo = store.createTask({ ...paidInput("video-rejected-charged", 20_000), stage: "video" }).task;
    store.beginSubmission(failedVideo.id);
    store.registerProviderTask(failedVideo.id, "mock-video-failed");
    const rejected: ProviderPollingPort = {
      providerId: failedVideo.provider,
      async poll() { return { state: "failed", chargeStatus: "charged", sourceRef: "video-fee-1", amountMicros: 5_000, currency: "CNY" }; },
    };
    expect((await reconcileProviderTask(store, failedVideo.id, rejected)).status).toBe("failed");
    expect(store.getBudgetUsage("CNY")).toMatchObject({ chargedMicros: 5_000, reservedMicros: 0 });

    const timedOut = store.createTask(paidInput("provider-poll-timeout", 20_000)).task;
    store.beginSubmission(timedOut.id);
    store.registerProviderTask(timedOut.id, "mock-video-timeout");
    const offline: ProviderPollingPort = {
      providerId: timedOut.provider,
      async poll() { throw new Error("poll timed out"); },
    };
    expect((await reconcileProviderTask(store, timedOut.id, offline)).status).toBe("reconciling");
    expect(store.getTask(timedOut.id).state).toBe("reconciling");
    expect(store.getBudgetUsage("CNY").reservedMicros).toBe(20_000);
    expect(store.beginSubmission(timedOut.id).status).toBe("already_dispatched");
    expect(store.getTask(timedOut.id).attempt).toBe(1);
    db.close();
  });

  it("retries an interrupted media download before URL expiry without regenerating the shot", async () => {
    const { db, store } = fixture();
    const task = store.createTask(paidInput("download-protection", 30_000)).task;
    store.beginSubmission(task.id);
    store.registerProviderTask(task.id, "mock-video-1");
    const start = 1_800_000_000_000;
    store.enqueueMediaDownload(task.id, "clip", "https://media.example.test/result.mp4",
      "assets/episode-1/shot-1.mp4", start + 24 * 60 * 60_000, start);
    let online = false;
    const requested: Array<[string, string]> = [];
    const downloader: MediaDownloadPort = {
      async download(remoteUrl, destinationPath) {
        requested.push([remoteUrl, destinationPath]);
        if (!online) throw new Error("offline");
        return { sha256: "d".repeat(64) };
      },
    };

    expect(await processPendingMediaDownloads(store, downloader, () => start)).toEqual({
      claimed: 1, downloaded: 0, retrying: 1, expired: 0,
    });
    online = true;
    expect(await processPendingMediaDownloads(store, downloader, () => start + 5 * 60_000)).toEqual({
      claimed: 1, downloaded: 1, retrying: 0, expired: 0,
    });
    expect(requested).toEqual([
      ["https://media.example.test/result.mp4", "assets/episode-1/shot-1.mp4"],
      ["https://media.example.test/result.mp4", "assets/episode-1/shot-1.mp4"],
    ]);
    expect(store.getTask(task.id)).toMatchObject({ state: "succeeded", attempt: 1, providerTaskId: "mock-video-1" });
    expect(store.getBudgetUsage("CNY").reservedMicros).toBe(30_000);
    db.close();
  });

  it("warns before a face reference trust window expires and renews by adding a new asset version", () => {
    const { db, store } = fixture();
    const now = 1_800_000_000_000;
    const oldId = store.addFaceReference({
      characterId: "character-1", assetPath: "assets/characters/hero/original.png",
      sha256: "e".repeat(64), sourceKind: "user_authorized", trustExpiresAt: now + 2 * 24 * 60 * 60_000,
    }, now);
    expect(store.listFaceReferenceStatuses(now, 7 * 24 * 60 * 60_000)[0]).toMatchObject({ id: oldId, trust: "warning" });
    expect(store.listFaceReferenceStatuses(now + 3 * 24 * 60 * 60_000)[0]).toMatchObject({ id: oldId, trust: "expired" });

    const renewedId = store.renewFaceReference(oldId, {
      characterId: "character-1", assetPath: "assets/characters/hero/renewed.png",
      sha256: "f".repeat(64), sourceKind: "user_authorized", trustExpiresAt: now + 30 * 24 * 60 * 60_000,
    }, now);
    expect(renewedId).not.toBe(oldId);
    expect(store.listFaceReferenceStatuses(now)).toEqual([expect.objectContaining({
      id: renewedId, assetPath: "assets/characters/hero/renewed.png", supersedesId: oldId, trust: "valid",
    })]);
    db.close();
  });

  it("retries failed synthesis and exports subtitle/BGM revisions without regenerating clips", async () => {
    const { db, store } = fixture();
    const clips: EpisodeRenderSpec["clips"] = [];
    const clipTasks: string[] = [];
    for (let index = 1; index <= 8; index += 1) {
      const shotId = `shot-${index}`;
      const task = store.createTask({ ...paidInput(`render-clip-${index}`, 10_000), shotId }).task;
      clipTasks.push(task.id);
      store.beginSubmission(task.id);
      store.registerProviderTask(task.id, `mock-render-clip-${index}`);
      const path = `assets/episode-1/${shotId}.mp4`;
      const sha256 = String(index).repeat(64);
      store.completeTask(task.id, { slot: "clip", path, sha256 });
      store.settleReservation(task.id, `bill-render-${index}`, 10_000, "CNY");
      clips.push({ shotId, taskId: task.id, slot: "clip", path, sha256, durationMs: 5_000 });
    }
    const audioTracks: EpisodeRenderSpec["audioTracks"] = [];
    for (const [type, key] of [["dialogue", "dialogue"], ["narration", "narration"]] as const) {
      const task = store.createTask({ ...paidInput(`render-${key}`, 5_000), stage: "speech", shotId: undefined }).task;
      store.beginSubmission(task.id);
      store.registerProviderTask(task.id, `mock-render-${key}`);
      const path = `assets/episode-1/${key}.wav`;
      const sha256 = (key === "dialogue" ? "a" : "b").repeat(64);
      store.completeTask(task.id, { slot: "audio", path, sha256 });
      store.settleReservation(task.id, `bill-${key}`, 5_000, "CNY");
      audioTracks.push({ type, taskId: task.id, slot: "audio", path, sha256, startMs: 0 });
    }
    const baseSpec: EpisodeRenderSpec = {
      projectId: "project-1", episodeId: "episode-1", aspectRatio: "9:16", width: 1080, height: 1920,
      videoCodec: "h264", audioCodec: "aac", clips, audioTracks,
      subtitles: { path: "subtitles/episode-1.srt", sha256: "c".repeat(64), language: "zh-CN" },
      bgm: { path: "audio/local-licensed/bgm-01.wav", sha256: "d".repeat(64), gainDb: -18 },
      outputPath: "exports/episode-1-v1.mp4",
    };
    const chargedBeforeSynthesis = store.getBudgetUsage("CNY").chargedMicros;
    const failedExport = store.createSynthesisTask("synth-v1", baseSpec);
    expect(failedExport.export.version).toBe(1);
    const failingRenderer: SynthesisPort = { async render() { throw new Error("mock ffmpeg failure"); } };
    expect((await runSynthesisTask(store, failedExport.task.id, failingRenderer)).status).toBe("failed");

    const retrySpec = { ...baseSpec, outputPath: "exports/episode-1-v2.mp4" };
    const retryExport = store.createSynthesisTask("synth-v2", retrySpec);
    expect(retryExport.export.version).toBe(2);
    const workingRenderer: SynthesisPort = { async render() { return { sha256: "e".repeat(64) }; } };
    expect((await runSynthesisTask(store, retryExport.task.id, workingRenderer)).status).toBe("succeeded");

    const revisedSpec: EpisodeRenderSpec = {
      ...retrySpec, outputPath: "exports/episode-1-v3.mp4",
      subtitles: { path: "subtitles/episode-1-revised.srt", sha256: "f".repeat(64), language: "zh-CN" },
      bgm: { path: "audio/local-licensed/bgm-02.wav", sha256: "0".repeat(64), gainDb: -22 },
    };
    const revisedExport = store.createSynthesisTask("synth-v3", revisedSpec);
    expect(revisedExport.export.version).toBe(3);
    expect((await runSynthesisTask(store, revisedExport.task.id, workingRenderer)).status).toBe("succeeded");
    expect(store.getBudgetUsage("CNY").chargedMicros).toBe(chargedBeforeSynthesis);
    expect(clipTasks.every((taskId) => store.getTask(taskId).attempt === 1)).toBe(true);
    expect(store.getEpisodeCostBreakdown("project-1", "episode-1").filter((item) => item.chargedMicros > 0))
      .toHaveLength(10);
    expect(store.getSynthesisExport(revisedExport.task.id)?.inputSha256).not.toBe(retryExport.export.inputSha256);
    db.close();
  });
});
