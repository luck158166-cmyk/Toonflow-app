import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { lstat, realpath } from "@toonflow/file";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { serializeHostMediaRequest, type HostMediaBinding } from "@toonflow/production";

const submissionContext = new AsyncLocalStorage<{ directory: string; taskId: string }>();

/** Internal capability, never accepted from HTTP body/headers. SQLite authorization is rechecked by each gate. */
export function withProductionMediaSubmission<T>(directory: string, taskId: string, action: () => Promise<T>) {
  return submissionContext.run({ directory, taskId }, action);
}

/** Check the exact bytes passed to the provider, closing the preview-to-read replacement window. */
export function assertProductionReferenceBytes(directory: string, path: string, bytes: Uint8Array) {
  const context = submissionContext.getStore();
  if (!context || context.directory !== directory) return;
  const match = /^assets\/productionReferences\/([a-f0-9]{64})\.(png|jpg|webp)$/.exec(path);
  if (!match || createHash("sha256").update(bytes).digest("hex") !== match[1]) throw new Error("生产参考原图与授权内容不符，已阻止提交");
}

export async function assertProductionProviderRevision(directory: string | undefined, revision: string) {
  const context = submissionContext.getStore();
  if (!context || context.directory !== directory) return;
  const { withProduction } = await import("./index");
  await withProduction(directory, (_catalog, store) => {
    const expected = store.getHostMediaBinding(context.taskId)?.authorization.providerRevision;
    if (expected && expected !== revision) throw new Error("供应商代码已变化，当前授权不能提交");
  });
}

async function existing(path: string) {
  return lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
}

/** Legacy media execution has no production reservation. Keep it away from production workspaces. */
export async function assertProductionGenerationGate(workspaceDirectory: string,
  execution?: { taskId: string; mediaType: HostMediaBinding["mediaType"]; request: unknown }) {
  const directory = await realpath(workspaceDirectory);
  const context = submissionContext.getStore();
  if (context && execution && context.directory === directory && context.taskId === execution.taskId) {
    const { withProduction } = await import("./index");
    await withProduction(directory, (_catalog, store) => {
      const binding = store.assertHostMediaSubmission(execution.taskId, directory, execution.mediaType, serializeHostMediaRequest(execution.request));
      if (!binding.launchClaimed) throw new Error("媒体任务尚未领取唯一提交权");
    });
    return;
  }
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
