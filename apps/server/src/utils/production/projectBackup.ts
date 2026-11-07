import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm } from "@toonflow/file";
import { zip } from "fflate";
import { ProductionStore, episodeBudgetKey } from "@toonflow/production";

const maxBytes = 1024 * 1024 * 1024;
const maxEntries = 10000;

async function ordinaryFile(path: string) {
  const info = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw Object.assign(new Error("生产数据库必须是普通文件"), { status: 403 });
  return info;
}

async function ordinaryDirectory(path: string) {
  const info = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw Object.assign(new Error("生产数据目录必须是普通文件夹"), { status: 403 });
  }
  return info;
}

function copyTable(source: Database, target: Database, table: string, where: string, args: string[] = []) {
  const columns = (target.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
  const rows = source.query(`SELECT ${columns.join(", ")} FROM ${table} ${where}`)
    .all(...args) as Array<Record<string, string | number | null>>;
  const insert = target.query(`INSERT OR IGNORE INTO ${table} (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})`);
  for (const row of rows) insert.run(...columns.map(column => row[column] ?? null));
}

function snapshotProjectGlobal(sourcePath: string, destinationPath: string, projectIds: string[], characterIds: string[], episodeIds: Array<{ projectId: string; id: string }>) {
  const target = new Database(destinationPath, { create: true });
  let source: Database | undefined;
  try {
    new ProductionStore(target);
    if (projectIds.length === 0) return;
    source = new Database(sourcePath, { readonly: true });
    source.exec("BEGIN");
    target.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      for (const projectId of projectIds) {
        copyTable(source, target, "price_rule", `WHERE id IN (SELECT price_rule_id FROM task_price_snapshot
          JOIN generation_task ON generation_task.id = task_price_snapshot.task_id WHERE generation_task.project_id = ?)`, [projectId]);
        copyTable(source, target, "generation_task", "WHERE project_id = ?", [projectId]);
        for (const table of ["task_price_snapshot", "task_reservation", "cost_ledger", "media_output", "media_download"]) {
          copyTable(source, target, table, `WHERE task_id IN (SELECT id FROM generation_task WHERE project_id = ?)`, [projectId]);
        }
        for (const table of ["synthesis_version", "synthesis_export", "global_task_reservation", "global_cost_ledger"]) {
          copyTable(source, target, table, "WHERE project_id = ?", [projectId]);
        }
        copyTable(source, target, "budget_rule", "WHERE scope_type = 'project' AND scope_key = ?", [projectId]);
        copyTable(source, target, "global_budget_rule", "WHERE scope_type = 'project' AND scope_key = ?", [projectId]);
        copyTable(source, target, "global_budget_change", "WHERE scope_type = 'project' AND scope_key = ?", [projectId]);
      }
      for (const { projectId, id } of episodeIds) {
        copyTable(source, target, "budget_rule", "WHERE scope_type = 'episode' AND scope_key = ?", [episodeBudgetKey(projectId, id)]);
      }
      for (const characterId of characterIds) copyTable(source, target, "face_reference", "WHERE character_id = ?", [characterId]);
      target.exec("COMMIT");
      source.exec("COMMIT");
    } catch (cause) {
      target.exec("ROLLBACK");
      source.exec("ROLLBACK");
      throw cause;
    }
    target.exec("PRAGMA foreign_keys = ON");
    if (target.query("PRAGMA foreign_key_check").all().length) throw new Error("项目备份中的全局任务引用不完整");
    if ((target.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok") {
      throw new Error("项目备份中的全局数据库校验失败");
    }
    target.query("PRAGMA journal_mode = DELETE").get();
  } finally { source?.close(); target.close(); }
}

/** Local project archive: workspace files, a WAL-safe catalog snapshot, and only this workspace's global production rows. */
export async function createProjectBackup(directory: string, dataDirectory: string) {
  const projectPath = resolve(directory, ".production", "production.db");
  if (!(await ordinaryDirectory(dirname(projectPath)))) throw Object.assign(new Error("当前工作区没有生产数据库"), { status: 404 });
  if (!(await ordinaryFile(projectPath))) throw Object.assign(new Error("当前工作区没有生产数据库"), { status: 404 });
  const globalPath = resolve(dataDirectory, "production", "global.db");
  await ordinaryDirectory(dirname(globalPath));
  const hasGlobal = !!(await ordinaryFile(globalPath));
  const temporary = await mkdtemp(join(tmpdir(), "toonflowProjectBackup"));
  try {
    const catalogPath = join(temporary, "catalog.db");
    const source = new Database(projectPath, { readonly: true });
    let projectIds: string[];
    let characterIds: string[];
    let episodeIds: Array<{ projectId: string; id: string }>;
    try {
      source.query("VACUUM INTO ?").run(catalogPath);
    } finally { source.close(); }
    const catalog = new Database(catalogPath, { readonly: true });
    try {
      if ((catalog.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok") {
        throw new Error("项目数据库快照校验失败");
      }
      projectIds = (catalog.query("SELECT id FROM production_project").all() as Array<{ id: string }>).map(row => row.id);
      characterIds = (catalog.query("SELECT id FROM production_asset WHERE kind = 'character'").all() as Array<{ id: string }>).map(row => row.id);
      episodeIds = catalog.query("SELECT project_id AS projectId, id FROM production_episode").all() as Array<{ projectId: string; id: string }>;
    } finally { catalog.close(); }
    const globalSnapshotPath = join(temporary, "globalProject.db");
    if (hasGlobal) snapshotProjectGlobal(globalPath, globalSnapshotPath, projectIds, characterIds, episodeIds);
    else {
      const empty = new Database(globalSnapshotPath, { create: true });
      new ProductionStore(empty);
      empty.query("PRAGMA journal_mode = DELETE").get();
      empty.close();
    }

    const files: Record<string, Uint8Array> = Object.create(null);
    let entries = 0;
    let totalBytes = 0;
    async function addFile(name: string, bytes: Uint8Array) {
      if (++entries > maxEntries || totalBytes + bytes.byteLength > maxBytes) {
        throw Object.assign(new Error("项目备份超过 10000 项或 1 GB 限制"), { status: 413 });
      }
      totalBytes += bytes.byteLength;
      files[name] = bytes;
    }
    async function collect(path: string, prefix = "") {
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (/[\\:]/.test(child.name)) throw Object.assign(new Error("项目包含无法安全打包的文件名"), { status: 400 });
        const filePath = join(path, child.name);
        const name = prefix ? `${prefix}/${child.name}` : child.name;
        if ([".production/production.db", ".production/production.db-wal", ".production/production.db-shm"].includes(name)) continue;
        const info = await lstat(filePath);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
          throw Object.assign(new Error("项目不能包含符号链接或特殊文件"), { status: 400 });
        }
        const actual = await realpath(filePath);
        const offset = relative(directory, actual);
        if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
          throw Object.assign(new Error("项目文件超出工作区范围"), { status: 403 });
        }
        if (info.isDirectory()) { await addFile(`workspace/${name}/`, new Uint8Array()); await collect(actual, name); continue; }
        const file = await open(actual, "r");
        try {
          const current = await file.stat();
          if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) {
            throw Object.assign(new Error("项目文件在备份期间发生变化，请重试"), { status: 409 });
          }
          await addFile(`workspace/${name}`, await file.readFile());
        } finally { await file.close(); }
      }
    }
    await collect(directory);
    await addFile("workspace/.production/production.db", await readFile(catalogPath));
    await addFile("globalProject.db", await readFile(globalSnapshotPath));
    const manifest = { format: "toonflowProjectBackup", version: 1, createdAt: Date.now(),
      projectIds, files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex") })) };
    await addFile("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    const archive = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 1 }, (cause, bytes) =>
      cause ? reject(cause) : resolve(bytes)));
    if (archive.byteLength > maxBytes) throw Object.assign(new Error("项目备份 ZIP 超过 1 GB 限制"), { status: 413 });
    return archive;
  } finally {
    if (dirname(await realpath(temporary)) !== await realpath(tmpdir())) throw new Error("拒绝清理备份暂存目录以外的路径");
    await rm(temporary, { recursive: true, force: true });
  }
}
