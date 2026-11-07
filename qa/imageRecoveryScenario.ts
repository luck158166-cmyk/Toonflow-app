import { mkdirSync, writeFileSync, readFileSync } from "@toonflow/file";
import { join, resolve } from "node:path";
import { createShotFixture } from "./shotPreparationFixture";
import { listReferenceTargets } from "../packages/production/src/assetReference";

const [root, phase] = process.argv.slice(2); if (!root || !phase) throw new Error("QA requires isolated root and phase");
process.env.TOONFLOW_DATA_DIR = join(root, "data"); process.env.NODE_ENV = "dev";
const directory = join(root, "workspace"); mkdirSync(directory, { recursive: true });
const calls: string[] = []; const nativeFetch = globalThis.fetch;
const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEkAAAAASUVORK5CYII=", "base64");
const bytes = Buffer.from(await new Bun.Image(tiny).resize(1024, 1024).png().buffer());
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET"; calls.push(method + " " + url);
  if (url === "https://ark.cn-beijing.volces.com/api/v3/images/generations" && method === "POST") {
    if (phase === "unknown") await finish();
    if (phase !== "downloadExit") throw new Error("Must never regenerate on resume");
    return Response.json({ model: "doubao-seedream-5-0-pro-260628", created: Math.floor(Date.now() / 1000),
      data: [{ url: "https://media.example.test/recovery.png", size: "1024x1024", output_format: "png" }] });
  }
  if (url === "https://media.example.test/recovery.png") {
    if (phase === "downloadExit") await finish();
    if (phase === "expired") return new Response("expired", { status: 403 });
    return new Response(bytes, { headers: { "content-type": "image/png" } });
  }
  throw new Error("QA blocked all external requests: " + url);
}, nativeFetch);
const { default: initializePlugins } = await import("../apps/server/src/utils/plugins/initialize");
await initializePlugins(join(root, "data/providers"), resolve("packages/providers/src/media"), ["volcengine.ts"]);
const { default: u } = await import("../apps/server/src/utils");
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaRecoveryKey" });
let projectId: string;
async function finish(extra: object = {}) {
  const snapshot = await u.production.withProduction(directory, (_catalog, store) => {
    const task = store.listProjectTasks(projectId)[0]!;
    return { task: store.getTask(task.id), usage: store.getBudgetUsage() };
  });
  const record = await u.mediaTasks.inspect(directory, snapshot.task.id);
  writeFileSync(join(root!, `result${phase}.json`), JSON.stringify({ ...snapshot, record, calls, ...extra }));
  process.exit(0);
}
if (["downloadExit", "unknown"].includes(phase)) {
  const input = await u.production.withProduction(directory, (catalog, store) => {
    const fixture = createShotFixture(catalog); projectId = fixture.projectId;
    const target = listReferenceTargets(catalog, projectId).find(item => item.kind === "character")!;
    store.setBudget(100000, "CNY"); store.globalBudgets.recordPriceRule({ provider: "volcengine", modelId: "doubao-seedream-5-0-pro-260628", unit: "seedream5ProSingleImageCeiling", unitSize: 1, unitPriceMicros: 100,
      currency: "CNY", sourceUrl: "https://example.test/qa", effectiveAt: 1, recordedBy: "qa" });
    return { projectId, entityId: target.entityId, entityKind: target.entityKind, role: "headshot" as const, visualStyle: "写实" };
  });
  writeFileSync(join(root, "state.json"), JSON.stringify(input));
  const preview = await u.production.inspectAssetImage(directory, input);
  const run = await u.production.executeAssetImage(directory, input, { approved: true, maxCalls: 1, planHash: preview.planHash, maxCostMicros: 1000 });
  await u.mediaTasks.wait(directory, run.taskId);
  throw new Error("QA should have exited at the selected fault boundary");
} else {
  const input = JSON.parse(readFileSync(join(root, "state.json"), "utf8")); projectId = input.projectId;
  const taskId = await u.production.withProduction(directory, (_catalog, store) => store.listProjectTasks(projectId)[0]!.id);
  await u.production.recoverProductionAssetImage(directory, projectId, taskId);
  try { await u.mediaTasks.wait(directory, taskId); } catch { /* Inspect persisted state instead of replacing the task. */ }
  const recovery = await u.production.recoverProductionAssetImage(directory, projectId, taskId);
  let adopted;
  if (recovery.state === "succeeded") adopted = await u.production.adoptAssetImage(directory, projectId, taskId, true);
  await finish({ recovery, adopted });
}
