import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ProductionCatalog } from "../packages/production/src/catalog";
import { assertProductionGenerationGate } from "../apps/server/src/utils/production/generationGate";

async function workspace(run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "toonflow-generation-gate-"));
  try { await run(directory); }
  finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe QA cleanup path.");
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("production generation gate", () => {
  it("allows an ordinary workspace and an empty production catalog", async () => workspace(async directory => {
    await expect(assertProductionGenerationGate(directory)).resolves.toBeUndefined();
    const root = join(directory, ".production");
    mkdirSync(root);
    const db = new Database(join(root, "production.db"));
    new ProductionCatalog(db);
    db.close();
    await expect(assertProductionGenerationGate(directory)).resolves.toBeUndefined();
  }));

  it("blocks legacy generation after a story is imported", async () => workspace(async directory => {
    const root = join(directory, ".production");
    mkdirSync(root);
    const db = new Database(join(root, "production.db"));
    new ProductionCatalog(db).importStory({ title: "预算守卫", sourceKind: "synopsis", sourceText: "不能绕过预算生成视频。" });
    db.close();
    await expect(assertProductionGenerationGate(directory)).rejects.toMatchObject({ status: 409 });
  }));

  it("fails closed when the catalog file is unrecognizable", async () => workspace(async directory => {
    const root = join(directory, ".production");
    mkdirSync(root);
    writeFileSync(join(root, "production.db"), "not sqlite");
    await expect(assertProductionGenerationGate(directory)).rejects.toThrow();
  }));
});
