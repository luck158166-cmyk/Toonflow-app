import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { lstat, mkdir, realpath } from "@toonflow/file";
import { ProductionCatalog, ProductionStore } from "@toonflow/production";
import conf from "@/utils/conf";

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

export async function withProduction<T>(workspaceDirectory: string,
  action: (catalog: ProductionCatalog, store: ProductionStore) => Promise<T> | T): Promise<T> {
  const productionDirectory = await prepareDirectory(workspaceDirectory, ".production");
  const globalDirectory = await prepareDirectory(dirname(conf.path), "production");
  const projectPath = resolve(productionDirectory, "production.db");
  const globalPath = resolve(globalDirectory, "global.db");
  await checkDatabaseFile(projectPath);
  await checkDatabaseFile(globalPath);
  const projectDb = new Database(projectPath, { create: true });
  let globalDb: Database | undefined;
  try {
    globalDb = new Database(globalPath, { create: true });
    const store = new ProductionStore(projectDb, globalDb);
    const catalog = new ProductionCatalog(projectDb);
    return await action(catalog, store);
  } finally {
    globalDb?.close();
    projectDb.close();
  }
}
