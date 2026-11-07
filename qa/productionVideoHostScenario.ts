import { mkdirSync, writeFileSync, readFileSync } from "@toonflow/file";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { serializeHostMediaRequest } from "../packages/production/src/store";
import express from "../apps/server/node_modules/express";

const [root, phase] = process.argv.slice(2);
if (!root || !phase) throw new Error("QA requires an isolated root and phase");
process.env.TOONFLOW_DATA_DIR = join(root, "data"); process.env.NODE_ENV = "dev";
const directory = join(root, "workspace"); mkdirSync(directory, { recursive: true });
const calls: string[] = []; const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
  const method = init?.method ?? "GET"; calls.push(`${method} ${url}`);
  if (url === "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" && method === "POST") {
    if (phase === "unknown") throw new Error("QA connection lost before receipt");
    if (!["submit", "crash"].includes(phase)) throw new Error("QA forbids resubmission");
    return Response.json({ id: "productionHostQa" });
  }
  if (url.endsWith("/contents/generations/tasks/productionHostQa") && method === "GET") {
    if (phase === "crash") { writeFileSync(join(root, "resultcrash.json"), JSON.stringify({ calls })); process.exit(0); }
    if (phase === "submit") throw new Error("QA network interrupted after receipt");
    return Response.json({ id: "productionHostQa", model: "doubao-seedance-2-5-260628", status: "succeeded",
      content: { video_url: "https://media.example.test/qa.mp4" }, usage: { total_tokens: 31 } });
  }
  if (url === "https://media.example.test/qa.mp4") return new Response(Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"), { headers: { "content-type": "video/mp4" } });
  throw new Error("QA blocked external request: " + url);
}, nativeFetch);
const { default: initializePlugins } = await import("../apps/server/src/utils/plugins/initialize");
await initializePlugins(join(root, "data/providers"), resolve("packages/providers/src/media"), ["volcengine.ts"]);
const { default: u } = await import("../apps/server/src/utils");
const bridge = await import("../apps/server/src/utils/production/videoTasks");
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaNeverRealKey" });
await u.production.recoverProductionAfterRestart(join(root, "data"));
let ids: { projectId: string; episodeId: string; taskId: string };
const request = { providerId: "volcengine", modelId: "doubao-seedance-2-5-260628", prompt: "QA 港口清晨", duration: 5, ratio: "9:16", resolution: "720p", mode: "text" as const };
if (["submit", "crash", "unknown", "missing"].includes(phase)) {
  ids = await u.production.withProduction(directory, (catalog, store) => {
    const projectId = catalog.importStory({ title: "QA 媒体归属", sourceKind: "synopsis", sourceText: "清晨港口。" });
    const episodeId = catalog.createEpisode(projectId, 1, "QA 第一集");
    store.setBudget(10000, "CNY");
    const rule = store.globalBudgets.recordPriceRule({ provider: "volcengine", modelId: request.modelId, unit: "qaOnly", unitSize: 1,
      unitPriceMicros: 100, currency: "CNY", sourceUrl: "https://example.test/qa", effectiveAt: 1, recordedBy: "qa" });
    const requestJson = serializeHostMediaRequest(request);
    // QA seeds the authorized execution boundary directly. It does not mark a real production plan ready.
    const result = store.createHostMediaTask({ idempotencyKey: "qaVideo", projectId, episodeId, stage: "video", provider: "volcengine",
      modelId: request.modelId, requestJson, unit: "qaOnly", quantity: 1 }, { workspace: directory, segmentKey: "QA 方案 1 / 片段 1", mediaType: "video",
      authorization: { approvedRequestHash: createHash("sha256").update(requestJson).digest("hex"), approvedPlanHash: "b".repeat(64),
        priceRuleId: rule.id, maxCalls: 1, maxCostMicros: 100, currency: "CNY" } });
    if (phase === "missing") store.claimHostMediaLaunch(result.task.id, directory, "video", requestJson);
    return { projectId, episodeId, taskId: result.task.id };
  });
  writeFileSync(join(root, "ids.json"), JSON.stringify(ids));
} else ids = JSON.parse(readFileSync(join(root, "ids.json"), "utf8"));
let bypassError = "";
try { await u.mediaTasks.start(directory, randomUUID(), "video", request); } catch (cause) { bypassError = String(cause); }
let result: unknown; let recoveryStatus = 0;
const app = express(); app.use(express.json());
app.use("/recover", (await import("../apps/server/src/routes/production/recoverVideoTask")).default);
app.use((cause: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(cause.status ?? 500).json({ message: cause.message }));
const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing QA address");
const base = `http://127.0.0.1:${address.port}`;
const recover = async (projectId = ids.projectId) => fetch(base + "/recover", { method: "POST",
  headers: { origin: base, "x-toonflow-workspace": "1", "content-type": "application/json" }, body: JSON.stringify({ directory, projectId, taskId: ids.taskId }) });
if (["submit", "crash", "unknown"].includes(phase)) {
  result = await Promise.all([bridge.launchProductionVideoTask(directory, ids.projectId, ids.taskId), bridge.launchProductionVideoTask(directory, ids.projectId, ids.taskId)]);
} else {
  if (phase === "tamper") {
    const record = await u.mediaTasks.inspect(directory, ids.taskId);
    writeFileSync(join(directory, record!.checkpoint.files![0]!.path), "QA changed bytes");
  }
  const response = await recover(); recoveryStatus = response.status; result = await response.json();
}
try { await u.mediaTasks.wait(directory, ids.taskId); } catch { /* The fixture deliberately interrupts some tasks. */ }
if (phase !== "tamper") result = await bridge.syncProductionVideoTask(directory, ids.projectId, ids.taskId);
const wrongScope = await recover(randomUUID());
const state = await u.production.withProduction(directory, (_catalog, store) => ({ task: store.getTask(ids.taskId),
  binding: store.getHostMediaBinding(ids.taskId), usage: store.getBudgetUsage(), listed: store.listProjectTasks(ids.projectId) }));
writeFileSync(join(root, `result${phase}.json`), JSON.stringify({ result, recoveryStatus, bypassError, wrongScopeStatus: wrongScope.status, calls, ...state }, null, 2));
server.close(); process.exit(0);
