import { mkdirSync, writeFileSync, readFileSync } from "@toonflow/file";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createShotFixture, bindFixtureImages, scenicDraft } from "./shotPreparationFixture";
import express from "../apps/server/node_modules/express";
import { unzipSync } from "../apps/server/node_modules/fflate";
import { Database } from "bun:sqlite";

const root = process.argv[2]!; const ui = process.argv.includes("--ui");
if (!root) throw new Error("QA requires isolated root");
process.env.TOONFLOW_DATA_DIR = join(root, "data"); process.env.NODE_ENV = "dev";
const directory = join(root, "workspace"); mkdirSync(directory, { recursive: true });
const calls: string[] = []; const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
  const method = init?.method ?? "GET"; calls.push(method + " " + url);
  if (url === "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    if (body.content[1]?.image_url?.url !== "data:image/png;base64," + bytes.toString("base64")) throw new Error("QA reference changed");
    return Response.json({ id: "segmentExecutionQa" });
  }
  if (url.endsWith("/contents/generations/tasks/segmentExecutionQa")) return Response.json({ id: "segmentExecutionQa", model: "doubao-seedance-2-5-260628", status: "succeeded",
    content: { video_url: "https://media.example.test/qa.mp4" }, usage: { total_tokens: 50 } });
  if (url === "https://media.example.test/qa.mp4") return new Response(Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"));
  throw new Error("QA blocked external request: " + url);
}, nativeFetch);
const { default: initializePlugins } = await import("../apps/server/src/utils/plugins/initialize");
await initializePlugins(join(root, "data/providers"), resolve("packages/providers/src/media"), ["volcengine.ts"]);
const { default: u } = await import("../apps/server/src/utils");
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaNeverRealKey" });
const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEkAAAAASUVORK5CYII=", "base64");
const bytes = Buffer.from(await new Bun.Image(tiny).resize(320, 320).png().buffer());
writeFileSync(join(directory, "input.png"), bytes);
const original = await u.production.preserveReferenceImage(directory, "input.png", createHash("sha256").update(bytes).digest("hex"));
const modelId = "doubao-seedance-2-5-260628";
const rule = { provider: "volcengine", modelId, unit: "seedance25NoVideo1080SecondCeiling", unitSize: 1,
  unitPriceMicros: 100, currency: "CNY", sourceUrl: "https://example.test/qa-price", effectiveAt: 1, recordedBy: "qa" };
const fixture = await u.production.withProduction(directory, (catalog, store) => {
  const fixture = createShotFixture(catalog, scenicDraft); bindFixtureImages(catalog, fixture.projectId, original);
  store.setBudget(100000, "CNY"); store.globalBudgets.recordPriceRule(rule); return fixture;
});
const app = express(); app.use(express.json());
for (const name of ["getSegmentPlan", "saveSegmentPlan", "previewSegmentVideo", "reviewSegmentPreflight", "runSegmentVideo", "recoverVideoTask", "readAssetReference"]) {
  app.use("/api/production/" + name, (await import("../apps/server/src/routes/production/" + name + ".ts")).default);
}
app.get("/qa/referenceFixture", async (_req, res) => res.json({ directory, ...fixture,
  episodes: await u.production.withProduction(directory, catalog => catalog.getProjectProduction(fixture.projectId).episodes) }));
app.use("/api/providers/media/list", (await import("../apps/server/src/routes/providers/media/list")).default);
app.use("/api/settings/get", (await import("../apps/server/src/routes/settings/get")).default);
app.use("/api", (_req, res) => res.status(403).json({ message: "QA only" }));
app.use((cause: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(cause.status ?? 500).json({ message: cause.message }));
if (ui) {
  const { createServer } = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const vite = await createServer({ configFile: resolve("apps/web/vite.config.ts"), root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "mpa" });
  app.use(vite.middlewares);
  app.listen(5198, "127.0.0.1", () => console.log("QA http://127.0.0.1:5198/qa/studioPreview.html?stage=segments " + root));
  process.on("SIGINT", () => { void vite.close().finally(() => process.exit(0)); });
} else {
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing QA address");
  const base = "http://127.0.0.1:" + address.port;
  const post = async (name: string, body: object) => { const response = await fetch(base + "/api/production/" + name, { method: "POST",
    headers: { origin: base, "x-toonflow-workspace": "1", "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
  const plan = await u.production.withProduction(directory, catalog => u.production.inspectEpisodeSegmentPlan(directory, catalog, fixture.projectId, fixture.episodeId));
  const input = { directory, projectId: fixture.projectId, episodeId: fixture.episodeId, sequence: 1, inputHash: plan.inputHash };
  const saved = await post("saveSegmentPlan", input);
  const unreviewed = await post("previewSegmentVideo", input);
  const reviewInput = { actionConfirmed: true, continuityConfirmed: true, dialogueConfirmed: true, referencesConfirmed: true, note: "QA 空镜，无人物；原图是测试白色像素，不是生产素材" };
  const reviewed = await post("reviewSegmentPreflight", { ...input, review: reviewInput });
  const first = await post("previewSegmentVideo", input);
  const approvalFor = (preview: any) => ({ approved: true, maxCalls: 1, planHash: preview.body.data.planHash, maxCostMicros: 2000 });
  await u.production.withProduction(directory, (_catalog, store) => store.globalBudgets.recordPriceRule({ ...rule, unitPriceMicros: 110, effectiveAt: Date.now() }));
  const stale = await post("runSegmentVideo", { ...input, approval: approvalFor(first) });
  const current = await post("previewSegmentVideo", input);
  writeFileSync(join(directory, original.path), "QA tampered original");
  const tampered = await post("runSegmentVideo", { ...input, approval: approvalFor(current) });
  writeFileSync(join(directory, original.path), bytes);
  const { withProductionMediaSubmission, assertProductionProviderRevision } = await import("../apps/server/src/utils/production/generationGate");
  const { readReference } = await import("../apps/server/src/utils/media/generation");
  let atReadError = "";
  await withProductionMediaSubmission(directory, "qa-byte-check", async () => {
    writeFileSync(join(directory, original.path), Buffer.concat([bytes, Buffer.from("tamper")]));
    try { await readReference(directory, { path: original.path, mimeType: "image/png" }, "image"); } catch (cause) { atReadError = String(cause); }
    writeFileSync(join(directory, original.path), bytes);
  });
  await u.production.withProduction(directory, (_catalog, store) => store.setBudget(100, "CNY"));
  const budget = await post("runSegmentVideo", { ...input, approval: approvalFor(current) });
  const callsBeforeStart = calls.slice();
  await u.production.withProduction(directory, (_catalog, store) => store.setBudget(100000, "CNY"));
  const results = await Promise.all([post("runSegmentVideo", { ...input, approval: approvalFor(current) }), post("runSegmentVideo", { ...input, approval: approvalFor(current) })]);
  const taskId = results[0]!.body.data?.taskId;
  if (!taskId) throw new Error(JSON.stringify(results));
  try { await u.mediaTasks.wait(directory, taskId); } catch { /* Assert actual state below. */ }
  const repeat = await post("runSegmentVideo", { ...input, approval: approvalFor(current) });
  let revisionError = "";
  await withProductionMediaSubmission(directory, taskId, async () => { try { await assertProductionProviderRevision(directory, "f".repeat(64)); } catch (cause) { revisionError = String(cause); } });
  const state = await u.production.withProduction(directory, (_catalog, store) => ({ task: store.getTask(taskId), tasks: store.listProjectTasks(fixture.projectId), usage: store.getBudgetUsage() }));
  const archive = unzipSync(await u.production.createProjectBackup(directory, join(root, "data")));
  writeFileSync(join(root, "globalBackup.db"), archive["globalProject.db"]!);
  writeFileSync(join(root, "catalogBackup.db"), archive["workspace/.production/production.db"]!);
  const globalBackup = new Database(join(root, "globalBackup.db"), { readonly: true });
  const catalogBackup = new Database(join(root, "catalogBackup.db"), { readonly: true });
  const backup = { binding: globalBackup.query("SELECT task_id AS taskId FROM host_media_binding").all(),
    reviews: catalogBackup.query("SELECT note FROM segment_preflight_review").all(),
    native: JSON.parse(Buffer.from(archive['hostMediaTasks/' + taskId + '.json']!).toString()) };
  globalBackup.close(); catalogBackup.close();
  writeFileSync(join(root, "result.json"), JSON.stringify({ saved, unreviewed, reviewed, first, stale, tampered, atReadError, revisionError, budget, callsBeforeStart, results, repeat, calls, backup, ...state }));
  server.close(); process.exit(0);
}
