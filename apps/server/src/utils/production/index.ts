import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { lstat, mkdir, realpath } from "@toonflow/file";
import { ProductionCatalog, ProductionStore, indexNovel } from "@toonflow/production";
export { createProjectBackup } from "./projectBackup";
export async function preserveReferenceImage(directory: string, path: string, sha256: string) {
  return (await import("./referenceImage")).preserveReferenceImage(directory, path, sha256);
}
export async function readPreservedReference(directory: string, reference: { path: string; sha256: string }) {
  return (await import("./referenceImage")).readPreservedReference(directory, reference);
}
export async function createProductionTextProvider(providerId: string, modelId: string, maxOutputTokens: number) {
  return (await import("./textProvider")).createProductionTextProvider(providerId, modelId, maxOutputTokens);
}

async function prepareDirectory(parent: string, name: string) {
  const path = resolve(parent, name);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error("生产数据目录必须是普通文件夹"), { status: 403 });
  return realpath(path);
}

async function checkDatabaseFile(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw Object.assign(new Error("生产数据库必须是普通文件"), { status: 403 });
  }
}

export type ProductionSummary = {
  id: string; title: string; sourceKind: "synopsis" | "novel" | "script"; description: string;
  chapterCount: number; episodeCount: number; characterCount: number; sceneCount: number;
  propCount: number; shotCount: number; updatedAt: number;
};

/** Read existing local production data without creating a database just by listing projects. */
export async function listProductionSummaries(workspaceDirectory: string): Promise<ProductionSummary[]> {
  const folder = resolve(workspaceDirectory, ".production");
  const folderInfo = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!folderInfo) return [];
  if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) {
    throw Object.assign(new Error("生产数据目录必须是普通文件夹"), { status: 403 });
  }
  const path = resolve(folder, "production.db");
  const fileInfo = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!fileInfo) return [];
  await checkDatabaseFile(path);
  const db = new Database(path, { readonly: true });
  try {
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'production_project'").get();
    if (!table) return [];
    const rows = db.query(`SELECT p.id, p.title, p.source_kind AS sourceKind, p.source_text AS sourceText,
      p.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM production_episode e WHERE e.project_id = p.id) AS episodeCount,
      (SELECT COUNT(*) FROM production_asset a WHERE a.project_id = p.id AND a.kind = 'character') AS characterCount,
      (SELECT COUNT(*) FROM production_asset a WHERE a.project_id = p.id AND a.kind = 'prop') AS propCount,
      (SELECT COUNT(*) FROM production_scene s WHERE s.project_id = p.id) AS sceneCount,
      (SELECT COUNT(*) FROM production_shot s WHERE s.project_id = p.id) AS shotCount
      FROM production_project p ORDER BY p.updated_at DESC, p.id DESC`).all() as Array<{
        id: string; title: string; sourceKind: ProductionSummary["sourceKind"]; sourceText: string;
        updatedAt: number; episodeCount: number; characterCount: number; propCount: number;
        sceneCount: number; shotCount: number;
      }>;
    return rows.map(({ sourceText, ...row }) => ({ ...row,
      description: sourceText.replace(/\s+/gu, " ").trim().slice(0, 100),
      chapterCount: row.sourceKind === "novel" ? indexNovel(sourceText).chapters.length : 0 }));
  } finally { db.close(); }
}

const recoveredDataDirectories = new Set<string>();

/** Run once before this process starts workers. In-flight paid submissions are never sent again. */
export async function recoverProductionAfterRestart(dataDirectory: string) {
  const root = await realpath(dataDirectory);
  if (recoveredDataDirectories.has(root)) return null;
  const productionDirectory = resolve(root, "production");
  const folder = await lstat(productionDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!folder) { recoveredDataDirectories.add(root); return null; }
  if (!folder.isDirectory() || folder.isSymbolicLink()) {
    throw Object.assign(new Error("生产数据目录必须是普通文件夹"), { status: 403 });
  }
  const path = resolve(productionDirectory, "global.db");
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) { recoveredDataDirectories.add(root); return null; }
  await checkDatabaseFile(path);
  const db = new Database(path);
  try {
    const store = new ProductionStore(db);
    const tasks = store.recoverInterrupted();
    const downloads = store.recoverInterruptedMediaDownloads();
    recoveredDataDirectories.add(root);
    return { tasks, downloads };
  } finally {
    db.close();
  }
}

export async function withProduction<T>(workspaceDirectory: string,
  action: (catalog: ProductionCatalog, store: ProductionStore) => Promise<T> | T): Promise<T> {
  const { default: conf } = await import("@/utils/conf");
  const productionDirectory = await prepareDirectory(workspaceDirectory, ".production");
  const globalDirectory = await prepareDirectory(dirname(conf.path), "production");
  const projectPath = resolve(productionDirectory, "production.db");
  const globalPath = resolve(globalDirectory, "global.db");
  await checkDatabaseFile(projectPath);
  await checkDatabaseFile(globalPath);
  const projectDb = new Database(projectPath, { create: true });
  let globalDb: Database | undefined;
  try {
    const legacyTasks = projectDb.query(`SELECT 1 AS found FROM sqlite_master
      WHERE type = 'table' AND name = 'generation_task'`).get();
    if (legacyTasks && (projectDb.query("SELECT COUNT(*) AS count FROM generation_task").get() as { count: number }).count > 0) {
      throw Object.assign(new Error("发现旧版项目生产任务；完成显式迁移前不会忽略或覆盖这些任务。"), { status: 409 });
    }
    globalDb = new Database(globalPath, { create: true });
    // ACT: all billable tasks and budget rows share one WAL database, so a
    // reservation, dispatch intent, and charge can commit as one transaction.
    const store = new ProductionStore(globalDb);
    const catalog = new ProductionCatalog(projectDb);
    return await action(catalog, store);
  } finally {
    globalDb?.close();
    projectDb.close();
  }
}
