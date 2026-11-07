import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ProductionStore } from "../packages/production/src/store";
import { recoverProductionAfterRestart } from "../apps/server/src/utils/production/index";

async function dataDirectory(run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "toonflow-startup-recovery-"));
  try { await run(directory); }
  finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe QA cleanup path.");
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("host production startup recovery", () => {
  it("does not create a production database for an unused installation", async () => dataDirectory(async directory => {
    expect(await recoverProductionAfterRestart(directory)).toBeNull();
  }));

  it("moves interrupted submissions to reconciliation and interrupted downloads to retry", async () => dataDirectory(async directory => {
    const root = join(directory, "production");
    mkdirSync(root);
    const path = join(root, "global.db");
    let db = new Database(path);
    let knownId: string;
    let unknownId: string;
    try {
      const store = new ProductionStore(db);
      store.setBudget(1_000_000, "CNY");
      const input = (key: string) => ({ idempotencyKey: key, projectId: "project-a", episodeId: "episode-a",
        stage: "video" as const, provider: "mock", requestJson: "{}", estimatedCostMicros: 100_000,
        currency: "CNY", billable: true });
      knownId = store.createTaskAndBeginSubmission(input("known")).task.id;
      store.registerProviderTask(knownId, "remote-known");
      unknownId = store.createTaskAndBeginSubmission(input("unknown")).task.id;
      store.enqueueMediaDownload(knownId, "primary", "https://media.example.test/clip", "assets/clip.mp4", Date.now() + 86_400_000);
      expect(store.claimDueMediaDownloads()).toHaveLength(1);
    } finally { db.close(); }

    expect(await recoverProductionAfterRestart(directory)).toEqual({
      tasks: { reconciling: 1, requiresReview: 1 }, downloads: { recovered: 1, expired: 0 },
    });
    db = new Database(path);
    try {
      const store = new ProductionStore(db);
      expect(store.getTask(knownId!).state).toBe("reconciling");
      expect(store.getTask(unknownId!).state).toBe("reconcile_required");
      expect(store.beginSubmission(unknownId!).status).toBe("already_dispatched");
      expect(store.getTask(unknownId!).attempt).toBe(1);
      expect(store.claimDueMediaDownloads()).toHaveLength(1);
      expect(store.getBudgetUsage("CNY").reservedMicros).toBe(200_000);
    } finally { db.close(); }
    expect(await recoverProductionAfterRestart(directory)).toBeNull();
  }));

  it("rejects an unreadable global database instead of starting without task recovery", async () => dataDirectory(async directory => {
    const root = join(directory, "production");
    mkdirSync(root);
    writeFileSync(join(root, "global.db"), "broken");
    await expect(recoverProductionAfterRestart(directory)).rejects.toThrow();
  }));
});
