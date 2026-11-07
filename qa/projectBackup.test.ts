import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "@toonflow/file";
import { unzipSync } from "fflate";
import { ProductionCatalog, ProductionStore, getEpisodeReview, reviewEpisode } from "../packages/production/src";
import { createProjectBackup } from "../apps/server/src/utils/production/projectBackup";

it("backs up WAL catalog and only this workspace's global tasks, charges and reference assets", async () => {
  const root = mkdtempSync(join(tmpdir(), "toonflowProjectBackupQa"));
  const workspace = join(root, "workspaceOne");
  const projectDirectory = join(workspace, ".production");
  const globalDirectory = join(root, "production");
  mkdirSync(projectDirectory, { recursive: true });
  mkdirSync(globalDirectory, { recursive: true });
  mkdirSync(join(workspace, "assets"), { recursive: true });
  writeFileSync(join(workspace, "assets", "reference.png"), "original reference bytes");
  const catalog = new Database(join(projectDirectory, "production.db"), { create: true });
  const global = new Database(join(globalDirectory, "global.db"), { create: true });
  try {
    catalog.exec("PRAGMA journal_mode = WAL");
    const domain = new ProductionCatalog(catalog);
    const projectId = domain.importStory({ title: "灯塔故事", sourceKind: "novel", sourceText: "林澄和沈舟寻找灯塔。" });
    const episodeId = domain.createEpisode(projectId, 1, "第一集");
    const reviewHash = getEpisodeReview(domain, projectId, episodeId).snapshotHash;
    reviewEpisode(domain, { projectId, episodeId, snapshotHash: reviewHash,
      decision: "changes_requested", note: "需要补全剧本与分镜" });
    const characterId = domain.upsertAsset({ projectId, kind: "character", name: "林澄", evidence: ["她抵达灯塔"] });
    const otherProjectId = crypto.randomUUID();
    const store = new ProductionStore(global);
    store.setBudget(1_000_000, "CNY");
    store.setScopeBudget({ type: "project", key: projectId }, 600_000, "CNY");
    const input = { episodeId, shotId: "shot-a", stage: "video" as const,
      provider: "mock-ark", requestJson: JSON.stringify({ prompt: "lighthouse" }), currency: "CNY",
      billable: true };
    const own = store.createTask({ ...input, idempotencyKey: "backup-own", projectId, estimatedCostMicros: 200_000 }).task;
    store.beginSubmission(own.id);
    store.settleReservation(own.id, "own-charge", 150_000, "CNY");
    const other = store.createTask({ ...input, idempotencyKey: "backup-other", projectId: otherProjectId,
      estimatedCostMicros: 100_000 }).task;
    store.beginSubmission(other.id);
    store.settleReservation(other.id, "other-charge", 90_000, "CNY");
    store.addFaceReference({ characterId, assetPath: "assets/reference.png", sha256: "a".repeat(64), sourceKind: "user_authorized" });
    const price = store.globalBudgets.recordPriceRule({ provider: "mock-text", modelId: "mock", unit: "textTokenCeiling", unitSize: 1,
      unitPriceMicros: 1, currency: "CNY", sourceUrl: "https://example.test/price", effectiveAt: 1, recordedBy: "qa" });
    const authorization = { approvedRequestHash: createHash("sha256").update("{}").digest("hex"), approvedPlanHash: "b".repeat(64),
      priceRuleId: price.id, maxCalls: 1 as const, maxCostMicros: 100, currency: "CNY" as const, maxOutputTokens: 50,
      destination: "https://example.test/model", contextWindow: 100, maxOutputTokensLimit: 50 };
    const textTask = store.createPricedTaskAndBeginSubmission({ idempotencyKey: "backup-text", projectId, episodeId,
      stage: "text", provider: "mock-text", modelId: "mock", requestJson: "{}", unit: "textTokenCeiling", quantity: 100 }, authorization).task;
    store.completeTextTask(textTask.id, { responseText: "saved text", providerRequestId: "qa-response", usageJson: "{}" });

    const archive = unzipSync(await createProjectBackup(workspace, root));
    const manifest = JSON.parse(Buffer.from(archive["manifest.json"]!).toString()) as {
      projectIds: string[]; files: Array<{ path: string; sha256: string; bytes: number }> };
    expect(manifest.projectIds).toEqual([projectId]);
    for (const entry of manifest.files) {
      const bytes = archive[entry.path];
      expect(bytes?.byteLength).toBe(entry.bytes);
      expect(createHash("sha256").update(bytes!).digest("hex")).toBe(entry.sha256);
    }
    expect(Buffer.from(archive["workspace/assets/reference.png"]!).toString()).toBe("original reference bytes");
    expect(archive["workspace/.production/production.db-wal"]).toBeUndefined();
    const catalogCopy = new Database(archive["workspace/.production/production.db"]!);
    expect(catalogCopy.query("SELECT decision, note, snapshot_hash FROM episode_review WHERE episode_id = ?").get(episodeId))
      .toEqual({ decision: "changes_requested", note: "需要补全剧本与分镜", snapshot_hash: reviewHash });
    const globalCopy = new Database(archive["globalProject.db"]!);
    try {
      expect((catalogCopy.query("SELECT source_text FROM production_project").get() as { source_text: string }).source_text)
        .toContain("林澄和沈舟");
      expect((globalCopy.query("SELECT COUNT(*) AS count FROM generation_task").get() as { count: number }).count).toBe(2);
      const authorizationCopy = globalCopy.query("SELECT authorization_json AS value FROM text_task_authorization WHERE task_id = ?").get(textTask.id) as { value: string };
      expect(JSON.parse(authorizationCopy.value)).toEqual(authorization);
      expect(globalCopy.query("SELECT response_text FROM text_output WHERE task_id = ?").get(textTask.id)).toEqual({ response_text: "saved text" });
      expect(globalCopy.query("SELECT price_rule_id FROM task_price_snapshot WHERE task_id = ?").get(textTask.id)).toEqual({ price_rule_id: price.id });
      expect((globalCopy.query("SELECT source_ref FROM cost_ledger").get() as { source_ref: string }).source_ref).toBe("own-charge");
      expect((globalCopy.query("SELECT source_ref FROM global_cost_ledger").get() as { source_ref: string }).source_ref).toBe("own-charge");
      expect((globalCopy.query("SELECT COUNT(*) AS count FROM face_reference").get() as { count: number }).count).toBe(1);
      expect((globalCopy.query("SELECT COUNT(*) AS count FROM global_budget_rule WHERE scope_type = 'project'").get() as { count: number }).count).toBe(1);
      expect((globalCopy.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    } finally { globalCopy.close(); catalogCopy.close(); }
  } finally {
    global.close();
    catalog.close();
    rmSync(root, { recursive: true, force: true });
  }
});
