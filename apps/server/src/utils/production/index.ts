import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { lstat, mkdir, realpath } from "@toonflow/file";
import { ProductionCatalog, ProductionStore } from "@toonflow/production";
export { createProjectBackup } from "./projectBackup";

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
