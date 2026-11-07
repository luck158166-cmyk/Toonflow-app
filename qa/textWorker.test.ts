import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ProductionStore, type TaskInput } from "../packages/production/src/store";
import { runTextTask } from "../packages/production/src/textWorker";

const input: TaskInput = { idempotencyKey: "draft1", projectId: "story", episodeId: "plannedEpisode1",
  stage: "text", provider: "mock", modelId: "mock", requestJson: '{"source":"chapter"}',
  estimatedCostMicros: 100, currency: "CNY", billable: true };
const output = { responseText: '{"title":"第一集"}', providerRequestId: "response1", usageJson: '{"inputTokens":20,"outputTokens":10}' };

it("blocks text generation without budget, persists one response and keeps unknown costs reserved", async () => {
  const db = new Database(":memory:");
  try {
    const store = new ProductionStore(db);
    const task = store.createTask(input).task;
    let calls = 0;
    const provider = { providerId: "mock", async generate() { calls++; return output; } };
    await expect(runTextTask(store, task.id, provider)).rejects.toThrow("global budget");
    store.setBudget(0, "CNY");
    expect((await runTextTask(store, task.id, provider)).status).toBe("budget_exhausted");
    expect(calls).toBe(0);
    store.setBudget(1000, "CNY");
    expect((await runTextTask(store, task.id, provider)).status).toBe("succeeded");
    expect(store.getBudgetUsage().reservedMicros).toBe(100);
    const reopened = new ProductionStore(db);
    reopened.recoverInterrupted();
    expect((await runTextTask(reopened, task.id, provider)).status).toBe("already_succeeded");
    expect(calls).toBe(1);
    expect(reopened.getTextOutput(task.id)).toMatchObject(output);
    expect(() => reopened.completeTextTask(task.id, { ...output, responseText: "changed" })).toThrow("immutable");
    reopened.settleReservation(task.id, "charge1", 80, "CNY");
    expect(reopened.getBudgetUsage().reservedMicros).toBe(0);
    expect(reopened.getBudgetUsage().chargedMicros).toBe(80);
  } finally { db.close(); }
});

it("does not resubmit an ambiguous text request after recovery", async () => {
  const db = new Database(":memory:");
  try {
    const store = new ProductionStore(db);
    const task = store.createTask({ ...input, billable: false }).task;
    let calls = 0;
    const provider = { providerId: "mock", async generate(): Promise<typeof output> { calls++; throw new Error("response lost"); } };
    expect((await runTextTask(store, task.id, provider)).status).toBe("reconcile_required");
    store.recoverInterrupted();
    expect((await runTextTask(store, task.id, provider)).status).toBe("already_dispatched");
    expect(calls).toBe(1);
    expect(store.getTextOutput(task.id)).toBeNull();
  } finally { db.close(); }
});

it("upgrades the old stage constraint while preserving original rows, references and archive", () => {
  const seed = new Database(":memory:");
  const db = new Database(":memory:");
  try {
    const seedStore = new ProductionStore(seed);
    const previous = seedStore.createTask({ ...input, stage: "video", billable: false }).task;
    const schema = seed.query("SELECT sql FROM sqlite_master WHERE name = 'generation_task'").get() as { sql: string };
    db.exec(schema.sql.replace(",'text'", ""));
    const row = seed.query("SELECT * FROM generation_task WHERE id = ?").get(previous.id) as Record<string, string | number | null>;
    const columns = Object.keys(row);
    db.query(`INSERT INTO generation_task (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
    db.exec("CREATE TABLE taskReceipt(task_id TEXT REFERENCES generation_task(id), receipt TEXT)");
    db.query("INSERT INTO taskReceipt VALUES (?, 'kept')").run(previous.id);
    const store = new ProductionStore(db);
    expect(store.getTask(previous.id)).toEqual(previous);
    expect(db.query("SELECT * FROM generation_task_before_text").get()).toEqual(row);
    const created = store.createTask({ ...input, idempotencyKey: "text2", billable: false }).task;
    db.query("INSERT INTO taskReceipt VALUES (?, 'new')").run(created.id);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(new ProductionStore(db).getTask(created.id).stage).toBe("text");
  } finally { seed.close(); db.close(); }
});

it("rolls back a conflicting migration and restores foreign key enforcement", () => {
  const seed = new Database(":memory:"); const db = new Database(":memory:");
  try {
    new ProductionStore(seed);
    const schema = seed.query("SELECT sql FROM sqlite_master WHERE name = 'generation_task'").get() as { sql: string };
    db.exec(schema.sql.replace(",'text'", ""));
    db.exec("CREATE TABLE generation_task_before_text(note TEXT)");
    expect(() => new ProductionStore(db)).toThrow();
    expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'generation_task'").get()).toEqual({ sql: schema.sql.replace(",'text'", "") });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'generation_task_text_upgrade'").get()).toBeNull();
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
  } finally { seed.close(); db.close(); }
});
