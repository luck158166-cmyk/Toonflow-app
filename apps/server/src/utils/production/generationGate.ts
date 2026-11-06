import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { lstat, realpath } from "@toonflow/file";

async function existing(path: string) {
  return lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
}

/** Legacy media execution has no production reservation. Keep it away from production workspaces. */
export async function assertProductionGenerationGate(workspaceDirectory: string) {
  const directory = await realpath(workspaceDirectory);
  const productionDirectory = resolve(directory, ".production");
  const folder = await existing(productionDirectory);
  if (!folder) return;
  if (!folder.isDirectory() || folder.isSymbolicLink()) {
    throw Object.assign(new Error("生产数据目录必须是普通文件夹"), { status: 403 });
  }
  const path = resolve(productionDirectory, "production.db");
  const info = await existing(path);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw Object.assign(new Error("生产数据库必须是普通文件"), { status: 403 });
  }
  const db = new Database(path, { readonly: true });
  try {
    const table = db.query("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'production_project'").get();
    if (!table) throw Object.assign(new Error("生产数据库结构无法识别，已阻止媒体生成"), { status: 409 });
    const productionProject = db.query("SELECT 1 AS found FROM production_project LIMIT 1").get();
    if (productionProject) {
      throw Object.assign(new Error("此工作区包含短剧生产项目；媒体生成须先接入生产预算与任务事务"), { status: 409 });
    }
  } finally {
    db.close();
  }
}
